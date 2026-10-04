/**
 * Herramientas del agente "Registro como Proveedor".
 *
 * Cada export es un objeto { description, args, execute } y el modelo lo ve como
 * `proveedor_<export>`. Reglas del contrato (PRD 6.2):
 *   - `execute` devuelve SIEMPRE un string JSON `{ ok: true, data }` o `{ ok: false, error }`.
 *   - Ninguna herramienta lanza: todo pasa por `ejecutar()`, que captura y registra.
 *   - Las rutas se resuelven desde `ctx.directory`; nunca absolutas, nunca shell.
 *   - Los valores salen del maestro. Lo que el modelo envíe como "valor" se ignora.
 *
 * El archivo es autocontenido a propósito (solo depende de zod, exceljs y pdf-lib)
 * para poder empaquetarse tal cual en `modulo/tools/proveedor.ts`.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib"
import { z } from "zod"

// ───────────────────────────── Tipos y constantes ─────────────────────────────

export interface Ctx {
  directory: string
  sessionId: string
}

const FIXTURES = path.join("fixtures", "reto-01")
const OUT = "out"
const UMBRAL_CONFIANZA = 0.8
const UMBRAL_SUGERENCIA = 0.5

/** RN1: nombre del identificador tributario por país del cliente. */
const ID_TRIBUTARIO: Record<string, string> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }
const CLAVE_ID_TRIBUTARIO = "nit"
const PREFIJO_BANCO = "banco."
const PALABRAS_VACIAS = new Set(["de", "del", "la", "el", "los", "las", "o", "y", "a", "en"])

const CasoId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "el caso solo admite minúsculas, números y guiones")

const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  adjuntos: z.array(z.string()).default([]),
})
type Solicitud = z.infer<typeof SolicitudSchema>

const CeldaSchema = z.object({
  hoja: z.string().min(1),
  celda_etiqueta: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  etiqueta: z.string().min(1),
  celda_valor: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
})
const CampoSchema = z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean().default(false) })
type Celda = z.infer<typeof CeldaSchema>
type Campo = z.infer<typeof CampoSchema>

const SoporteSchema = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.string().nullable(),
  pais_emisor: z.string(),
  descripcion: z.string().default(""),
})
type Soporte = z.infer<typeof SoporteSchema>

type Plantilla = { tipo: "celdas"; celdas: Celda[] } | { tipo: "campos"; campos: Campo[] }

interface CampoLleno {
  etiqueta: string
  ruta: string
  valor: string
  confianza: number
}
interface CampoFaltante {
  etiqueta: string
  motivo: string
}
interface CampoPorConfirmar {
  etiqueta: string
  ruta: string
  valor_propuesto: string
  confianza: number
  nota: string
  /** true = se escribe en el formulario mientras se confirma (RN1). false = queda en blanco. */
  llenar: boolean
}
interface MapeoResuelto {
  llenos: CampoLleno[]
  faltantes: CampoFaltante[]
  requiere_confirmacion: CampoPorConfirmar[]
}

type EstadoSoporte = "presente" | "ausente" | "vencido"
interface ItemChecklist {
  tipo: string
  estado: EstadoSoporte
  archivo: string | null
  vigencia_hasta: string | null
  detalle: string
}

/** Error esperado: su mensaje es apto para mostrarse al usuario. */
class ErrorClaro extends Error {}

// ───────────────────────────── Utilidades base ─────────────────────────────

const rutaCaso = (ctx: Ctx, caso: string) => path.join(ctx.directory, FIXTURES, "casos", caso)
const rutaSalida = (ctx: Ctx, caso: string) => path.join(ctx.directory, OUT, caso)
const relativa = (ctx: Ctx, absoluta: string) => path.relative(ctx.directory, absoluta).split(path.sep).join("/")

/** Fecha de ejecución (YYYY-MM-DD). `FECHA_EJECUCION` permite reproducir una corrida. */
function fechaEjecucion(): string {
  const fijada = process.env.FECHA_EJECUCION
  if (fijada && /^\d{4}-\d{2}-\d{2}$/.test(fijada)) return fijada
  return new Date().toISOString().slice(0, 10)
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await fs.access(ruta)
    return true
  } catch {
    return false
  }
}

async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, nombre: string): Promise<T> {
  let crudo: string
  try {
    crudo = await fs.readFile(ruta, "utf8")
  } catch {
    throw new ErrorClaro(`no se encontró ${nombre}`)
  }
  let json: unknown
  try {
    json = JSON.parse(crudo)
  } catch {
    throw new ErrorClaro(`${nombre} está corrupto: no es JSON válido`)
  }
  const validado = esquema.safeParse(json)
  if (!validado.success) {
    const detalle = validado.error.issues[0]
    throw new ErrorClaro(`${nombre} no tiene la estructura esperada (${detalle?.path.join(".")}: ${detalle?.message})`)
  }
  return validado.data
}

