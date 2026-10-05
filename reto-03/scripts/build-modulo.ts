/**
 * Genera `modulo/` (bonus 9.4) a partir de las MISMAS piezas que usa la aplicación: prompt,
 * herramientas (con el adaptador SAP del que dependen) y conocimiento. No se edita a mano: se
 * regenera con `npm run modulo`. Con `--check` solo verifica que no haya divergencia.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const leer = (...p: string[]) => fs.readFile(path.join(raiz, ...p), "utf8")

const archivos: Record<string, string> = {
  "agent.md": [
    "---",
    "description: Valida solicitudes de compra contra los controles de la compañía y crea la orden de compra en SAP, sin crear lo bloqueado ni lo dudoso sin confirmación humana.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    await leer("agent", "prompt.md"),
  ].join("\n"),
  // oc.ts importa ../sap/*: se conserva la misma ruta relativa dentro del módulo.
  "tools/oc.ts": await leer("src", "tools", "oc.ts"),
  "sap/adapter.ts": await leer("src", "sap", "adapter.ts"),
  "sap/mock.ts": await leer("src", "sap", "mock.ts"),
  "skill/ordenes-compra/SKILL.md": [
    "---",
    "name: ordenes-compra",
    "description: Reglas del proceso de órdenes de compra (controles RC1 a RC10, aprobadores y topes, confirmaciones, OC retroactivas, qué queda registrado). Úsalo al procesar una solicitud de compra.",
    "---",
    "",
    await leer("src", "knowledge", "ordenes-compra.md"),
  ].join("\n"),
}

const soloVerificar = process.argv.includes("--check")
let divergencias = 0
for (const [relativo, contenido] of Object.entries(archivos)) {
  const destino = path.join(raiz, "modulo", relativo)
  if (soloVerificar) {
    const actual = await fs.readFile(destino, "utf8").catch(() => "")
    if (actual !== contenido) {
      divergencias++
      console.error(`modulo/${relativo} no coincide con su fuente`)
    }
    continue
  }
  await fs.mkdir(path.dirname(destino), { recursive: true })
  await fs.writeFile(destino, contenido)
  console.log(`modulo/${relativo}`)
}
if (soloVerificar) {
  if (divergencias) process.exit(1)
  console.log("modulo/ coincide con las fuentes")
}
