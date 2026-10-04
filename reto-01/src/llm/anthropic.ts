import { z } from "zod"
import { ErrorLLM, postJson, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type RespuestaLLM } from "./adapter.ts"

const Respuesta = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
    ]),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
  }),
})

type Bloque = Record<string, unknown>

function aMensajesAnthropic(mensajes: Mensaje[]): { role: "user" | "assistant"; content: Bloque[] }[] {
  const salida: { role: "user" | "assistant"; content: Bloque[] }[] = []
  for (const m of mensajes) {
    if (m.rol === "usuario") salida.push({ role: "user", content: [{ type: "text", text: m.texto }] })
    if (m.rol === "asistente") {
      const bloques: Bloque[] = m.texto ? [{ type: "text", text: m.texto }] : []
      for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args ?? {} })
      salida.push({ role: "assistant", content: bloques.length ? bloques : [{ type: "text", text: "(sin texto)" }] })
    }
    if (m.rol === "herramienta") {
      salida.push({ role: "user", content: m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido })) })
    }
  }
  return salida
}

export function crearAnthropic(opciones: { clave: string; modelo: string; maxTokens: number; timeoutMs: number }): ProveedorLLM {
  return {
    proveedor: "anthropic",
    modelo: opciones.modelo,
    async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
      const sistema = mensajes.flatMap((m) => (m.rol === "sistema" ? [m.texto] : [])).join("\n\n")
      const tools = herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquema }))
      // El prompt y las herramientas no cambian entre llamadas: se cachean para abaratar el ciclo.
      const ultima = tools.at(-1)
      if (ultima) Object.assign(ultima, { cache_control: { type: "ephemeral" } })
      const cuerpo = {
        model: opciones.modelo,
        max_tokens: opciones.maxTokens,
        temperature: 0,
        system: [{ type: "text", text: sistema, cache_control: { type: "ephemeral" } }],
        tools,
        messages: aMensajesAnthropic(mensajes),
      }
      const cabeceras = { "x-api-key": opciones.clave, "anthropic-version": "2023-06-01" }
      const crudo = await postJson("https://api.anthropic.com/v1/messages", cabeceras, cuerpo, opciones.timeoutMs)
      const r = Respuesta.safeParse(crudo)
      if (!r.success) throw new ErrorLLM("el proveedor del modelo devolvió una respuesta con formato inesperado")
      const u = r.data.usage
      return {
        texto: r.data.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim(),
        llamadas: r.data.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, args: b.input }] : [])),
        uso: { entrada: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), salida: u.output_tokens },
      }
    },
  }
}