async function registrar(ctx: Ctx, caso: string, herramienta: string, ok: boolean, resumen: string): Promise<void> {
  try {
    const conocido = CasoId.safeParse(caso).success && (await existe(rutaCaso(ctx, caso)))
    const carpeta = conocido ? rutaSalida(ctx, caso) : path.join(ctx.directory, OUT, "_sin-caso")
    await fs.mkdir(carpeta, { recursive: true })
    const linea = JSON.stringify({ ts: new Date().toISOString(), herramienta, ok, resumen, sessionId: ctx.sessionId })
    await fs.appendFile(path.join(carpeta, "log.jsonl"), linea + "\n")
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

/** Envoltura común: valida el caso, captura todo error y deja traza (RN5). Nunca lanza. */
async function ejecutar<T>(
  herramienta: string,
  caso: string,
  ctx: Ctx,
  trabajo: () => Promise<{ data: T; resumen: string }>,
): Promise<string> {
  try {
    const id = CasoId.safeParse(caso)
    if (!id.success) throw new ErrorClaro(`nombre de caso inválido: ${id.error.issues[0]?.message}`)
    if (!(await existe(rutaCaso(ctx, caso)))) {
      const disponibles = await listarCasos(ctx)
      throw new ErrorClaro(`el caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ") || "ninguno"}`)
    }
    const { data, resumen } = await trabajo()
    await registrar(ctx, caso, herramienta, true, resumen)
    return JSON.stringify({ ok: true, data })
  } catch (e) {
    const error = e instanceof ErrorClaro ? e.message : `error interno en ${herramienta}; revisa el log del caso`
    const detalle = e instanceof Error ? e.message : String(e)
    await registrar(ctx, caso, herramienta, false, e instanceof ErrorClaro ? error : `${error} (${detalle})`)
    return JSON.stringify({ ok: false, error })
  }
}

async function listarCasos(ctx: Ctx): Promise<string[]> {
  try {
    const entradas = await fs.readdir(path.join(ctx.directory, FIXTURES, "casos"), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

// ───────────────────────────── Lectura de fixtures ─────────────────────────────

const leerSolicitud = (ctx: Ctx, caso: string): Promise<Solicitud> =>
  leerJson(path.join(rutaCaso(ctx, caso), "solicitud.json"), SolicitudSchema, "solicitud.json")

async function leerPlantilla(ctx: Ctx, caso: string): Promise<Plantilla> {
  const celdas = path.join(rutaCaso(ctx, caso), "plantilla-celdas.json")
  if (await existe(celdas)) {
    return { tipo: "celdas", celdas: await leerJson(celdas, z.array(CeldaSchema), "plantilla-celdas.json") }
  }
  const campos = path.join(rutaCaso(ctx, caso), "plantilla-campos.json")
  if (await existe(campos)) {
    return { tipo: "campos", campos: await leerJson(campos, z.array(CampoSchema), "plantilla-campos.json") }
  }
  throw new ErrorClaro("el caso no trae plantilla (plantilla-celdas.json o plantilla-campos.json)")
}

const etiquetasDe = (p: Plantilla): string[] =>
  p.tipo === "celdas" ? p.celdas.map((c) => c.etiqueta) : p.campos.map((c) => c.etiqueta)

const leerMaestro = (ctx: Ctx) =>
  leerJson(path.join(ctx.directory, FIXTURES, "repositorio", "maestro.json"), z.record(z.string(), z.unknown()), "maestro.json")

const leerGlosario = (ctx: Ctx) =>
  leerJson(path.join(ctx.directory, FIXTURES, "glosario-campos.json"), z.record(z.string(), z.string()), "glosario-campos.json")

const leerIndiceSoportes = (ctx: Ctx) =>
  leerJson(path.join(ctx.directory, FIXTURES, "repositorio", "soportes", "index.json"), z.array(SoporteSchema), "soportes/index.json")

const leerSoportesExigidos = (ctx: Ctx, caso: string) =>
  leerJson(path.join(rutaCaso(ctx, caso), "soportes-exigidos.json"), z.array(z.string()), "soportes-exigidos.json")

// ───────────────────────────── Mapeo de campos ─────────────────────────────

const normalizar = (texto: string): string =>
  texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()

const tokens = (texto: string): Set<string> =>
  new Set(normalizar(texto).split(" ").filter((t) => t && !PALABRAS_VACIAS.has(t)))

function similitud(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  const comunes = [...ta].filter((t) => tb.has(t)).length
  return comunes / (ta.size + tb.size - comunes)
}

/** Lee `a.b.c` del maestro. Solo devuelve primitivos: un objeto no es un valor de formulario. */
function valorEnRuta(maestro: Record<string, unknown>, ruta: string): string | undefined {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return undefined
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (typeof actual === "string") return actual === "" ? undefined : actual
  if (typeof actual === "number" || typeof actual === "boolean") return String(actual)
  return undefined
}

interface Coincidencia {
  ruta: string
  confianza: number
  sinonimo: string
}

function buscarEnGlosario(etiqueta: string, glosario: Record<string, string>): Coincidencia | undefined {
  const exacta = glosario[etiqueta]
  if (exacta) return { ruta: exacta, confianza: 1, sinonimo: etiqueta }
  const objetivo = normalizar(etiqueta)
  let mejor: Coincidencia | undefined
  for (const [sinonimo, ruta] of Object.entries(glosario)) {
    if (normalizar(sinonimo) === objetivo) return { ruta, confianza: 0.95, sinonimo }
    const puntaje = similitud(etiqueta, sinonimo)
    // Una coincidencia difusa nunca supera el umbral: siempre pasa por un humano.
    if (puntaje >= UMBRAL_SUGERENCIA && (!mejor || puntaje > mejor.confianza)) {
      mejor = { ruta, confianza: Math.min(puntaje, UMBRAL_CONFIANZA - 0.01), sinonimo }
    }
  }
  return mejor && { ...mejor, confianza: Math.round(mejor.confianza * 100) / 100 }
}

const ETIQUETAS_ID_ESPECIFICAS = new Set(Object.values(ID_TRIBUTARIO).map(normalizar))

/** RN1 + HU-1: nota de confirmación para el identificador tributario, o undefined si no aplica. */
function notaIdentificador(etiqueta: string, pais: string): string | undefined {
  const esperado = ID_TRIBUTARIO[pais]
  const generica = !ETIQUETAS_ID_ESPECIFICAS.has(normalizar(etiqueta))
  if (pais !== "CO") {
    const equivalente = esperado ? `el cliente espera ${esperado} (${pais})` : `país ${pais} sin regla de identificador`
    return `identificador extranjero: ${equivalente}; Periferia solo tiene NIT colombiano, se propone el NIT`
  }
  if (generica) return `campo ambiguo: en Colombia equivale al NIT`
  return undefined
}

function clasificarCampo(
  etiqueta: string,
  pais: string,
  glosario: Record<string, string>,
  maestro: Record<string, unknown>,
): { lleno: CampoLleno } | { faltante: CampoFaltante } | { confirmar: CampoPorConfirmar } {
  const hallazgo = buscarEnGlosario(etiqueta, glosario)
  if (!hallazgo) return { faltante: { etiqueta, motivo: "la etiqueta no está en el glosario ni tiene equivalente en el maestro" } }
  const valor = valorEnRuta(maestro, hallazgo.ruta)
  if (valor === undefined) {
    return { faltante: { etiqueta, motivo: `el glosario apunta a "${hallazgo.ruta}", pero el maestro no tiene ese dato` } }
  }
  if (hallazgo.confianza < UMBRAL_CONFIANZA) {
    const nota = `coincidencia aproximada con "${hallazgo.sinonimo}" (confianza ${hallazgo.confianza}); queda en blanco hasta confirmar`
    return { confirmar: { etiqueta, ruta: hallazgo.ruta, valor_propuesto: valor, confianza: hallazgo.confianza, nota, llenar: false } }
  }
  const nota = hallazgo.ruta === CLAVE_ID_TRIBUTARIO ? notaIdentificador(etiqueta, pais) : undefined
  if (nota) {
    return { confirmar: { etiqueta, ruta: hallazgo.ruta, valor_propuesto: valor, confianza: hallazgo.confianza, nota, llenar: true } }
  }
  return { lleno: { etiqueta, ruta: hallazgo.ruta, valor, confianza: hallazgo.confianza } }
}

async function mapear(ctx: Ctx, etiquetas: string[], pais: string): Promise<MapeoResuelto> {
  const [glosario, maestro] = await Promise.all([leerGlosario(ctx), leerMaestro(ctx)])
  const mapeo: MapeoResuelto = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const etiqueta of etiquetas) {
    const r = clasificarCampo(etiqueta, pais, glosario, maestro)
    if ("lleno" in r) mapeo.llenos.push(r.lleno)
    else if ("faltante" in r) mapeo.faltantes.push(r.faltante)
    else mapeo.requiere_confirmacion.push(r.confirmar)
  }
  return mapeo
}

// ───────────────────── Resolución del mapeo que envía el modelo ─────────────────────

const ItemMapeo = z.looseObject({
  etiqueta: z.string().describe("Etiqueta tal como aparece en la plantilla"),
  ruta: z.string().optional().describe("Ruta del dato en el maestro, p. ej. banco.nombre"),
  llenar: z.boolean().optional().describe("Solo en requiere_confirmacion: si se escribe en el formulario"),
})
const MapeoEntrada = z.object({
  llenos: z.array(ItemMapeo).default([]),
  faltantes: z.array(ItemMapeo).default([]),
  requiere_confirmacion: z.array(ItemMapeo).default([]),
})
type MapeoEntradaT = z.infer<typeof MapeoEntrada>

/** RN2: una ruta bancaria solo se acepta si el glosario dice que esa etiqueta pide un dato bancario. */
function rutaPermitida(etiqueta: string, ruta: string, glosario: Record<string, string>): boolean {
  if (!ruta.startsWith(PREFIJO_BANCO)) return true
  return buscarEnGlosario(etiqueta, glosario)?.ruta === ruta
}

/**
 * Convierte el mapeo recibido en uno confiable: conserva la DECISIÓN (qué etiqueta va a qué ruta)
 * pero vuelve a leer cada VALOR del maestro. Así el modelo no puede introducir un valor propio (CA2).
 */
async function resolverMapeo(ctx: Ctx, entrada: MapeoEntradaT, etiquetas: string[], pais: string): Promise<MapeoResuelto> {
  const [glosario, maestro, base] = await Promise.all([leerGlosario(ctx), leerMaestro(ctx), mapear(ctx, etiquetas, pais)])
  const salida: MapeoResuelto = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  const pedidas = new Set(etiquetas)
  const vistas = new Set<string>()
  const tomar = (etiqueta: string) => pedidas.has(etiqueta) && !vistas.has(etiqueta) && Boolean(vistas.add(etiqueta))

  for (const item of entrada.llenos) {
    if (!tomar(item.etiqueta)) continue
    const valor = item.ruta ? valorEnRuta(maestro, item.ruta) : undefined
    if (!item.ruta || valor === undefined || !rutaPermitida(item.etiqueta, item.ruta, glosario)) {
      salida.faltantes.push({ etiqueta: item.etiqueta, motivo: `ruta "${item.ruta ?? ""}" inválida o no permitida para este campo` })
      continue
    }
    const original = base.llenos.find((l) => l.etiqueta === item.etiqueta && l.ruta === item.ruta)
    salida.llenos.push({ etiqueta: item.etiqueta, ruta: item.ruta, valor, confianza: original?.confianza ?? 1 })
  }
  for (const item of entrada.requiere_confirmacion) {
    if (!tomar(item.etiqueta)) continue
    const original = base.requiere_confirmacion.find((c) => c.etiqueta === item.etiqueta)
    const ruta = item.ruta ?? original?.ruta
    const valor = ruta ? valorEnRuta(maestro, ruta) : undefined
    if (!ruta || valor === undefined || !rutaPermitida(item.etiqueta, ruta, glosario)) {
      salida.faltantes.push({ etiqueta: item.etiqueta, motivo: "requiere confirmación, pero no hay un dato válido en el maestro" })
      continue
    }
    salida.requiere_confirmacion.push({
      etiqueta: item.etiqueta,
      ruta,
      valor_propuesto: valor,
      confianza: original?.confianza ?? 0,
      nota: original?.nota ?? "pendiente de confirmación por la analista",
      llenar: item.llenar ?? original?.llenar ?? false,
    })
  }
  for (const item of entrada.faltantes) {
    if (!tomar(item.etiqueta)) continue
    const original = base.faltantes.find((f) => f.etiqueta === item.etiqueta)
    salida.faltantes.push({ etiqueta: item.etiqueta, motivo: original?.motivo ?? "marcado como faltante" })
  }
  // Lo que la plantilla pide y el mapeo recibido omitió se clasifica con la regla determinista.
  for (const etiqueta of etiquetas) {
    if (vistas.has(etiqueta)) continue
    const l = base.llenos.find((x) => x.etiqueta === etiqueta)
    const c = base.requiere_confirmacion.find((x) => x.etiqueta === etiqueta)
    const f = base.faltantes.find((x) => x.etiqueta === etiqueta)
    if (l) salida.llenos.push(l)
    else if (c) salida.requiere_confirmacion.push(c)
    else salida.faltantes.push(f ?? { etiqueta, motivo: "sin mapeo" })
  }
  return salida
}

/** Valor que se escribe en el formulario para cada etiqueta ("" = se deja en blanco). */
function valoresParaFormulario(mapeo: MapeoResuelto): Map<string, string> {
  const valores = new Map<string, string>()
  for (const l of mapeo.llenos) valores.set(l.etiqueta, l.valor)
  for (const c of mapeo.requiere_confirmacion) if (c.llenar) valores.set(c.etiqueta, c.valor_propuesto)
  return valores
}

// ───────────────────────────── Generadores de formulario ─────────────────────────────

async function escribirXlsx(destino: string, celdas: Celda[], valores: Map<string, string>): Promise<void> {
  const libro = new ExcelJS.Workbook()
  libro.created = new Date(0) // metadatos fijos: mismo archivo en cada corrida
  libro.modified = new Date(0)
  for (const celda of celdas) {
    const hoja = libro.getWorksheet(celda.hoja) ?? libro.addWorksheet(celda.hoja)
    hoja.getCell(celda.celda_etiqueta).value = celda.etiqueta
    hoja.getCell(celda.celda_etiqueta).font = { bold: true }
    const destinoValor = hoja.getCell(celda.celda_valor)
    destinoValor.numFmt = "@" // texto: conserva ceros a la izquierda en NIT y cuentas
    destinoValor.value = valores.get(celda.etiqueta) ?? ""
  }
  libro.eachSheet((hoja) => hoja.columns.forEach((c) => (c.width = 34)))
  await libro.xlsx.writeFile(destino)
}

function partirEnLineas(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(/\s+/)) {
    const candidata = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(candidata, tamano) <= ancho || !actual) actual = candidata
    else {
      lineas.push(actual)
      actual = palabra
    }
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : [""]
}

/** Las fuentes estándar de PDF usan WinAnsi: se reemplaza lo que no se puede codificar. */
const aWinAnsi = (texto: string): string => texto.replace(/[^\x20-\x7E\u00A1-\u00FF]/g, "?")

async function escribirPdf(destino: string, solicitud: Solicitud, campos: Campo[], valores: Map<string, string>): Promise<void> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Formulario de registro de proveedor - ${solicitud.cliente}`)
  pdf.setCreationDate(new Date(0))
  pdf.setModificationDate(new Date(0))
  const normal = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const margen = 56
  const anchoValor = 595 - margen * 2 - 190
  let pagina = pdf.addPage([595, 842])
  let y = 842 - margen
  pagina.drawText(aWinAnsi("Formulario de registro de proveedor"), { x: margen, y, size: 15, font: negrita })
  y -= 20
  pagina.drawText(aWinAnsi(`Cliente: ${solicitud.cliente} (${solicitud.pais})`), { x: margen, y, size: 10, font: normal })
  y -= 28
  for (const campo of campos) {
    const lineas = partirEnLineas(aWinAnsi(valores.get(campo.etiqueta) ?? ""), normal, 10, anchoValor)
    const alto = Math.max(lineas.length, 1) * 13 + 9
    if (y - alto < margen + 60) {
      pagina = pdf.addPage([595, 842])
      y = 842 - margen
    }
    const etiqueta = aWinAnsi(campo.etiqueta + (campo.obligatorio ? " *" : ""))
    partirEnLineas(etiqueta, negrita, 10, 180).forEach((l, i) => pagina.drawText(l, { x: margen, y: y - i * 13, size: 10, font: negrita }))
    lineas.forEach((l, i) => pagina.drawText(l, { x: margen + 190, y: y - i * 13, size: 10, font: normal }))
    const base = y - (Math.max(lineas.length, 1) - 1) * 13 - 4
    pagina.drawLine({ start: { x: margen + 190, y: base }, end: { x: 595 - margen, y: base }, thickness: 0.5 })
    y -= alto
  }
  y -= 36
  pagina.drawLine({ start: { x: margen, y }, end: { x: margen + 220, y }, thickness: 0.7 })
  pagina.drawText(aWinAnsi("Firma del representante legal"), { x: margen, y: y - 13, size: 9, font: normal })
  pagina.drawText("* Campo obligatorio", { x: margen, y: margen - 20, size: 8, font: normal })
  await fs.writeFile(destino, await pdf.save({ useObjectStreams: false }))
}

async function escribirValoresPortal(destino: string, solicitud: Solicitud, etiquetas: string[], mapeo: MapeoResuelto): Promise<void> {
  const valores = valoresParaFormulario(mapeo)
  const porConfirmar = new Set(mapeo.requiere_confirmacion.map((c) => c.etiqueta))
  const filas = etiquetas.map((e) => {
    const valor = valores.get(e)
    const estado = valor === undefined ? "PENDIENTE" : porConfirmar.has(e) ? "confirmar antes de copiar" : "listo"
    return `| ${e} | ${valor ?? ""} | ${estado} |`
  })
  const contenido = [
    `# Valores para el portal de ${solicitud.cliente}`,
    "",
    "Formato no soportado: el agente no opera portales web. Una persona ingresa al portal con sus",
    "credenciales, copia estos valores y hace clic en Enviar. Este archivo no contiene credenciales.",
    "",
    "| Campo del portal | Valor a copiar | Estado |",
    "|---|---|---|",
    ...filas,
    "",
  ].join("\n")
  await fs.writeFile(destino, contenido)
}

// ───────────────────────────── Paquete para firma ─────────────────────────────

const NOMBRES_FORMULARIO = ["formulario.xlsx", "formulario.pdf", "valores-portal.md"] as const

async function formularioGenerado(ctx: Ctx, caso: string): Promise<string | undefined> {
  for (const nombre of NOMBRES_FORMULARIO) {
    if (await existe(path.join(rutaSalida(ctx, caso), nombre))) return nombre
  }
  return undefined
}

async function evaluarSoportes(ctx: Ctx, exigidos: string[], carpetaPaquete: string): Promise<ItemChecklist[]> {
  const indice = await leerIndiceSoportes(ctx)
  const hoy = fechaEjecucion()
  const carpetaSoportes = path.join(ctx.directory, FIXTURES, "repositorio", "soportes")
  const items: ItemChecklist[] = []
  for (const tipo of exigidos) {
    const soporte: Soporte | undefined = indice.find((s) => s.tipo === tipo)
    const origen = soporte ? path.join(carpetaSoportes, path.basename(soporte.archivo)) : undefined
    if (!soporte || !origen || !(await existe(origen))) {
      items.push({ tipo, estado: "ausente", archivo: null, vigencia_hasta: null, detalle: "no existe en el repositorio de soportes" })
      continue
    }
    await fs.copyFile(origen, path.join(carpetaPaquete, path.basename(soporte.archivo)))
    const vencido = soporte.vigencia_hasta !== null && soporte.vigencia_hasta < hoy
    items.push({
      tipo,
      estado: vencido ? "vencido" : "presente",
      archivo: soporte.archivo,
      vigencia_hasta: soporte.vigencia_hasta,
      detalle: vencido ? `venció el ${soporte.vigencia_hasta}; se debe actualizar` : soporte.descripcion,
    })
  }
  return items
}

async function leerMapeoGuardado(ctx: Ctx, caso: string): Promise<MapeoResuelto | undefined> {
  try {
    const crudo = await fs.readFile(path.join(rutaSalida(ctx, caso), "mapeo.json"), "utf8")
    return JSON.parse(crudo) as MapeoResuelto
  } catch {
    return undefined
  }
}

function textoChecklist(solicitud: Solicitud, formulario: string | undefined, items: ItemChecklist[], mapeo: MapeoResuelto | undefined, bloqueos: string[]): string {
  const marca: Record<EstadoSoporte, string> = { presente: "[x]", ausente: "[ ] AUSENTE", vencido: "[ ] VENCIDO" }
  return [
    `# Checklist - ${solicitud.cliente}`,
    "",
    `- Fecha de ejecución: ${fechaEjecucion()}`,
    `- Estado: ${bloqueos.length === 0 ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}`,
    ...bloqueos.map((b) => `  - Bloqueo: ${b}`),
    "",
    "## Formulario",
    formulario ? `- [x] ${formulario}` : "- [ ] No se ha generado el formulario",
    "",
    "## Soportes exigidos",
    ...items.map((i) => `- ${marca[i.estado]} ${i.tipo}${i.archivo ? ` (${i.archivo})` : ""} - ${i.detalle}`),
    "",
    "## Campos faltantes (no bloquean la firma)",
    ...(mapeo?.faltantes.length ? mapeo.faltantes.map((f) => `- ${f.etiqueta}: ${f.motivo}`) : ["- Ninguno"]),
    "",
    "## Campos por confirmar",
    ...(mapeo?.requiere_confirmacion.length ? mapeo.requiere_confirmacion.map((c) => `- ${c.etiqueta}: ${c.nota}`) : ["- Ninguno"]),
    "",
  ].join("\n")
}

/** RN2: el borrador nombra campos y soportes, pero nunca incluye valores del maestro. */
function textoBorrador(solicitud: Solicitud, formulario: string | undefined, items: ItemChecklist[], mapeo: MapeoResuelto | undefined): string {
  const adjuntos = items.filter((i) => i.estado === "presente").map((i) => `- ${i.tipo} (${i.archivo})`)
  const pendientes = items.filter((i) => i.estado !== "presente").map((i) => `- ${i.tipo}: ${i.estado}`)
  const faltantes = mapeo?.faltantes.map((f) => `- ${f.etiqueta}`) ?? []
  return [
    "# Borrador de correo (no enviado)",
    "",
    `Para: ${solicitud.de}`,
    `Asunto: RE: ${solicitud.asunto}`,
    "",
    "Buen día,",
    "",
    `En respuesta a su solicitud del ${solicitud.fecha}, adjuntamos el formulario de registro de proveedor`,
    "firmado por nuestro representante legal, junto con los siguientes soportes:",
    "",
    ...(formulario ? [`- Formulario diligenciado (${formulario})`] : []),
    ...adjuntos,
    "",
    ...(pendientes.length ? ["Soportes que enviaremos en un segundo correo, una vez actualizados:", "", ...pendientes, ""] : []),
    ...(faltantes.length ? ["Campos del formulario sobre los que necesitamos orientación de su parte:", "", ...faltantes, ""] : []),
    "Quedamos atentos a cualquier inquietud.",
    "",
    "Cordialmente,",
    "Área Administrativa",
    "",
    "> Nota interna: borrador generado por el agente. Requiere firma del representante legal y revisión",
    "> humana antes de enviarse. No contiene datos bancarios.",
    "",
  ].join("\n")
}

// ───────────────────────────── Herramientas exportadas ─────────────────────────────

export const leer_solicitud = {
  description:
    "Lee el correo del cliente y su plantilla, y devuelve país, cliente, formato de salida, campos solicitados y soportes exigidos; es el primer paso de todo caso.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, p. ej. ec-corp-andina"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return ejecutar("leer_solicitud", args.caso, ctx, async () => {
      const solicitud = await leerSolicitud(ctx, args.caso)
      const advertencias: string[] = []
      let campos: string[] = []
      try {
        campos = etiquetasDe(await leerPlantilla(ctx, args.caso))
      } catch (e) {
        advertencias.push(`plantilla no legible: ${e instanceof Error ? e.message : "error"}; se continúa sin campos`)
      }
      let soportes: string[] = []
      try {
        soportes = await leerSoportesExigidos(ctx, args.caso)
      } catch (e) {
        advertencias.push(`soportes exigidos no legibles: ${e instanceof Error ? e.message : "error"}`)
      }
      if (solicitud.formato === "portal") advertencias.push("formato no soportado: portal web; solo se prepararán los valores para copiar")
      const data = {
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        campos,
        soportes,
        identificador_tributario_pais: ID_TRIBUTARIO[solicitud.pais] ?? null,
        asunto: solicitud.asunto,
        fecha: solicitud.fecha,
        advertencias,
      }
      return { data, resumen: `${solicitud.cliente} (${solicitud.pais}), ${solicitud.formato}, ${campos.length} campos, ${soportes.length} soportes` }
    })
  },
}

