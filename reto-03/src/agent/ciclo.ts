/**
 * Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
 * No sabe de HTTP ni de un proveedor concreto: recibe un `ProveedorLLM` y emite eventos.
 */
import { ErrorLLM, type Mensaje, type ProveedorLLM } from "../llm/adapter.ts"
import { definiciones, interpretar, invocar } from "../tools/registro.ts"
import { ACCIONES_CONFIRMABLES, aplicarConfirmacion, esConfirmacionExplicita, HERRAMIENTA_PREGUNTA, mismaPendiente } from "./confirmacion.ts"
import type { EntradaHistorial, LlamadaVisible, Pendiente, Sesion } from "./sesiones.ts"

export interface OpcionesCiclo {
  llm: ProveedorLLM
  sistema: string
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
  emitir?: (evento: EntradaHistorial) => void
}

export interface ResultadoTurno {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  tokensSesion: number
}

function resumir(data: unknown): string {
  if (typeof data !== "object" || data === null) return String(data)
  const partes = Object.entries(data as Record<string, unknown>).flatMap(([clave, valor]) => {
    if (Array.isArray(valor)) return [`${clave}: ${valor.length}`]
    if (typeof valor === "object" && valor !== null) return []
    return valor === null || valor === "" ? [] : [`${clave}: ${String(valor)}`]
  })
  return partes.join(" · ").slice(0, 240)
}

interface EstadoTurno {
  autorizadas: Pendiente[]
  pendientes: Pendiente[]
  llamadas: LlamadaVisible[]
}

function pedirConfirmacion(estado: EstadoTurno, pendiente: Pendiente): void {
  if (!estado.pendientes.some((p) => mismaPendiente(p, pendiente))) estado.pendientes.push(pendiente)
}

async function ejecutarLlamada(sesion: Sesion, o: OpcionesCiclo, estado: EstadoTurno, id: string, nombre: string, argsModelo: unknown): Promise<string> {
  const control = aplicarConfirmacion(nombre, argsModelo, estado.autorizadas)
  const inicio = Date.now()
  let contenido = await invocar(nombre, control.args, { directory: o.directorio, sessionId: sesion.id })
  const resultado = interpretar(contenido)
  const regla = ACCIONES_CONFIRMABLES[nombre]

  if (regla && control.objetivo && !resultado.ok && regla.errorQuePideConfirmacion.test(resultado.error ?? "")) {
    pedirConfirmacion(estado, control.objetivo)
    contenido = JSON.stringify({ ok: false, error: `${resultado.error}. Muestra a la analista cada punto por confirmar y espera su respuesta; no reintentes en este turno` })
  }
  if (nombre === HERRAMIENTA_PREGUNTA && resultado.ok) {
    const d = resultado.data as { accion: string; clave: string }
    pedirConfirmacion(estado, { accion: d.accion, clave: d.clave })
  }
  // La autorización es de un solo uso: se consume cuando la acción confirmada se ejecuta.
  if (regla && control.objetivo && resultado.ok) {
    const usada = control.objetivo
    estado.autorizadas = estado.autorizadas.filter((a) => !mismaPendiente(a, usada))
  }

  const llamada: LlamadaVisible = {
    id,
    nombre,
    args: control.args,
    ok: Boolean(resultado.ok),
    resumen: resultado.ok ? resumir(resultado.data) : (resultado.error ?? "error"),
    resultado: contenido.slice(0, 6000),
    ms: Date.now() - inicio,
  }
  estado.llamadas.push(llamada)
  const entrada: EntradaHistorial = { tipo: "herramienta", ts: new Date().toISOString(), llamada }
  sesion.historial.push(entrada)
  o.emitir?.(entrada)
  return contenido
}

function cerrar(sesion: Sesion, o: OpcionesCiclo, estado: EstadoTurno, texto: string, esError = false): ResultadoTurno {
  sesion.pendientes = estado.pendientes
  const needsConfirmation = estado.pendientes.length > 0 && !esError
  const entrada: EntradaHistorial = esError
    ? { tipo: "error", ts: new Date().toISOString(), texto }
    : { tipo: "asistente", ts: new Date().toISOString(), texto, needsConfirmation }
  sesion.historial.push(entrada)
  o.emitir?.(entrada)
  return { reply: texto, toolCalls: estado.llamadas, needsConfirmation, tokensSesion: sesion.tokens }
}

function textoTope(estado: EstadoTurno, max: number): string {
  const hechas = estado.llamadas.map((l) => `- ${l.nombre}: ${l.ok ? "ok" : "falló"} (${l.resumen})`).join("\n")
  return `Alcancé el tope de ${max} iteraciones en este turno y me detuve.\n\nLo que alcancé a hacer:\n${hechas || "- nada"}\n\nLo que falta: revisar el resultado anterior y pedirme el siguiente paso de forma puntual.`
}

export async function ejecutarTurno(sesion: Sesion, mensaje: string, o: OpcionesCiclo): Promise<ResultadoTurno> {
  const entradaUsuario: EntradaHistorial = { tipo: "usuario", ts: new Date().toISOString(), texto: mensaje }
  sesion.historial.push(entradaUsuario)
  const estado: EstadoTurno = {
    autorizadas: esConfirmacionExplicita(mensaje) ? sesion.pendientes : [],
    pendientes: [],
    llamadas: [],
  }
  sesion.pendientes = [] // una confirmación pendiente solo vale para el mensaje inmediatamente siguiente

  if (sesion.tokens >= o.maxTokensSesion) {
    return cerrar(sesion, o, estado, "Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar; los archivos generados siguen en out/.", true)
  }
  sesion.mensajes.push({ rol: "usuario", texto: mensaje })
  const sistema: Mensaje = { rol: "sistema", texto: o.sistema }

  for (let i = 0; i < o.maxIteraciones; i++) {
    let respuesta
    try {
      respuesta = await o.llm.enviar([sistema, ...sesion.mensajes], definiciones())
    } catch (e) {
      const motivo = e instanceof ErrorLLM ? e.message : "ocurrió un error inesperado al consultar el modelo"
      const texto = `No pude completar el turno: ${motivo}. La sesión sigue activa; puedes reintentar.`
      sesion.mensajes.push({ rol: "asistente", texto, llamadas: [] })
      return cerrar(sesion, o, estado, texto, true)
    }
    sesion.tokens += respuesta.uso.entrada + respuesta.uso.salida
    sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas })
    if (respuesta.llamadas.length === 0) return cerrar(sesion, o, estado, respuesta.texto || "(el modelo no devolvió texto)")

    const resultados = []
    for (const l of respuesta.llamadas) {
      resultados.push({ id: l.id, nombre: l.nombre, contenido: await ejecutarLlamada(sesion, o, estado, l.id, l.nombre, l.args) })
    }
    sesion.mensajes.push({ rol: "herramienta", resultados })
    if (sesion.tokens >= o.maxTokensSesion) break
  }
  const texto = textoTope(estado, o.maxIteraciones)
  sesion.mensajes.push({ rol: "asistente", texto, llamadas: [] })
  return cerrar(sesion, o, estado, texto)
}
