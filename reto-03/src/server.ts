/**
 * API HTTP del chat. Solo transporta: valida la entrada, aplica límites de uso,
 * delega el turno en `ejecutarTurno` y sirve el front estático.
 * Usa `node:http` para correr igual en Node 20+ y en Bun, sin framework.
 */
import { createReadStream, promises as fs } from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { ejecutarTurno } from "./agent/ciclo.ts"
import { buscarSesion, guardarSesion, ID_SESION, obtenerSesion } from "./agent/sesiones.ts"
import { config, crearProveedor } from "./config.ts"

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const WEB = path.join(RAIZ, "web")
const OUT = path.join(RAIZ, "out")
const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
}

const llm = crearProveedor()
const sistema = [
  await fs.readFile(path.join(RAIZ, "agent", "prompt.md"), "utf8"),
  await fs.readFile(path.join(RAIZ, "src", "knowledge", "ordenes-compra.md"), "utf8"),
].join("\n\n---\n\n")

// ───────────── Límites de uso: nadie gasta la clave sin tope (PRD 8, Costo) ─────────────

const ventanas = new Map<string, number[]>()
function excedeFrecuencia(ip: string): boolean {
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return recientes.length > config.maxSolicitudesPorMinuto
}

const consumoDiario = { dia: "", tokens: 0 }
function excedeTopeDiario(): boolean {
  const hoy = new Date().toISOString().slice(0, 10)
  if (consumoDiario.dia !== hoy) Object.assign(consumoDiario, { dia: hoy, tokens: 0 })
  return consumoDiario.tokens >= config.maxTokensDia
}

// ───────────── Utilidades HTTP ─────────────

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = []
  let total = 0
  for await (const parte of req) {
    total += (parte as Buffer).length
    if (total > 64_000) throw new Error("cuerpo demasiado grande")
    partes.push(parte as Buffer)
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}")
}

/** Sirve un archivo solo si queda dentro de `base` (evita salir del directorio con `..`). */
async function servirArchivo(res: ServerResponse, base: string, relativo: string, descargar = false): Promise<void> {
  const destino = path.resolve(base, relativo)
  const dentro = destino === base || destino.startsWith(base + path.sep)
  const info = dentro ? await fs.stat(destino).catch(() => undefined) : undefined
  if (!info?.isFile()) return json(res, 404, { ok: false, error: "archivo no encontrado" })
  const cabeceras: Record<string, string> = { "content-type": TIPOS[path.extname(destino)] ?? "application/octet-stream" }
  if (descargar) cabeceras["content-disposition"] = `attachment; filename="${path.basename(destino)}"`
  res.writeHead(200, cabeceras)
  createReadStream(destino).pipe(res)
}

async function listarArchivos(carpeta: string, prefijo = ""): Promise<string[]> {
  const entradas = await fs.readdir(carpeta, { withFileTypes: true }).catch(() => [])
  const rutas: string[] = []
  for (const e of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativo = prefijo ? `${prefijo}/${e.name}` : e.name
    if (e.isDirectory()) rutas.push(...(await listarArchivos(path.join(carpeta, e.name), relativo)))
    else rutas.push(relativo)
  }
  return rutas
}

// ───────────── Estado de las solicitudes (solo para el panel lateral) ─────────────

interface EstadoCaso {
  caso: string
  solicitud_id: string
  descripcion: string
  estado: string
  numero_oc: string
}

/** Último resultado de cada solicitud según out/control.csv (sin comas dentro de las celdas que se leen). */
async function ultimoControl(): Promise<Map<string, { resultado: string; numero_oc: string }>> {
  const texto = await fs.readFile(path.join(OUT, "control.csv"), "utf8").catch(() => "")
  const ultimo = new Map<string, { resultado: string; numero_oc: string }>()
  for (const linea of texto.split("\n").slice(1).filter(Boolean)) {
    const [solicitud = "", resultado = "", numero_oc = ""] = linea.split(",")
    const previo = ultimo.get(solicitud)
    // Una OC creada es definitiva: un reintento idempotente posterior no cambia el estado visible.
    ultimo.set(solicitud, resultado === "idempotente" && previo ? previo : { resultado, numero_oc })
  }
  return ultimo
}

async function estadoCasos(): Promise<EstadoCaso[]> {
  const carpeta = path.join(RAIZ, "fixtures", "reto-03", "solicitudes")
  const control = await ultimoControl()
  const casos: EstadoCaso[] = []
  for (const caso of (await fs.readdir(carpeta).catch(() => [])).sort()) {
    const solicitud = await fs
      .readFile(path.join(carpeta, caso, "solicitud.json"), "utf8")
      .then((t) => JSON.parse(t) as { solicitud_id?: unknown; descripcion?: unknown })
      .catch(() => ({}) as { solicitud_id?: unknown; descripcion?: unknown })
    const id = String(solicitud.solicitud_id ?? "")
    const registro = control.get(id)
    casos.push({ caso, solicitud_id: id, descripcion: String(solicitud.descripcion ?? ""), estado: registro?.resultado ?? "sin procesar", numero_oc: registro?.numero_oc ?? "" })
  }
  return casos
}

