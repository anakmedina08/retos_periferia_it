/** Sesiones en memoria con respaldo best-effort en out/sesiones/<id>.json. Sin base de datos (PRD 3.2). */
import { promises as fs } from "node:fs"
import path from "node:path"
import type { Mensaje } from "../llm/adapter.ts"

export interface LlamadaVisible {
  id: string
  nombre: string
  args: unknown
  ok: boolean
  resumen: string
  resultado: string
  ms: number
}

export type EntradaHistorial =
  | { tipo: "usuario"; ts: string; texto: string }
  | { tipo: "herramienta"; ts: string; llamada: LlamadaVisible }
  | { tipo: "asistente"; ts: string; texto: string; needsConfirmation: boolean }
  | { tipo: "error"; ts: string; texto: string }

export interface Pendiente {
  accion: string
  caso: string
}

export interface Sesion {
  id: string
  creada: string
  mensajes: Mensaje[] // lo que ve el modelo
  historial: EntradaHistorial[] // lo que ve la persona
  tokens: number
  pendiente?: Pendiente // confirmación solicitada al cerrar el turno anterior
  ocupada: boolean
}

export const ID_SESION = /^[A-Za-z0-9_-]{6,64}$/
const sesiones = new Map<string, Sesion>()
const MAX_SESIONES = 500

export function obtenerSesion(id: string): Sesion {
  let sesion = sesiones.get(id)
  if (!sesion) {
    if (sesiones.size >= MAX_SESIONES) sesiones.delete(sesiones.keys().next().value ?? "")
    sesion = { id, creada: new Date().toISOString(), mensajes: [], historial: [], tokens: 0, ocupada: false }
    sesiones.set(id, sesion)
  }
  return sesion
}

export const buscarSesion = (id: string): Sesion | undefined => sesiones.get(id)

export async function guardarSesion(directorio: string, sesion: Sesion): Promise<void> {
  try {
    const carpeta = path.join(directorio, "out", "sesiones")
    await fs.mkdir(carpeta, { recursive: true })
    const { id, creada, historial, tokens, pendiente } = sesion
    await fs.writeFile(path.join(carpeta, `${id}.json`), JSON.stringify({ id, creada, tokens, pendiente, historial }, null, 2))
  } catch {
    // El respaldo en disco es opcional.
  }
}
