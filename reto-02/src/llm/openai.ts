/**
 * Implementación para cualquier API compatible con OpenAI Chat Completions
 * (OpenAI, Azure OpenAI, Groq, Mistral, Ollama, etc. vía OPENAI_BASE_URL).
 * Existe para demostrar que cambiar de proveedor no toca el ciclo del agente.
 */
import { z } from "zod"
import { ErrorLLM, postJson, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaLLM } from "./adapter.ts"

const Respuesta = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }), extra_content: z.unknown().optional() })).nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
})

function aMensajesOpenAI(mensajes: Mensaje[]): Record<string, unknown>[] {
  return mensajes.flatMap((m): Record<string, unknown>[] => {
    if (m.rol === "sistema") return [{ role: "system", content: m.texto }]
    if (m.rol === "usuario") return [{ role: "user", content: m.texto }]
    if (m.rol === "herramienta") return m.resultados.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.contenido }))
    // `extra_content` vuelve tal como llegó: Gemini exige su firma de razonamiento en cada llamada a herramienta.
    const tool_calls = m.llamadas.map((l) => ({
      id: l.id,
      type: "function",
      function: { name: l.nombre, arguments: JSON.stringify(l.args ?? {}) },
      ...(l.extra === undefined ? {} : { extra_content: l.extra }),
    }))
    return [{ role: "assistant", content: m.texto || null, ...(tool_calls.length ? { tool_calls } : {}) }]
  })
}

function leerArgumentos(json: string): unknown {
  try {
    return JSON.parse(json || "{}")
  } catch {
    return { _argumentos_ilegibles: json.slice(0, 200) } // zod lo rechazará y el modelo podrá corregir
  }
}

export function crearOpenAI(opciones: { clave: string; modelo: string; baseUrl: string; maxTokens: number; timeoutMs: number }): ProveedorLLM {
  return {
    proveedor: "openai",
    modelo: opciones.modelo,
    async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
      const cuerpo = {
        model: opciones.modelo,
        max_completion_tokens: opciones.maxTokens,
        messages: aMensajesOpenAI(mensajes),
        tools: herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.esquema } })),
      }
      const url = `${opciones.baseUrl.replace(/\/$/, "")}/chat/completions`
      const crudo = await postJson(url, { authorization: `Bearer ${opciones.clave}` }, cuerpo, opciones.timeoutMs)
      const r = Respuesta.safeParse(crudo)
      if (!r.success) throw new ErrorLLM("el proveedor del modelo devolvió una respuesta con formato inesperado")
      const mensaje = r.data.choices[0]?.message
      return {
        texto: (mensaje?.content ?? "").trim(),
        llamadas: (mensaje?.tool_calls ?? []).map((t) => ({ id: t.id, nombre: t.function.name, args: leerArgumentos(t.function.arguments), extra: t.extra_content })),
        uso: { entrada: r.data.usage?.prompt_tokens ?? 0, salida: r.data.usage?.completion_tokens ?? 0 },
      }
    },
  }
}
