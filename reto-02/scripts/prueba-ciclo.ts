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
const DUDOSO = "msg-006" // contrato marco: valor y fecha de fin requieren revisión
let n = 0
const llamada = (nombre: string, args: unknown): LlamadaHerramienta => ({ id: `t${++n}`, nombre: `contratos_${nombre}`, args })

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
const maestro = path.join(directorio, "out", "sharepoint", "maestro-contratos.csv")
const registrado = async (id: string) => (await fs.readFile(maestro, "utf8").catch(() => "")).includes(id)

await fs.rm(path.join(directorio, "out"), { recursive: true, force: true })
const sesion = obtenerSesion("prueba-ciclo")

// 1. Un modelo desobediente intenta registrar lo dudoso con confirmado=true sin que nadie confirme.
let r = await ejecutarTurno(sesion, "Procesa el buzón", base(guion([
  [llamada("leer_buzon", {}), llamada("registrar", { mensaje_id: "msg-001" })],
  [llamada("registrar", { mensaje_id: DUDOSO, confirmado: true })],
  "¿Confirmas valor 0 y fecha fin 2027-08-31?",
])))
assert.equal(r.toolCalls[1]?.ok, true, "lo limpio se registra sin confirmación")
assert.equal(r.toolCalls.at(-1)?.ok, false, "lo dudoso no se registra sin confirmación humana")
assert.equal(r.needsConfirmation, true, "el turno debe cerrar pidiendo confirmación")
assert.equal(await registrado("CM-2026-03"), false)
assert.equal(await registrado("CT-2026-015"), true)

// 2. El usuario responde otra cosa: la confirmación pendiente caduca.
r = await ejecutarTurno(sesion, "¿qué contratos vencen pronto?", base(guion([[llamada("registrar", { mensaje_id: DUDOSO, confirmado: true })], "Sigo esperando tu confirmación."])))
assert.equal(r.toolCalls[0]?.ok, false, "una pregunta no es una confirmación")
assert.equal(await registrado("CM-2026-03"), false)

// 3. Confirmación explícita, con la frase del PRD.
r = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", base(guion([[llamada("registrar", { mensaje_id: DUDOSO, confirmado: true })], "Registrado."])))
assert.equal(r.toolCalls[0]?.ok, true, "con confirmación explícita se registra")
assert.equal(r.needsConfirmation, false)
assert.equal(await registrado("CM-2026-03"), true)

// 4. Un valor que el modelo cambia por su cuenta no entra al maestro: pasa a revisión.
r = await ejecutarTurno(sesion, "registra msg-002", base(guion([[llamada("registrar", { mensaje_id: "msg-002", contrato: { valor: 999 } })], "Requiere revisión."])))
assert.equal(r.toolCalls[0]?.ok, false, "un valor distinto al del documento exige confirmación")
assert.match(r.toolCalls[0]?.resumen ?? "", /requiere revisión: valor/)
assert.equal(await registrado("CT-2026-016"), false)

// 5. Argumentos inválidos y herramientas inexistentes vuelven al modelo como error, sin tumbar la sesión.
r = await ejecutarTurno(sesion, "prueba errores", base(guion([[llamada("extraer", { mensaje_id: 42 }), llamada("no_existe", {})], "Hubo errores."])))
assert.deepEqual(r.toolCalls.map((t) => t.ok), [false, false])

// 6. Tope de iteraciones: un modelo que nunca termina se corta con un resumen.
const infinito = Array.from({ length: 10 }, () => [llamada("leer_buzon", {})])
r = await ejecutarTurno(sesion, "bucle", { ...base(guion(infinito)), maxIteraciones: 3 })
assert.equal(r.toolCalls.length, 3)
assert.match(r.reply, /tope de 3 iteraciones/)

console.log("Ciclo del agente: 6 comprobaciones correctas")
