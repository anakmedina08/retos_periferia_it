/**
 * Registro de herramientas: convierte los exports de un archivo de herramientas en
 * definiciones que entiende el modelo (`<archivo>_<export>` + JSON Schema) y valida
 * los argumentos con zod antes de ejecutar. No conoce HTTP ni al proveedor LLM.
 */
import { z } from "zod"
import * as proveedor from "./proveedor.ts"
import type { Ctx } from "./proveedor.ts"
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

const herramientas = cargar("proveedor", proveedor)

export function definiciones(): DefinicionHerramienta[] {
  return [...herramientas].map(([nombre, h]) => {
    const { $schema: _omitido, ...esquema } = z.toJSONSchema(z.object(h.args), { io: "input" })
    return { nombre, descripcion: h.description, esquema }
  })
}

/** Valida y ejecuta. Devuelve siempre el string JSON del contrato; nunca lanza. */
export async function invocar(nombre: string, args: unknown, ctx: Ctx): Promise<string> {
  const herramienta = herramientas.get(nombre)
  if (!herramienta) return JSON.stringify({ ok: false, error: `la herramienta "${nombre}" no existe` })
  const validado = z.object(herramienta.args).safeParse(args)
  if (!validado.success) {
    const detalle = validado.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")
    return JSON.stringify({ ok: false, error: `argumentos inválidos (${detalle})` })
  }
  try {
    return await herramienta.execute(validado.data as never, ctx)
  } catch {
    return JSON.stringify({ ok: false, error: `fallo inesperado en ${nombre}` })
  }
}

export function interpretar(resultado: string): ResultadoHerramienta {
  try {
    return JSON.parse(resultado) as ResultadoHerramienta
  } catch {
    return { ok: false, error: "la herramienta devolvió un resultado ilegible" }
  }
}
