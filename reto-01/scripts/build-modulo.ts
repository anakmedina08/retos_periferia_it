/**
 * Genera `modulo/` (bonus 9.4) a partir de las MISMAS piezas que usa la aplicación:
 * prompt, herramientas y conocimiento. No se edita a mano: se regenera con `npm run modulo`.
 * Con `--check` solo verifica que no haya divergencia (útil en CI).
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const leer = (...p: string[]) => fs.readFile(path.join(raiz, ...p), "utf8")

const prompt = await leer("agent", "prompt.md")
const conocimiento = await leer("src", "knowledge", "registro-proveedor.md")
const herramientas = await leer("src", "tools", "proveedor.ts")

const archivos: Record<string, string> = {
  "agent.md": [
    "---",
    "description: Prepara formularios de registro como proveedor y el paquete para firma, sin enviar nada sin confirmación humana.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    prompt,
  ].join("\n"),
  "tools/proveedor.ts": herramientas,
  "skill/registro-proveedor/SKILL.md": [
    "---",
    "name: registro-proveedor",
    "description: Reglas del proceso de registro como proveedor (estados de campo, identificador tributario por país, soportes y vigencias, formatos). Úsalo al procesar una solicitud de registro.",
    "---",
    "",
    conocimiento,
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
