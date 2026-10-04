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
const conocimiento = await leer("src", "knowledge", "registro-contratos.md")
const herramientas = await leer("src", "tools", "contratos.ts")

const archivos: Record<string, string> = {
  "agent.md": [
    "---",
    "description: Punto único de recepción de contratos: extrae, valida, registra en el maestro y alerta vencimientos, sin registrar lo dudoso sin confirmación humana.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    prompt,
  ].join("\n"),
  "tools/contratos.ts": herramientas,
  "skill/registro-contratos/SKILL.md": [
    "---",
    "name: registro-contratos",
    "description: Reglas del proceso de registro de contratos (clasificación, confianza y revisión, pólizas, archivo, alertas). Úsalo al procesar el buzón de contratos.",
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
