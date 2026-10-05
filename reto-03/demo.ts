/**
 * Verificación sin modelo: procesa los 6 casos llamando directamente a las herramientas.
 * No requiere clave de ningún proveedor.   bun run demo.ts   |   npm run demo
 *
 * Muestra además la idempotencia (sol-001 dos veces) y la confirmación explícita (sol-004).
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { invocar, interpretar } from "./src/tools/registro.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory, sessionId: "demo" }

interface Hallazgo { regla: string; detalle: string; accion_sugerida?: string }
interface Validacion { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Record<string, { valor: string; motivo: string }>; retroactiva: boolean; avisos: string[] }
interface Payload { orden: unknown; valor_total: number }
interface Creacion { numero_oc: string; idempotente: boolean; retroactiva: boolean; ruta_evidencia: string }

async function llamar<T>(nombre: string, args: unknown): Promise<{ data?: T; error?: string }> {
  const r = interpretar(await invocar(`oc_${nombre}`, args, ctx))
  console.log(`  ${r.ok ? "ok   " : "ERROR"} ${nombre}${r.ok ? "" : `: ${(r.error ?? "").split(". Acción sugerida")[0]}`}`)
  return r.ok ? { data: r.data as T } : { error: r.error }
}

function mostrarCreacion(c: Creacion | undefined, error: string | undefined): void {
  if (c) console.log(`  Resultado: OC ${c.numero_oc}${c.idempotente ? " (ya existía: idempotente)" : " creada"} · retroactiva=${c.retroactiva} · evidencia ${c.ruta_evidencia}`)
  else console.log(`  Resultado: SIN OC · ${error?.startsWith("requiere confirmación") ? "espera confirmación humana" : "bloqueada"}`)
}

async function procesar(caso: string): Promise<void> {
  console.log(`\n== ${caso} ==`)
  const paquete = (await llamar<unknown>("leer_paquete", { caso })).data
  if (!paquete) return
  const v = (await llamar<Validacion>("validar", { caso, paquete })).data
  if (!v) return
  console.log(`  apta=${v.apta} · retroactiva=${v.retroactiva}`)
  for (const b of v.bloqueos) console.log(`    bloqueo ${b.regla}: ${b.detalle}\n      acción: ${b.accion_sugerida}`)
  for (const c of v.confirmaciones) console.log(`    confirmar ${c.regla}: ${c.detalle}`)
  for (const [campo, d] of Object.entries(v.derivados)) console.log(`    derivado ${campo} = ${d.valor} (${d.motivo})`)
  for (const a of v.avisos) console.log(`    aviso: ${a}`)
  const payload = v.apta ? (await llamar<Payload>("construir_payload", { caso, paquete, derivados: v.derivados })).data : undefined
  if (v.apta) await llamar("generar_evidencia", { caso })
  const r = await llamar<Creacion>("crear", { caso, payload: payload?.orden })
  mostrarCreacion(r.data, r.error)
}

await fs.rm(path.join(directory, "out"), { recursive: true, force: true })
const casos = (await fs.readdir(path.join(directory, "fixtures", "reto-03", "solicitudes"))).sort()
for (const caso of casos) await procesar(caso)

console.log("\n== Idempotencia: sol-001 por segunda vez ==")
const repetida = await llamar<Creacion>("crear", { caso: "sol-001" })
mostrarCreacion(repetida.data, repetida.error)

console.log("\n== Confirmación humana explícita ==")
for (const caso of ["sol-004", "sol-005"]) {
  console.log(`  La analista confirma las excepciones de ${caso}`)
  const r = await llamar<Creacion>("crear", { caso, confirmado: true })
  mostrarCreacion(r.data, r.error)
}

console.log("\n== Guardas (se espera ERROR en las tres) ==")
await llamar("leer_paquete", { caso: "sol-999" })
await llamar("leer_paquete", { caso: "../../etc" })
await llamar("crear", { caso: "sol-002", confirmado: true })

console.log("\n== out/control.csv ==")
console.log((await fs.readFile(path.join(directory, "out", "control.csv"), "utf8")).trim().split("\n").map((l) => `  ${l}`).join("\n"))
console.log("\nÓrdenes en out/sap/ordenes.jsonl · evidencias y trazabilidad en out/<caso>/ · traza en out/log.jsonl")