export const mapear_campos = {
  description:
    "Cruza cada campo solicitado con el repositorio maestro usando el glosario y lo clasifica como lleno, faltante o requiere_confirmacion; es la única fuente de valores.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso"),
    campos: z.array(z.string().min(1)).max(200).describe("Etiquetas devueltas por proveedor_leer_solicitud, sin modificar"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: Ctx): Promise<string> {
    return ejecutar("mapear_campos", args.caso, ctx, async () => {
      const solicitud = await leerSolicitud(ctx, args.caso)
      const data = await mapear(ctx, args.campos, solicitud.pais)
      const resumen = `${data.llenos.length} llenos, ${data.faltantes.length} faltantes, ${data.requiere_confirmacion.length} por confirmar`
      return { data, resumen }
    })
  },
}

export const generar_formulario = {
  description:
    "Genera el formulario en el formato que pidió el cliente (xlsx o pdf) en out/<caso>/; para portal web responde formato no soportado y deja valores-portal.md.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso"),
    mapeo: MapeoEntrada.optional().describe(
      "Resultado de proveedor_mapear_campos. Solo se usan etiqueta y ruta: los valores se releen del maestro. Si se omite, se recalcula.",
    ),
  },
  async execute(args: { caso: string; mapeo?: MapeoEntradaT }, ctx: Ctx): Promise<string> {
    type Salida = { ruta: string; formato: string; soportado: boolean; campos_escritos: number; mensaje?: string }
    return ejecutar<Salida>("generar_formulario", args.caso, ctx, async () => {
      const solicitud = await leerSolicitud(ctx, args.caso)
      const plantilla = await leerPlantilla(ctx, args.caso)
      const etiquetas = etiquetasDe(plantilla)
      const entrada = args.mapeo ?? { llenos: [], faltantes: [], requiere_confirmacion: [] }
      const mapeo = await resolverMapeo(ctx, entrada, etiquetas, solicitud.pais)
      const carpeta = rutaSalida(ctx, args.caso)
      await fs.mkdir(carpeta, { recursive: true })
      for (const previo of NOMBRES_FORMULARIO) await fs.rm(path.join(carpeta, previo), { force: true })
      await fs.writeFile(path.join(carpeta, "mapeo.json"), JSON.stringify(mapeo, null, 2))
      const valores = valoresParaFormulario(mapeo)
      const conteo = `${valores.size}/${etiquetas.length} campos escritos`

      if (solicitud.formato === "portal") {
        const destino = path.join(carpeta, "valores-portal.md")
        await escribirValoresPortal(destino, solicitud, etiquetas, mapeo)
        const mensaje = "formato no soportado: el portal web lo opera una persona; se dejaron los valores listos para copiar"
        return { data: { ruta: relativa(ctx, destino), formato: "portal", soportado: false, campos_escritos: valores.size, mensaje }, resumen: `portal: ${conteo}` }
      }
      if (solicitud.formato === "xlsx") {
        if (plantilla.tipo !== "celdas") throw new ErrorClaro("el formato es xlsx pero el caso no trae plantilla-celdas.json")
        const destino = path.join(carpeta, "formulario.xlsx")
        await escribirXlsx(destino, plantilla.celdas, valores)
        return { data: { ruta: relativa(ctx, destino), formato: "xlsx", soportado: true, campos_escritos: valores.size }, resumen: `xlsx: ${conteo}` }
      }
      if (plantilla.tipo !== "campos") throw new ErrorClaro("el formato es pdf pero el caso no trae plantilla-campos.json")
      const destino = path.join(carpeta, "formulario.pdf")
      await escribirPdf(destino, solicitud, plantilla.campos, valores)
      return { data: { ruta: relativa(ctx, destino), formato: "pdf", soportado: true, campos_escritos: valores.size }, resumen: `pdf: ${conteo}` }
    })
  },
}

