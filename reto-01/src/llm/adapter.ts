/**
 * Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor es escribir otro archivo que implemente `ProveedorLLM`.
 */
export interface LlamadaHerramienta {
  id: string
  nombre: string
  args: unknown
  /** Metadatos opacos del proveedor que deben devolverse intactos en el siguiente llamado (p. ej. firmas de razonamiento de Gemini). */
  extra?: unknown
}

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[] }
  | { rol: "herramienta"; resultados: { id: string; nombre: string; contenido: string }[] }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  esquema: Record<string, unknown>
}

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
}

export interface ProveedorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM>
}

/** Error con mensaje apto para el chat (sin claves, sin trazas). */
export class ErrorLLM extends Error {}

export async function postJson(url: string, cabeceras: Record<string, string>, cuerpo: unknown, timeoutMs: number): Promise<unknown> {
  let respuesta: Response
  try {
    respuesta = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...cabeceras },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const agotado = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
    throw new ErrorLLM(agotado ? `el modelo no respondió en ${Math.round(timeoutMs / 1000)} s` : "no fue posible conectar con el proveedor del modelo")
  }
  if (!respuesta.ok) {
    const motivos: Record<number, string> = {
      401: "la clave del modelo no es válida",
      403: "la clave del modelo no tiene permiso para este modelo",
      404: "el modelo configurado no existe",
      429: "el proveedor del modelo está limitando las solicitudes; intenta en un momento",
    }
    // El detalle va a la consola del servidor para depurar; al chat solo llega una frase clara. El cuerpo no contiene la clave.
    const detalle = await respuesta.text().catch(() => "")
    console.error(`[llm] HTTP ${respuesta.status}: ${detalle.slice(0, 800)}`)
    throw new ErrorLLM(motivos[respuesta.status] ?? `el proveedor del modelo respondió con error ${respuesta.status}`)
  }
  return respuesta.json()
}
