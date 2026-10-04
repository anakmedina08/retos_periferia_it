/** Configuración leída del entorno. La clave del modelo nunca sale de este módulo salvo hacia el adaptador. */
import { crearAnthropic } from "./llm/anthropic.ts"
import { crearOpenAI } from "./llm/openai.ts"
import type { ProveedorLLM } from "./llm/adapter.ts"

const entero = (nombre: string, defecto: number): number => {
  const n = Number.parseInt(process.env[nombre] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : defecto
}

export const config = {
  puerto: entero("PORT", 3000),
  maxIteraciones: entero("MAX_ITERACIONES", 25),
  maxTokensSesion: entero("MAX_TOKENS_SESION", 150_000),
  maxTokensDia: entero("MAX_TOKENS_DIA", 2_000_000),
  maxTokensRespuesta: entero("MAX_TOKENS_RESPUESTA", 2_000),
  timeoutLlmMs: entero("LLM_TIMEOUT_MS", 60_000),
  maxSolicitudesPorMinuto: entero("MAX_SOLICITUDES_POR_MINUTO", 20),
  maxCaracteresMensaje: entero("MAX_CARACTERES_MENSAJE", 4_000),
}

/** Devuelve el proveedor configurado, o undefined si falta la clave (el servidor sigue arriba y lo explica). */
export function crearProveedor(): ProveedorLLM | undefined {
  const base = { maxTokens: config.maxTokensRespuesta, timeoutMs: config.timeoutLlmMs }
  const elegido = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase()
  if (elegido === "openai") {
    const clave = process.env.OPENAI_API_KEY
    if (!clave) return undefined
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
    return crearOpenAI({ ...base, clave, baseUrl, modelo: process.env.LLM_MODEL ?? "gpt-4.1-mini" })
  }
  const clave = process.env.ANTHROPIC_API_KEY
  if (!clave) return undefined
  return crearAnthropic({ ...base, clave, modelo: process.env.LLM_MODEL ?? "claude-haiku-4-5" })
}
