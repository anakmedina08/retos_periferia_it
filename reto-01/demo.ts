/**
 * Verificación sin modelo: ejecuta todos los casos llamando directamente a las herramientas.
 * No requiere clave de ningún proveedor.   bun run demo.ts   |   npm run demo
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { invocar, interpretar } from "./src/tools/registro.ts"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory, sessionId: "demo" }

interface Campo { etiqueta: string; motivo?: string; nota?: string }
interface Solicitud { pais: string; cliente: string; formato: string; campos: string[]; soportes: string[] }
interface Mapeo { llenos: Campo[]; faltantes: Campo[]; requiere_confirmacion: Campo[] }
interface Paquete { ruta: string; listo_para_firma: boolean; bloqueos: string[] }

async function llamar<T>(nombre: string, args: unknown): Promise<T | undefined> {
  const r = interpretar(await invocar(`proveedor_${nombre}`, args, ctx))
  console.log(`  ${r.ok ? "ok   " : "ERROR"} ${nombre}${r.ok ? "" : `: ${r.error}`}`)
  return r.ok ? (r.data as T) : undefined
}

async function procesar(caso: string): Promise<void> {
  console.log(`\n== ${caso} ==`)
  const solicitud = await llamar<Solicitud>("leer_solicitud", { caso })
  if (!solicitud) return
  const mapeo = await llamar<Mapeo>("mapear_campos", { caso, campos: solicitud.campos })
  const formulario = await llamar<{ ruta: string; mensaje?: string }>("generar_formulario", { caso, mapeo })
  const paquete = await llamar<Paquete>("armar_paquete", { caso })

  console.log(`  Cliente: ${solicitud.cliente} (${solicitud.pais}) · formato ${solicitud.formato}`)
  if (mapeo) {
    console.log(`  Campos: ${mapeo.llenos.length} llenos · ${mapeo.faltantes.length} faltantes · ${mapeo.requiere_confirmacion.length} por confirmar`)
    for (const f of mapeo.faltantes) console.log(`    faltante: ${f.etiqueta}`)
    for (const c of mapeo.requiere_confirmacion) console.log(`    confirmar: ${c.etiqueta} -> ${c.nota}`)
  }
  if (formulario) console.log(`  Formulario: ${formulario.ruta}${formulario.mensaje ? ` (${formulario.mensaje})` : ""}`)
  if (paquete) {
    console.log(`  Paquete: ${paquete.ruta} · listo_para_firma=${paquete.listo_para_firma}`)
    for (const b of paquete.bloqueos) console.log(`    bloqueo: ${b}`)
  }
}

async function verificarGuardas(caso: string): Promise<void> {
  console.log("\n== Guardas (se espera ERROR en las tres primeras) ==")
  await llamar("simular_envio", { caso, confirmado: false })
  await llamar("leer_solicitud", { caso: "caso-que-no-existe" })
  await llamar("leer_solicitud", { caso: "../../etc/passwd" })
  await llamar("simular_envio", { caso, confirmado: true })
}

await fs.rm(path.join(directory, "out"), { recursive: true, force: true })
const casos = (await fs.readdir(path.join(directory, "fixtures", "reto-01", "casos"))).sort()
for (const caso of casos) await procesar(caso)
if (casos[0]) await verificarGuardas(casos[0])
console.log("\nSalidas en out/<caso>/ · trazas en out/<caso>/log.jsonl")
