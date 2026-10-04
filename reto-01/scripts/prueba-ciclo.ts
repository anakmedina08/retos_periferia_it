/**
 * Prueba del ciclo del agente con un modelo guionizado (sin clave, sin red).
 * Verifica lo que no depende del modelo: la confirmación humana la aplica el backend.
 *   npm run prueba
 */
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ejecutarTurno, type OpcionesCiclo } from "../src/agent/ciclo.ts"
import { obtenerSesion } from "../src/agent/sesiones.ts"
import type { LlamadaHerramienta, Mensaje, ProveedorLLM } from "../src/llm/adapter.ts"

const directorio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const caso = "ec-corp-andina"
let n = 0
const llamada = (nombre: string, args: unknown): LlamadaHerramienta => ({ id: `t${++n}`, nombre: `proveedor_${nombre}`, args })

/** Modelo falso: responde con la lista de pasos que se le entregue, uno por llamada. */
function guion(pasos: (LlamadaHerramienta[] | string)[]): ProveedorLLM {
  return {
    proveedor: "guion",
    modelo: "sin-modelo",
    async enviar(_m: Mensaje[]) {
      const paso = pasos.shift() ?? "fin"
      const uso = { entrada: 100, salida: 20 }
      return typeof paso === "string" ? { texto: paso, llamadas: [], uso } : { texto: "", llamadas: paso, uso }
    },
  }
}

const base = (llm: ProveedorLLM): OpcionesCiclo => ({ llm, sistema: "prueba", directorio, maxIteraciones: 25, maxTokensSesion: 1_000_000 })
const envio = path.join(directorio, "out", caso, "ENVIO-SIMULADO.md")
const existe = (r: string) => fs.access(r).then(() => true, () => false)

await fs.rm(path.join(directorio, "out", caso), { recursive: true, force: true })
const sesion = obtenerSesion("prueba-ciclo")

// 1. Un modelo desobediente intenta enviar sin que nadie haya confirmado: el backend lo bloquea.
let r = await ejecutarTurno(sesion, `Procesa el caso ${caso} y envíalo`, base(guion([
  [llamada("leer_solicitud", { caso })],
  [llamada("generar_formulario", { caso })],
  [llamada("armar_paquete", { caso })],
  [llamada("simular_envio", { caso, confirmado: true })],
  "¿Confirmas el envío simulado?",
])))
assert.equal(r.toolCalls.at(-1)?.ok, false, "el envío sin confirmación debe fallar")
assert.equal(r.needsConfirmation, true, "el turno debe cerrar pidiendo confirmación")
assert.equal(await existe(envio), false, "no debe existir ENVIO-SIMULADO.md")

// 2. El usuario responde otra cosa: la confirmación pendiente caduca y el envío sigue bloqueado.
r = await ejecutarTurno(sesion, "¿qué soportes están vencidos?", base(guion([[llamada("simular_envio", { caso, confirmado: true })], "Sigo esperando tu confirmación."])))
assert.equal(r.toolCalls[0]?.ok, false, "una pregunta no es una confirmación")
assert.equal(await existe(envio), false)

// 3. Ahora sí hay pregunta pendiente y el usuario confirma de forma explícita.
r = await ejecutarTurno(sesion, "Sí, confirmo.", base(guion([[llamada("simular_envio", { caso, confirmado: true })], "Envío simulado registrado."])))
assert.equal(r.toolCalls[0]?.ok, true, "con confirmación explícita el envío procede")
assert.equal(r.needsConfirmation, false)
assert.equal(await existe(envio), true, "debe existir ENVIO-SIMULADO.md")

// 4. La autorización es de un solo uso.
r = await ejecutarTurno(sesion, "gracias", base(guion([[llamada("simular_envio", { caso, confirmado: true })], "Listo."])))
assert.equal(r.toolCalls[0]?.ok, false, "la confirmación no se reutiliza en otro turno")

// 5. Argumentos inválidos y herramientas inexistentes vuelven al modelo como error, sin tumbar la sesión.
r = await ejecutarTurno(sesion, "prueba errores", base(guion([[llamada("leer_solicitud", { caso: 42 }), llamada("no_existe", {})], "Hubo errores."])))
assert.deepEqual(r.toolCalls.map((t) => t.ok), [false, false])

// 6. Tope de iteraciones: un modelo que nunca termina se corta con un resumen.
const infinito = Array.from({ length: 10 }, () => [llamada("leer_solicitud", { caso })])
r = await ejecutarTurno(sesion, "bucle", { ...base(guion(infinito)), maxIteraciones: 3 })
assert.equal(r.toolCalls.length, 3)
assert.match(r.reply, /tope de 3 iteraciones/)

console.log("Ciclo del agente: 6 comprobaciones correctas")