export const armar_paquete = {
  description:
    "Arma out/<caso>/paquete/ con el formulario, los soportes exigidos, checklist.md y borrador-correo.md, e indica si queda listo_para_firma.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso; el formulario debe haberse generado antes"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return ejecutar("armar_paquete", args.caso, ctx, async () => {
      const solicitud = await leerSolicitud(ctx, args.caso)
      const exigidos = await leerSoportesExigidos(ctx, args.caso)
      const carpeta = path.join(rutaSalida(ctx, args.caso), "paquete")
      await fs.rm(carpeta, { recursive: true, force: true })
      await fs.mkdir(carpeta, { recursive: true })

      const formulario = await formularioGenerado(ctx, args.caso)
      if (formulario) await fs.copyFile(path.join(rutaSalida(ctx, args.caso), formulario), path.join(carpeta, formulario))
      const soportes = await evaluarSoportes(ctx, exigidos, carpeta)
      const mapeo = await leerMapeoGuardado(ctx, args.caso)

      const bloqueos: string[] = []
      if (!formulario) bloqueos.push("no se ha generado el formulario")
      if (formulario === "valores-portal.md") bloqueos.push("formato portal: no hay formulario para firmar; una persona diligencia el portal")
      for (const s of soportes) if (s.estado !== "presente") bloqueos.push(`soporte ${s.tipo} ${s.estado}`)

      await fs.writeFile(path.join(carpeta, "checklist.md"), textoChecklist(solicitud, formulario, soportes, mapeo, bloqueos))
      await fs.writeFile(path.join(carpeta, "borrador-correo.md"), textoBorrador(solicitud, formulario, soportes, mapeo))
      const data = {
        ruta: relativa(ctx, carpeta),
        listo_para_firma: bloqueos.length === 0,
        bloqueos,
        checklist: {
          fecha_ejecucion: fechaEjecucion(),
          formulario: formulario ?? null,
          soportes,
          campos_faltantes: mapeo?.faltantes.map((f) => f.etiqueta) ?? [],
          campos_por_confirmar: mapeo?.requiere_confirmacion.map((c) => c.etiqueta) ?? [],
        },
      }
      return { data, resumen: `listo_para_firma=${data.listo_para_firma}; bloqueos: ${bloqueos.join("; ") || "ninguno"}` }
    })
  },
}

