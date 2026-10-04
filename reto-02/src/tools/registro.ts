/**
 * Registro de herramientas: convierte los exports de un archivo de herramientas en
 * definiciones que entiende el modelo (`<archivo>_<export>` + JSON Schema) y valida
 * los argumentos con zod antes de ejecutar. No conoce HTTP ni al proveedor LLM.
 */
import { z } from "zod"
import { promises as fs } from "node:fs"
import path from "node:path"
import * as contratos from "./contratos.ts"
import type { Ctx } from "./contratos.ts"
import type { DefinicionHerramienta } from "../llm/adapter.ts"

interface Herramienta {
  description: string
  args: Record<string, z.ZodType>
  execute(args: never, ctx: Ctx): Promise<string>
}

export interface ResultadoHerramienta {
  ok: boolean
  data?: unknown
  error?: string
}

const esHerramienta = (v: unknown): v is Herramienta =>
  typeof v === "object" && v !== null && "description" in v && "args" in v && "execute" in v

function cargar(prefijo: string, modulo: Record<string, unknown>): Map<string, Herramienta> {
  const mapa = new Map<string, Herramienta>()
  for (const [nombre, valor] of Object.entries(modulo)) {
    if (esHerramienta(valor)) mapa.set(`${prefijo}_${nombre}`, valor)
  }
  return mapa
}

const herramientas = cargar("contratos", contratos)

export function definiciones(): DefinicionHerramienta[] {
  return [...herramientas].map(([nombre, h]) => {
    const { $schema: _omitido, ...esquema } = z.toJSONSchema(z.object(h.args), { io: "input" })
    return { nombre, descripcion: h.description, esquema }
  })
}

/** Los modelos suelen devolver `null` donde el esquema espera "ausente": se eliminan antes de validar. */
function sinNulos(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(sinNulos)
  if (typeof valor !== "object" || valor === null) return valor
  return Object.fromEntries(Object.entries(valor).filter(([, v]) => v !== null).map(([k, v]) => [k, sinNulos(v)]))
}

/** Una llamada que no llega a ejecutarse también deja traza en out/log.jsonl (CA4, RN7). */
async function fallar(nombre: string, error: string, ctx: Ctx): Promise<string> {
  try {
    await fs.mkdir(path.join(ctx.directory, "out"), { recursive: true })
    const linea = { ts: new Date().toISOString(), herramienta: nombre, mensaje_id: null, ok: false, resumen: error, sessionId: ctx.sessionId }
    await fs.appendFile(path.join(ctx.directory, "out", "log.jsonl"), JSON.stringify(linea) + "\n")
  } catch {
    // El log es best-effort.
  }
  return JSON.stringify({ ok: false, error })
}

/** Valida y ejecuta. Devuelve siempre el string JSON del contrato; nunca lanza. */
export async function invocar(nombre: string, args: unknown, ctx: Ctx): Promise<string> {
  const herramienta = herramientas.get(nombre)
  if (!herramienta) return fallar(nombre, `la herramienta "${nombre}" no existe`, ctx)
  const validado = z.object(herramienta.args).safeParse(sinNulos(args ?? {}))
  if (!validado.success) {
    const detalle = validado.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")
    return fallar(nombre, `argumentos inválidos (${detalle})`, ctx)
  }
  try {
    return await herramienta.execute(validado.data as never, ctx)
  } catch {
    return fallar(nombre, `fallo inesperado en ${nombre}`, ctx)
  }
}

export function interpretar(resultado: string): ResultadoHerramienta {
  try {
    return JSON.parse(resultado) as ResultadoHerramienta
  } catch {
    return { ok: false, error: "la herramienta devolvió un resultado ilegible" }
  }
}