/**
 * Devuelve el SAP simulado a su estado inicial borrando lo generado (órdenes, control, evidencias,
 * log). No toca fixtures ni sesiones. Existe para poder repetir la demostración.
 */
async function reiniciar(res: ServerResponse): Promise<void> {
  for (const nombre of await fs.readdir(OUT).catch(() => [])) {
    if (nombre !== "sesiones") await fs.rm(path.join(OUT, nombre), { recursive: true, force: true })
  }
  json(res, 200, { ok: true, casos: await estadoCasos() })
}

// ───────────── Rutas ─────────────

const CuerpoChat = z.object({
  sessionId: z.string().regex(ID_SESION),
  message: z.string().trim().min(1).max(config.maxCaracteresMensaje),
})

async function manejarChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = req.socket.remoteAddress ?? "desconocida"
  if (excedeFrecuencia(ip)) return json(res, 429, { ok: false, error: "Demasiadas solicitudes. Espera un minuto e intenta de nuevo." })
  const cuerpo = CuerpoChat.safeParse(await leerCuerpo(req).catch(() => undefined))
  if (!cuerpo.success) return json(res, 400, { ok: false, error: "Se espera { sessionId, message } con un mensaje de texto no vacío." })
  if (!llm) return json(res, 503, { ok: false, error: "El servidor no tiene configurada la clave del modelo. Define la variable de entorno indicada en .env.example." })
  if (excedeTopeDiario()) return json(res, 429, { ok: false, error: "El agente alcanzó su tope diario de tokens. Vuelve mañana o pide al responsable ampliar el límite." })

  const sesion = obtenerSesion(cuerpo.data.sessionId)
  if (sesion.ocupada) return json(res, 409, { ok: false, error: "Esta sesión todavía está procesando el mensaje anterior." })
  sesion.ocupada = true
  const enVivo = (req.headers.accept ?? "").includes("application/x-ndjson")
  if (enVivo) res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" })
  const antes = sesion.tokens
  try {
    const resultado = await ejecutarTurno(sesion, cuerpo.data.message, {
      llm,
      sistema,
      directorio: RAIZ,
      maxIteraciones: config.maxIteraciones,
      maxTokensSesion: config.maxTokensSesion,
      emitir: enVivo ? (evento) => res.write(JSON.stringify(evento) + "\n") : undefined,
    })
    if (enVivo) res.end(JSON.stringify({ tipo: "fin", ...resultado }) + "\n")
    else json(res, 200, { ok: true, ...resultado })
  } catch {
    const error = "Ocurrió un error inesperado al procesar el mensaje. La sesión sigue activa."
    if (enVivo) res.end(JSON.stringify({ tipo: "error", ts: new Date().toISOString(), texto: error }) + "\n")
    else json(res, 500, { ok: false, error })
  } finally {
    consumoDiario.tokens += sesion.tokens - antes
    sesion.ocupada = false
    await guardarSesion(RAIZ, sesion)
  }
}

async function enrutar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = decodeURIComponent(url.pathname)

  if (req.method === "POST" && ruta === "/api/chat") return manejarChat(req, res)
  if (req.method === "POST" && ruta === "/api/reset") return reiniciar(res)
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "método no permitido" })

  if (ruta === "/api/health") {
    return json(res, 200, { ok: true, provider: llm?.proveedor ?? null, model: llm?.modelo ?? null, configurado: Boolean(llm) })
  }
  if (ruta === "/api/casos") return json(res, 200, { ok: true, casos: await estadoCasos() })
  if (ruta.startsWith("/api/sessions/")) {
    const sesion = buscarSesion(ruta.slice("/api/sessions/".length))
    if (!sesion) return json(res, 404, { ok: false, error: "sesión no encontrada" })
    const { id, creada, historial, tokens, pendientes } = sesion
    return json(res, 200, { ok: true, id, creada, tokens, needsConfirmation: pendientes.length > 0, historial })
  }
  if (ruta === "/api/files") {
    const archivos = (await listarArchivos(OUT)).filter((a) => !a.startsWith("sesiones/"))
    return json(res, 200, { ok: true, archivos })
  }
  if (ruta.startsWith("/api/files/")) {
    const relativo = ruta.slice("/api/files/".length)
    if (relativo.startsWith("sesiones")) return json(res, 404, { ok: false, error: "archivo no encontrado" })
    return servirArchivo(res, OUT, relativo, true)
  }
  return servirArchivo(res, WEB, ruta === "/" ? "index.html" : ruta.slice(1))
}

http
  .createServer((req, res) => {
    enrutar(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: "error interno del servidor" })
      else res.end()
    })
  })
  .listen(config.puerto, () => {
    const estado = llm ? `${llm.proveedor} / ${llm.modelo}` : "SIN CLAVE DE MODELO (revisa .env.example)"
    console.log(`Agente de órdenes de compra en http://localhost:${config.puerto} · modelo: ${estado}`)
  })