export const simular_envio = {
  description:
    "Simula el envío del paquete escribiendo out/<caso>/ENVIO-SIMULADO.md; solo procede con confirmado=true tras una confirmación explícita del usuario en el turno anterior.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso; el paquete debe estar armado"),
    confirmado: z.boolean().describe("true únicamente si el usuario confirmó de forma explícita en su último mensaje"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Ctx): Promise<string> {
    return ejecutar("simular_envio", args.caso, ctx, async () => {
      if (!args.confirmado) throw new ErrorClaro("requiere confirmación explícita")
      const carpeta = path.join(rutaSalida(ctx, args.caso), "paquete")
      if (!(await existe(path.join(carpeta, "checklist.md")))) {
        throw new ErrorClaro("no hay paquete armado para este caso; ejecuta primero proveedor_armar_paquete")
      }
      const solicitud = await leerSolicitud(ctx, args.caso)
      const checklist = await fs.readFile(path.join(carpeta, "checklist.md"), "utf8")
      const listo = checklist.includes("Estado: LISTO PARA FIRMA")
      const archivos = (await fs.readdir(carpeta)).sort()
      const destino = path.join(rutaSalida(ctx, args.caso), "ENVIO-SIMULADO.md")
      const contenido = [
        "# Envío simulado",
        "",
        "Ningún correo salió de este sistema. Este archivo es la única acción ejecutada.",
        "",
        `- Fecha: ${new Date().toISOString()}`,
        `- Destinatario previsto: ${solicitud.de}`,
        `- Confirmado por: usuario de la sesión ${ctx.sessionId}`,
        `- Estado del paquete: ${listo ? "listo para firma" : "NO listo para firma (ver checklist.md)"}`,
        "",
        "## Contenido del paquete",
        ...archivos.map((a) => `- ${a}`),
        "",
      ].join("\n")
      await fs.writeFile(destino, contenido)
      const advertencia = listo ? null : "el paquete se envió (simulado) sin estar listo para firma"
      return { data: { ruta: relativa(ctx, destino), listo_para_firma: listo, advertencia }, resumen: `envío simulado; listo=${listo}` }
    })
  },
}

export const solicitar_confirmacion = {
  description:
    "Registra que el agente necesita una confirmación humana antes de una acción externa; llámala justo antes de cerrar el turno con la pregunta.",
  args: {
    caso: CasoId.describe("Caso sobre el que se pide confirmación"),
    accion: z.enum(["simular_envio"]).describe("Acción externa que quedará habilitada si el usuario confirma"),
    pregunta: z.string().min(5).max(300).describe("Pregunta de sí o no que verá el usuario"),
  },
  async execute(args: { caso: string; accion: "simular_envio"; pregunta: string }, ctx: Ctx): Promise<string> {
    return ejecutar("solicitar_confirmacion", args.caso, ctx, async () => ({
      data: { caso: args.caso, accion: args.accion, pregunta: args.pregunta, estado: "esperando_confirmacion" },
      resumen: `confirmación pendiente: ${args.accion}`,
    }))
  },
}
