/**
 * Prueba del ciclo del agente con un modelo guionizado (sin clave, sin red).
 * Verifica lo que no depende del modelo: bloqueos y confirmación humana los aplica el backend.
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
let n = 0
const llamada = (nombre: string, args: unknown): LlamadaHerramienta => ({ id: `t${++n}`, nombre: `oc_${nombre}`, args })

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
const ordenes = async () => (await fs.readFile(path.join(directorio, "out", "sap", "ordenes.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean)
const control = async () => fs.readFile(path.join(directorio, "out", "control.csv"), "utf8").catch(() => "")

await fs.rm(path.join(directorio, "out"), { recursive: true, force: true })
const sesion = obtenerSesion("prueba-ciclo")

// 1. Un modelo desobediente intenta crear sol-004 con confirmado=true sin que nadie confirme.
let r = await ejecutarTurno(sesion, "Procesa sol-004", base(guion([
  [llamada("validar", { caso: "sol-004" })],
  [llamada("crear", { caso: "sol-004", confirmado: true })],
  "La cotización difiere de la solicitud. ¿Confirmas crear la OC?",
])))
assert.equal(r.toolCalls.at(-1)?.ok, false, "sin confirmación humana no se crea")
assert.equal(r.needsConfirmation, true, "el turno debe cerrar pidiendo confirmación")
assert.equal((await ordenes()).length, 0)
assert.match(await control(), /SOL-2026-004,pendiente_confirmacion/)

// 2. El usuario responde otra cosa: la confirmación pendiente caduca.
r = await ejecutarTurno(sesion, "¿cuánto es la diferencia?", base(guion([[llamada("crear", { caso: "sol-004", confirmado: true })], "Sigo esperando tu confirmación."])))
assert.equal(r.toolCalls[0]?.ok, false, "una pregunta no es una confirmación")
assert.equal((await ordenes()).length, 0)

// 3. Confirmación explícita: se crea y la excepción queda dentro de la OC.
r = await ejecutarTurno(sesion, "confirmo", base(guion([[llamada("crear", { caso: "sol-004", confirmado: true })], "OC creada."])))
assert.equal(r.toolCalls[0]?.ok, true, "con confirmación explícita se crea")
assert.equal(r.needsConfirmation, false)
assert.match((await ordenes())[0] ?? "", /"numero_oc":"4500000001".*"codigo":"RC5".*"confirmado_por":"analista/)

// 4. El modelo no puede alterar un monto: el payload que envía no es fuente de valores.
r = await ejecutarTurno(sesion, "crea sol-001", base(guion([[llamada("crear", { caso: "sol-001", payload: { posiciones: [{ precio_unitario: 1 }] } })], "Creada."])))
assert.equal(r.toolCalls[0]?.ok, true)
assert.match((await ordenes())[1] ?? "", /"precio_unitario":95000/, "la OC lleva el valor de la solicitud, no el del modelo")

// 5. Un bloqueo no se salta ni con confirmado=true en un turno confirmado.
await ejecutarTurno(sesion, "procesa sol-002", base(guion([[llamada("solicitar_confirmacion", { caso: "sol-002", pregunta: "¿Creo la OC?" })], "¿Confirmas?"])))
r = await ejecutarTurno(sesion, "sí, confirmo", base(guion([[llamada("crear", { caso: "sol-002", confirmado: true })], "Está bloqueada."])))
assert.equal(r.toolCalls[0]?.ok, false, "un bloqueo nunca crea OC")
assert.match(r.toolCalls[0]?.resumen ?? "", /bloqueada.*RC1/)
assert.equal((await ordenes()).length, 2)

// 6. Idempotencia y tope de iteraciones.
r = await ejecutarTurno(sesion, "crea sol-001 otra vez", base(guion([[llamada("crear", { caso: "sol-001" })], "Ya existía."])))
assert.match(r.toolCalls[0]?.resultado ?? "", /"idempotente":true/)
assert.equal((await ordenes()).length, 2)
const infinito = Array.from({ length: 10 }, () => [llamada("validar", { caso: "sol-001" })])
r = await ejecutarTurno(sesion, "bucle", { ...base(guion(infinito)), maxIteraciones: 3 })
assert.match(r.reply, /tope de 3 iteraciones/)

console.log("Ciclo del agente: 6 comprobaciones correctas")
