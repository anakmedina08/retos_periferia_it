/**
 * Verificación sin modelo: procesa los 6 mensajes del buzón llamando directamente a las
 * herramientas. No requiere clave de ningún proveedor.   bun run demo.ts   |   npm run demo
 *
 * Primera pasada: registra lo limpio; lo que requiere revisión queda SIN registrar.
 * Segunda pasada: registra con `confirmado: true` un mensaje que quedó en revisión.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { invocar, interpretar } from "./src/tools/registro.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory, sessionId: "demo" }
const HOY = "2026-09-03"

interface Mensaje { id: string; asunto?: string; tiene_contrato: boolean; motivo?: string }
interface Validacion { clasificacion: string; motivo: string | null; requiere_revision: string[]; detalle_revision: { campo: string; valor: unknown; motivo: string }[]; avisos: string[] }
interface Registro { id_contrato: string | null; accion: string; ruta_archivo: string | null; cambios: { campo: string; anterior: string; nuevo: string }[] }
interface Alertas { ruta: string; vencen: { id_contrato: string; detalle: string }[]; polizas_pendientes: { id_contrato: string; detalle: string }[]; registrados_desde_corte: { id_contrato: string }[] }

async function llamar<T>(nombre: string, args: unknown, silencioso = false): Promise<{ data?: T; error?: string }> {
  const r = interpretar(await invocar(`contratos_${nombre}`, args, ctx))
  if (!silencioso) console.log(`  ${r.ok ? "ok   " : "ERROR"} ${nombre}${r.ok ? "" : `: ${r.error}`}`)
  return r.ok ? { data: r.data as T } : { error: r.error }
}

function mostrarRegistro(r: Registro): void {
  console.log(`  Acción: ${r.accion}${r.id_contrato ? ` · ${r.id_contrato}` : ""}${r.ruta_archivo ? ` · ${r.ruta_archivo}` : ""}`)
  for (const c of r.cambios) console.log(`    cambio: ${c.campo}: "${c.anterior}" -> "${c.nuevo}"`)
}

/** Devuelve el contrato extraído si el mensaje quedó a la espera de confirmación. */
async function procesar(m: Mensaje): Promise<unknown | undefined> {
  console.log(`\n== ${m.id} · ${m.asunto ?? ""} ==`)
  const contrato = m.tiene_contrato ? (await llamar<unknown>("extraer", { mensaje_id: m.id })).data : undefined
  const v = (await llamar<Validacion>("validar", { mensaje_id: m.id, contrato })).data
  if (!v) return undefined
  console.log(`  Clasificación: ${v.clasificacion}${v.motivo ? ` (${v.motivo})` : ""}`)
  for (const d of v.detalle_revision) console.log(`    revisar ${d.campo} = ${JSON.stringify(d.valor)}: ${d.motivo}`)
  for (const a of v.avisos) console.log(`    aviso: ${a}`)
  const r = await llamar<Registro>("registrar", { mensaje_id: m.id, contrato })
  if (r.data) mostrarRegistro(r.data)
  else console.log("  Acción: SIN REGISTRAR, queda a la espera de confirmación humana")
  return r.data ? undefined : contrato
}

await fs.rm(path.join(directory, "out"), { recursive: true, force: true })
const buzon = (await llamar<{ mensajes: Mensaje[] }>("leer_buzon", {})).data
const enRevision: { id: string; contrato: unknown }[] = []
for (const m of buzon?.mensajes ?? []) {
  const contrato = await procesar(m)
  if (contrato) enRevision.push({ id: m.id, contrato })
}

console.log("\n== Segunda pasada: confirmación humana ==")
for (const { id, contrato } of enRevision.slice(0, 1)) {
  console.log(`  La analista confirma los campos en revisión de ${id}`)
  const r = await llamar<Registro>("registrar", { mensaje_id: id, contrato, confirmado: true })
  if (r.data) mostrarRegistro(r.data)
}

console.log("\n== Guardas (se espera ERROR en las cuatro) ==")
await llamar("registrar", { mensaje_id: "msg-001" })
await llamar("extraer", { mensaje_id: "msg-005" })
await llamar("extraer", { mensaje_id: "../../etc" })
await llamar("alertas", { hoy: "2026-02-30" })

console.log(`\n== Alertas con fecha ${HOY} ==`)
const a = (await llamar<Alertas>("alertas", { hoy: HOY })).data
if (a) {
  for (const v of a.vencen) console.log(`  vence: ${v.id_contrato} · ${v.detalle}`)
  for (const p of a.polizas_pendientes) console.log(`  póliza: ${p.id_contrato} · ${p.detalle}`)
  console.log(`  registrados desde el corte: ${a.registrados_desde_corte.map((r) => r.id_contrato).join(", ") || "ninguno"}`)
  console.log(`  Reporte: ${a.ruta}`)
}
const pendientes = (await llamar<{ pendientes: number }>("leer_buzon", {}, true)).data?.pendientes
console.log(`\nMensajes pendientes en el buzón: ${pendientes}. Maestro en out/sharepoint/maestro-contratos.csv · traza en out/log.jsonl`)
