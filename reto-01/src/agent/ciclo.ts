/**
 * Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
 * No sabe de HTTP ni de un proveedor concreto: recibe un `ProveedorLLM` y emite eventos.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { ErrorLLM, type Mensaje, type ProveedorLLM } from "../llm/adapter.ts"
import { definiciones, interpretar, invocar } from "../tools/registro.ts"
import { ACCIONES_EXTERNAS, aplicarConfirmacion, esConfirmacionExplicita, HERRAMIENTA_PREGUNTA } from "./confirmacion.ts"
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

/** El log global conserva los argumentos simples; los objetos anidados (p. ej. el mapeo con valores) se omiten. */
function sinValores(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "object" && v !== null ? "[omitido]" : v]))
}

async function registrarGlobal(directorio: string, sessionId: string, llamada: LlamadaVisible): Promise<void> {
  try {
    await fs.mkdir(path.join(directorio, "out"), { recursive: true })
    const linea = { ts: new Date().toISOString(), sessionId, herramienta: llamada.nombre, args: sinValores(llamada.args), ok: llamada.ok, resumen: llamada.resumen, ms: llamada.ms }
    await fs.appendFile(path.join(directorio, "out", "log.jsonl"), JSON.stringify(linea) + "\n")
  } catch {
    // CA4 es best-effort en disco; el historial del chat ya lo conserva.
  }
}

interface EstadoTurno {
  autorizada: Pendiente | undefined
  pendiente: Pendiente | undefined
  llamadas: LlamadaVisible[]
}

async function ejecutarLlamada(sesion: Sesion, o: OpcionesCiclo, estado: EstadoTurno, id: string, nombre: string, argsModelo: unknown): Promise<string> {
  const control = aplicarConfirmacion(nombre, argsModelo, estado.autorizada)
  const inicio = Date.now()
  let contenido = await invocar(nombre, control.args, { directory: o.directorio, sessionId: sesion.id })
  const resultado = interpretar(contenido)

  if (control.bloqueada) {
    contenido = JSON.stringify({ ok: false, error: `${resultado.error ?? "requiere confirmación explícita"}: pregunta al usuario y espera su respuesta` })
  }
  if (control.pendiente && !resultado.ok) estado.pendiente = control.pendiente
  if (nombre === HERRAMIENTA_PREGUNTA && resultado.ok) {
    const d = resultado.data as { accion: string; caso: string }
    estado.pendiente = { accion: d.accion, caso: d.caso }
  }
  // La autorización es de un solo uso: se consume con la primera acción externa exitosa.
  if (nombre in ACCIONES_EXTERNAS && resultado.ok) estado.autorizada = undefined

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
  await registrarGlobal(o.directorio, sesion.id, llamada)
  return contenido
}

function cerrar(sesion: Sesion, o: OpcionesCiclo, estado: EstadoTurno, texto: string, esError = false): ResultadoTurno {
  sesion.pendiente = estado.pendiente
  const needsConfirmation = estado.pendiente !== undefined && !esError
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
    autorizada: sesion.pendiente && esConfirmacionExplicita(mensaje) ? sesion.pendiente : undefined,
    pendiente: undefined,
    llamadas: [],
  }
  sesion.pendiente = undefined // una confirmación pendiente solo vale para el mensaje inmediatamente siguiente

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
