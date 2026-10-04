/**
 * Herramientas del agente "Registro de Contratos Vigentes".
 *
 * Cada export es un objeto { description, args, execute } y el modelo lo ve como
 * `contratos_<export>`. Reglas del contrato (PRD 6.2):
 *   - `execute` devuelve SIEMPRE un string JSON `{ ok: true, data }` o `{ ok: false, error }`.
 *   - Ninguna herramienta lanza: todo pasa por `ejecutar()`, que captura y registra (RN7).
 *   - Las rutas se resuelven desde `ctx.directory`; nunca absolutas, nunca shell.
 *   - El fixture del maestro es de solo lectura; se trabaja sobre la copia en out/sharepoint/ (RN6).
 *   - La confianza de cada campo la calcula SIEMPRE la extracción determinista. Si el contrato
 *     recibido trae un valor distinto al del documento, ese campo pasa a revisión humana.
 *
 * El archivo es autocontenido (solo depende de zod) para empaquetarse tal cual en
 * `modulo/tools/contratos.ts`.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"

// ───────────────────────────── Tipos y constantes ─────────────────────────────

export interface Ctx {
  directory: string
  sessionId: string
}

const FIXTURES = path.join("fixtures", "reto-02")
const OUT = "out"
const SHAREPOINT = path.join(OUT, "sharepoint")
const UMBRAL_CONFIANZA = 0.8
const SIMILITUD_OBJETO = 0.9
const DIAS_ALERTA = 60
const FECHA_CORTE = "2026-05-30"

const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
type Pais = (typeof PAISES)[number]
type Moneda = (typeof MONEDAS)[number]

const COLUMNAS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
  "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const
type Columna = (typeof COLUMNAS)[number]
type Fila = Record<Columna, string>

/** Campos que se extraen del documento. Son los únicos que pueden pedir revisión. */
const CAMPOS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
] as const
type Campo = (typeof CAMPOS)[number]

interface Contrato {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: Pais | null
  objeto: string | null
  valor: number | null
  moneda: Moneda | null
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
}

interface Extraccion {
  tipo_documento: "contrato" | "otrosi"
  numero_otrosi: string | null
  valor_indeterminado: boolean
  contrato: Contrato
  confianza: Record<Campo, number>
  notas: Partial<Record<Campo, string>>
}

type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"

interface Diferencia {
  campo: string
  anterior: string
  nuevo: string
}

interface Revision {
  campo: string
  valor: string | number | boolean | null
  confianza: number
  motivo: string
}

interface Evaluacion {
  clasificacion: Clasificacion
  motivo: string | null
  id_contrato_existente: string | null
  requiere_revision: string[]
  detalle_revision: Revision[]
  diferencias: Diferencia[]
  comercial: string
  avisos: string[]
  contrato: Contrato
  tipo_documento: "contrato" | "otrosi" | null
  numero_otrosi: string | null
  adjunto: string | null
}

/** Error esperado: su mensaje es apto para mostrarse al usuario. */
class ErrorClaro extends Error {}

// ───────────────────────────── Esquemas de entrada ─────────────────────────────

const MensajeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "el id de mensaje solo admite minúsculas, números y guiones")
const FechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "se espera una fecha YYYY-MM-DD")

const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().default(""),
  adjuntos: z.array(z.string()).default([]),
})
type Correo = z.infer<typeof CorreoSchema>

/**
 * Contrato que puede enviar el modelo. Todos los campos son opcionales: lo que no llegue se toma
 * de la extracción. Sirve para que un humano corrija un valor; la confianza no se puede enviar.
 */
const ContratoEntrada = z.looseObject({
  id_contrato: z.string().min(1).max(40).optional().describe("Número del contrato tal como aparece en el documento"),
  cliente: z.string().min(1).max(200).optional().describe("Razón social de la contraparte"),
  nit_cliente: z.string().regex(/^\d{5,20}$/).optional().describe("Identificador tributario, solo dígitos, sin dígito de verificación"),
  pais: z.enum(PAISES).optional().describe("País de la contraparte"),
  objeto: z.string().min(1).max(200).optional().describe("Objeto del contrato, máximo 200 caracteres"),
  valor: z.number().min(0).optional().describe("Valor total sin separadores; 0 si es por demanda"),
  moneda: z.enum(MONEDAS).optional().describe("Moneda del contrato"),
  fecha_inicio: FechaIso.optional().describe("Fecha de inicio YYYY-MM-DD"),
  fecha_fin: FechaIso.optional().describe("Fecha de fin YYYY-MM-DD"),
  requiere_poliza: z.boolean().optional().describe("Si el contrato exige póliza"),
  tipo_poliza: z.string().max(200).optional().describe("Tipos de póliza separados por ;"),
})
type ContratoEntradaT = z.infer<typeof ContratoEntrada>

// ───────────────────────────── Utilidades base ─────────────────────────────

const abs = (ctx: Ctx, ...partes: string[]) => path.join(ctx.directory, ...partes)
const posix = (ruta: string) => ruta.split(path.sep).join("/")
const rutaMensaje = (ctx: Ctx, id: string) => abs(ctx, FIXTURES, "buzon", id)
const rutaMaestro = (ctx: Ctx) => abs(ctx, SHAREPOINT, "maestro-contratos.csv")

/** Fecha con la que se sella `fecha_registro`. `FECHA_EJECUCION` permite reproducir una corrida. */
function fechaHoy(): string {
  const fijada = process.env.FECHA_EJECUCION
  if (fijada && esFechaValida(fijada)) return fijada
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
  if (!validado.success) throw new ErrorClaro(`${nombre} no tiene la estructura esperada`)
  return validado.data
}

async function registrarLog(ctx: Ctx, herramienta: string, mensajeId: string | null, ok: boolean, resumen: string): Promise<void> {
  try {
    await fs.mkdir(abs(ctx, OUT), { recursive: true })
    const linea = { ts: new Date().toISOString(), herramienta, mensaje_id: mensajeId, ok, resumen, sessionId: ctx.sessionId }
    await fs.appendFile(abs(ctx, OUT, "log.jsonl"), JSON.stringify(linea) + "\n")
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

/** Envoltura común: captura todo error y deja traza en out/log.jsonl (RN7). Nunca lanza. */
async function ejecutar<T>(
  herramienta: string,
  mensajeId: string | null,
  ctx: Ctx,
  trabajo: () => Promise<{ data: T; resumen: string }>,
): Promise<string> {
  try {
    const { data, resumen } = await trabajo()
    await registrarLog(ctx, herramienta, mensajeId, true, resumen)
    return JSON.stringify({ ok: true, data })
  } catch (e) {
    const claro = e instanceof ErrorClaro
    const error = claro ? e.message : `error interno en ${herramienta}; revisa out/log.jsonl`
    const detalle = e instanceof Error ? e.message : String(e)
    await registrarLog(ctx, herramienta, mensajeId, false, claro ? error : `${error} (${detalle})`)
    return JSON.stringify({ ok: false, error })
  }
}

const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
const normalizar = (t: string) => sinTildes(t).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()

// ───────────────────────────── Fechas ─────────────────────────────

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
const dos = (n: number) => String(n).padStart(2, "0")
const diasDelMes = (ano: number, mes: number) => new Date(Date.UTC(ano, mes, 0)).getUTCDate()

function esFechaValida(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return false
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasDelMes(ano, mes)
}

function numeroDeMes(nombre: string): number {
  const mes = MESES.indexOf(sinTildes(nombre).toLowerCase().replace("setiembre", "septiembre")) + 1
  if (mes === 0) throw new ErrorClaro(`fecha inválida: "${nombre}" no es un mes`)
  return mes
}

function aIso(dia: number, mesNombre: string, ano: number): string {
  const iso = `${ano}-${dos(numeroDeMes(mesNombre))}-${dos(dia)}`
  if (!esFechaValida(iso)) throw new ErrorClaro(`fecha inválida en el documento: ${dia} de ${mesNombre} de ${ano}`)
  return iso
}

/** Suma meses conservando el día cuando existe; si no, usa el último día del mes destino. */
function sumarMeses(iso: string, meses: number): string {
  const [ano, mes, dia] = iso.split("-").map(Number) as [number, number, number]
  const total = ano * 12 + (mes - 1) + meses
  const [a, m] = [Math.floor(total / 12), (total % 12) + 1]
  return `${a}-${dos(m)}-${dos(Math.min(dia, diasDelMes(a, m)))}`
}

function sumarDias(iso: string, dias: number): string {
  const fecha = new Date(`${iso}T00:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

const diasEntre = (desde: string, hasta: string) =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000)

// ───────────────────────────── Números ─────────────────────────────

const PALABRAS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, trescientos: 300,
  cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
}

/** Convierte un valor en letras ("DOSCIENTOS DIEZ MILLONES") a número. undefined si no se entiende. */
function letrasANumero(texto: string): number | undefined {
  let total = 0
  let parcial = 0
  let reconocidas = 0
  for (const palabra of normalizar(texto).split(" ")) {
    if (palabra === "y" || palabra === "de" || palabra === "") continue
    reconocidas++
    const unidad = PALABRAS[palabra]
    if (unidad !== undefined) parcial += unidad
    else if (palabra === "mil") {
      total += (parcial || 1) * 1000
      parcial = 0
    } else if (palabra === "millon" || palabra === "millones") {
      total = (total + parcial || 1) * 1_000_000
      parcial = 0
    } else return undefined
  }
  return reconocidas > 0 ? total + parcial : undefined
}

/** Interpreta "265.000.000" y "120,000.00": el último separador es decimal solo si no agrupa de a tres. */
function cifraANumero(cifra: string): number | undefined {
  const limpia = cifra.replace(/[.,]+$/, "")
  const ultimo = Math.max(limpia.lastIndexOf("."), limpia.lastIndexOf(","))
  const hayAmbos = limpia.includes(".") && limpia.includes(",")
  const decimales = ultimo >= 0 ? limpia.length - ultimo - 1 : 0
  const esDecimal = ultimo >= 0 && (hayAmbos || decimales !== 3)
  const entero = (esDecimal ? limpia.slice(0, ultimo) : limpia).replace(/[.,]/g, "")
  const numero = Number(esDecimal ? `${entero}.${limpia.slice(ultimo + 1)}` : entero)
  return Number.isFinite(numero) ? numero : undefined
}

// ───────────────────────────── Extracción determinista ─────────────────────────────

const parrafos = (texto: string) => texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)
const parrafoCon = (ps: string[], patron: RegExp) => ps.find((p) => patron.test(p))

const PATRON_PARTE = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .&]+?),\s*(?:identificada\s+con\s+)?(NIT|RUC|RTN)\s*([\d.\-]+)/g
const PISTAS_PAIS: [Pais, RegExp][] = [
  ["EC", /ecuador|quito|guayaquil/i],
  ["PE", /per[úu]|lima/i],
  ["PA", /panam[áa]/i],
  ["HN", /honduras|tegucigalpa|san pedro sula/i],
  ["CO", /colombia|bogot[áa]|medell[íi]n|barranquilla|cali\b/i],
]

function extraerParte(texto: string): { cliente: string; tipoId: string; nit: string; tramo: string } | undefined {
  for (const m of texto.matchAll(PATRON_PARTE)) {
    const nombre = (m[1] ?? "").trim()
    if (/PERIFERIA/i.test(nombre)) continue
    const crudo = (m[3] ?? "").replace(/[.\-]+$/, "")
    const nit = m[2] === "NIT" ? crudo.replace(/-\d$/, "").replace(/\D/g, "") : crudo.replace(/\D/g, "")
    // El nombre viene en mayúsculas en el encabezado; la firma lo trae con su grafía normal.
    const escapado = nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const grafias = [...texto.matchAll(new RegExp(escapado, "gi"))].map((g) => g[0])
    const cliente = grafias.find((g) => g !== nombre) ?? nombre
    const tramo = texto.slice(m.index ?? 0, (m.index ?? 0) + 260)
    return { cliente, tipoId: m[2] ?? "", nit, tramo }
  }
  return undefined
}

function inferirPais(tipoId: string, nit: string, tramo: string): { pais: Pais | null; confianza: number; nota?: string } {
  const porTexto = PISTAS_PAIS.find(([, patron]) => patron.test(tramo.split(/PERIFERIA/i)[0] ?? ""))?.[0] ?? null
  let porId: Pais | null = null
  if (tipoId === "NIT") porId = "CO"
  if (tipoId === "RTN") porId = "HN"
  if (tipoId === "RUC") porId = nit.length === 13 ? "EC" : nit.length === 11 ? "PE" : "PA"
  if (porId && porTexto && porId !== porTexto) {
    return { pais: porId, confianza: 0.6, nota: `el identificador sugiere ${porId} pero el domicilio sugiere ${porTexto}` }
  }
  if (porId) return { pais: porId, confianza: porTexto ? 0.95 : 0.9 }
  if (porTexto) return { pais: porTexto, confianza: 0.7, nota: "inferido solo por el domicilio" }
  return { pais: null, confianza: 0 }
}

function extraerObjeto(ps: string[]): string | null {
  const p = parrafoCon(ps, /\bOBJETO\b/)
  if (!p) return null
  const cuerpo = p.replace(/^.*?\bOBJETO\b[.:]?\s*/, "")
  const limpio = cuerpo
    .replace(/^EL CONTRATISTA\s+(?:se obliga a\s+)?(?:ejecutar|prestar[áa]?|realizar[áa]?|suministrar[áa]?)\s+(?:(?:el|la|los|las)\s+)?/i, "")
    .trim()
  if (!limpio) return null
  const texto = limpio.charAt(0).toUpperCase() + limpio.slice(1)
  return texto.length <= 200 ? texto : texto.slice(0, 200).replace(/\s+\S*$/, "")
}

interface ValorExtraido {
  valor: number | null
  moneda: Moneda | null
  indeterminado: boolean
  confValor: number
  confMoneda: number
  notaValor?: string
  notaMoneda?: string
}

const esMoneda = (codigo: string): codigo is Moneda => (MONEDAS as readonly string[]).includes(codigo)

function extraerValor(ps: string[], texto: string, pais: Pais | null): ValorExtraido {
  const p = parrafoCon(ps, /\bVALOR\b/)
  const vacio: ValorExtraido = { valor: null, moneda: null, indeterminado: false, confValor: 0, confMoneda: 0 }
  if (!p) return vacio

  if (/no tiene un valor determinado|valor indeterminado|por demanda|cuant[íi]a indeterminada/i.test(p)) {
    const enDocumento = /\b(COP|USD|PEN|PAB|HNL)\b/.exec(texto)?.[1]
    const porPais: Record<Pais, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "PAB", HN: "HNL" }
    const moneda = enDocumento && esMoneda(enDocumento) ? enDocumento : pais ? porPais[pais] : null
    return {
      valor: 0,
      moneda,
      indeterminado: true,
      confValor: 0.5,
      confMoneda: enDocumento ? 0.8 : moneda ? 0.6 : 0,
      notaValor: "contrato por demanda: el valor se define en cada orden de servicio; se propone 0",
      notaMoneda: enDocumento ? "tomada de otra cláusula del documento" : "inferida por el país",
    }
  }

  const cifra = /\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*)/.exec(p)
  if (!cifra) return vacio
  const [codigo, digitos] = [cifra[1] ?? "", cifra[2] ?? ""]
  if (!esMoneda(codigo)) throw new ErrorClaro(`moneda desconocida en la cláusula de valor: "${codigo}". Monedas admitidas: ${MONEDAS.join(", ")}`)
  const valor = cifraANumero(digitos)
  if (valor === undefined) throw new ErrorClaro(`no se pudo interpretar el valor "${digitos}"`)

  const letras = /([A-ZÁÉÍÓÚÑ ]+?)\s+(?:DE\s+)?(?:PESOS|D[ÓO]LARES|SOLES|BALBOAS|LEMPIRAS)/.exec(p)?.[1]
  const enLetras = letras ? letrasANumero(letras) : undefined
  if (enLetras === undefined) return { ...vacio, valor, moneda: codigo, confValor: 0.85, confMoneda: 0.95, notaValor: "sin valor en letras para contrastar" }
  if (enLetras !== valor) {
    return { ...vacio, valor, moneda: codigo, confValor: 0.4, confMoneda: 0.95, notaValor: `la cifra (${valor}) no coincide con el valor en letras (${enLetras})` }
  }
  return { ...vacio, valor, moneda: codigo, confValor: 0.95, confMoneda: 0.95 }
}

interface PlazoExtraido {
  inicio: string | null
  fin: string | null
  confInicio: number
  confFin: number
  notaInicio?: string
  notaFin?: string
}

const PATRON_FECHA_PLAZO = /(desde|a partir de|hasta)\s+el\s+[a-záéíóúñ ]*\((\d{1,2})\)\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/gi
const PATRON_FIRMA = /firma en[^.]*?(?:a los\s+[a-záéíóúñ ]*\((\d{1,2})\)\s+d[ií]as\s+del\s+mes\s+de|en el mes de)\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i

function extraerPlazo(ps: string[], texto: string): PlazoExtraido {
  const p = parrafoCon(ps, /\bPLAZO\b/) ?? ""
  const plazo: PlazoExtraido = { inicio: null, fin: null, confInicio: 0, confFin: 0 }
  for (const m of p.matchAll(PATRON_FECHA_PLAZO)) {
    const iso = aIso(Number(m[2]), m[3] ?? "", Number(m[4]))
    if ((m[1] ?? "").toLowerCase() === "hasta") Object.assign(plazo, { fin: iso, confFin: 0.95 })
    else Object.assign(plazo, { inicio: iso, confInicio: 0.95 })
  }
  const meses = Number(/\((\d{1,3})\)\s+meses/i.exec(p)?.[1] ?? 0)

  if (!plazo.inicio && /fecha de (?:su )?firma|suscripci[óo]n/i.test(p)) {
    const firma = PATRON_FIRMA.exec(texto)
    if (firma?.[1]) Object.assign(plazo, { inicio: aIso(Number(firma[1]), firma[2] ?? "", Number(firma[3])), confInicio: 0.9 })
    else if (firma) {
      plazo.inicio = aIso(1, firma[2] ?? "", Number(firma[3]))
      plazo.confInicio = 0.8
      plazo.notaInicio = "el documento da mes y año de firma pero no el día; se toma el día 1"
      if (meses > 0) {
        const mesFinal = sumarMeses(plazo.inicio, meses)
        const [ano, mes] = mesFinal.split("-").map(Number) as [number, number]
        plazo.fin = `${ano}-${dos(mes)}-${dos(diasDelMes(ano, mes))}`
        plazo.confFin = 0.5
        const prorroga = /prorrog/i.test(p) ? "; hay prórroga automática" : ""
        plazo.notaFin = `derivada de ${meses} meses desde la firma, sin día de firma: se propone el último día del mes${prorroga}`
      }
      return plazo
    }
  }
  if (plazo.inicio && meses > 0) {
    const derivada = sumarDias(sumarMeses(plazo.inicio, meses), -1)
    if (!plazo.fin) Object.assign(plazo, { fin: derivada, confFin: 0.85, notaFin: `derivada de un plazo de ${meses} meses` })
    else if (plazo.fin !== derivada) {
      plazo.confFin = 0.6
      plazo.notaFin = `la fecha escrita no coincide con el plazo de ${meses} meses (daría ${derivada})`
    }
  }
  if (plazo.inicio && plazo.fin && plazo.fin < plazo.inicio) throw new ErrorClaro(`fecha inválida: el fin (${plazo.fin}) es anterior al inicio (${plazo.inicio})`)
  return plazo
}

const TIPOS_POLIZA: [string, RegExp][] = [
  ["cumplimiento", /cumplimiento/i],
  ["calidad", /calidad/i],
  ["salarios_prestaciones", /salarios|prestaciones sociales/i],
  ["responsabilidad_civil", /responsabilidad civil/i],
  ["buen_manejo_anticipo", /anticipo/i],
  ["estabilidad", /estabilidad/i],
]

function extraerPoliza(ps: string[]): { requiere: boolean; tipos: string; confianza: number; nota?: string } {
  const clausulas = ps.filter((p) => /p[óo]liza|garant[íi]a/i.test(p))
  if (clausulas.length === 0) return { requiere: false, tipos: "", confianza: 0.9 }
  const junto = clausulas.join(" ")
  const tipos = TIPOS_POLIZA.filter(([, patron]) => patron.test(junto)).map(([nombre]) => nombre).join(";")
  const condicionada = /para cada orden|cuyo valor supere|en caso de que|cuando el valor/i.test(junto)
  if (condicionada) return { requiere: true, tipos, confianza: 0.8, nota: "póliza condicionada (por orden de servicio o por monto); verificar cuándo aplica" }
  return { requiere: true, tipos, confianza: tipos ? 0.95 : 0.6, nota: tipos ? undefined : "se menciona garantía pero no se reconoce el tipo" }
}

function extraerDeTexto(texto: string): Extraccion {
  if (!texto.trim()) throw new ErrorClaro("el adjunto está vacío: no hay texto que extraer")
  const titulo = texto.trim().split("\n")[0] ?? ""
  const esOtrosi = /^\s*OTROS[IÍ]/i.test(titulo)
  const ps = parrafos(texto)
  const id = /CONTRATO[^\n]*?No\.\s*([A-Z]{2,5}-\d{4}-\d{1,5})/i.exec(titulo)?.[1] ?? null
  const parte = extraerParte(texto)
  const pais = parte ? inferirPais(parte.tipoId, parte.nit, parte.tramo) : { pais: null, confianza: 0 }
  const objeto = extraerObjeto(ps)
  const valor = extraerValor(ps, texto, pais.pais)
  const plazo = extraerPlazo(ps, texto)
  // Un otrosí no repite las garantías: solo se extrae la póliza de un contrato completo.
  const poliza = esOtrosi ? undefined : extraerPoliza(ps)

  const notas: Partial<Record<Campo, string>> = {}
  const anotar = (campo: Campo, nota: string | undefined) => {
    if (nota) notas[campo] = nota
  }
  anotar("pais", pais.nota)
  anotar("valor", valor.notaValor)
  anotar("moneda", valor.notaMoneda)
  anotar("fecha_inicio", plazo.notaInicio)
  anotar("fecha_fin", plazo.notaFin)
  anotar("requiere_poliza", poliza?.nota)
  if (!id) anotar("id_contrato", "el documento no trae número; al registrar se asignará AUTO-<año>-<secuencia>")

  return {
    tipo_documento: esOtrosi ? "otrosi" : "contrato",
    numero_otrosi: esOtrosi ? (/OTROS[IÍ]\s+No\.\s*(\d+)/i.exec(titulo)?.[1] ?? null) : null,
    valor_indeterminado: valor.indeterminado,
    contrato: {
      id_contrato: id,
      cliente: parte?.cliente ?? null,
      nit_cliente: parte?.nit ?? null,
      pais: pais.pais,
      objeto,
      valor: valor.valor,
      moneda: valor.moneda,
      fecha_inicio: plazo.inicio,
      fecha_fin: plazo.fin,
      requiere_poliza: poliza?.requiere ?? null,
      tipo_poliza: poliza ? poliza.tipos : null,
    },
    confianza: {
      id_contrato: id ? 0.95 : 0,
      cliente: parte ? 0.95 : 0,
      nit_cliente: parte ? 0.95 : 0,
      pais: pais.confianza,
      objeto: objeto ? 0.9 : 0,
      valor: valor.confValor,
      moneda: valor.confMoneda,
      fecha_inicio: plazo.confInicio,
      fecha_fin: plazo.confFin,
      requiere_poliza: poliza?.confianza ?? 0,
      tipo_poliza: poliza?.confianza ?? 0,
    },
    notas,
  }
}

// ───────────────────────────── Buzón ─────────────────────────────

const leerCorreo = (ctx: Ctx, id: string): Promise<Correo> =>
  leerJson(path.join(rutaMensaje(ctx, id), "correo.json"), CorreoSchema, `correo.json de ${id}`)

interface AdjuntoContrato {
  nombre: string
  texto: string
}

/** Busca el adjunto que es un contrato u otrosí mirando su contenido, no su nombre. */
async function buscarContrato(ctx: Ctx, id: string, correo: Correo): Promise<{ adjunto?: AdjuntoContrato; motivo: string }> {
  if (correo.adjuntos.length === 0) return { motivo: "el correo no trae adjuntos" }
  const descartes: string[] = []
  for (const nombre of correo.adjuntos) {
    const seguro = path.basename(nombre)
    if (!/\.(txt|md)$/i.test(seguro)) {
      descartes.push(`${seguro}: formato no legible (solo texto; leer PDF es P1 y no está implementado)`)
      continue
    }
    const texto = await fs.readFile(path.join(rutaMensaje(ctx, id), seguro), "utf8").catch(() => undefined)
    if (texto === undefined) descartes.push(`${seguro}: el adjunto no está en el buzón`)
    else if (!texto.trim()) descartes.push(`${seguro}: el adjunto está vacío`)
    else if (/^\s*(CONTRATO|OTROS[IÍ])/i.test(texto)) return { adjunto: { nombre: seguro, texto }, motivo: "" }
    else descartes.push(`${seguro}: no es un contrato (empieza por "${(texto.trim().split("\n")[0] ?? "").slice(0, 40)}")`)
  }
  return { motivo: `sin adjunto de contrato. ${descartes.join("; ")}` }
}

async function listarMensajes(ctx: Ctx): Promise<string[]> {
  const entradas = await fs.readdir(abs(ctx, FIXTURES, "buzon"), { withFileTypes: true }).catch(() => [])
  return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

const ProcesadosSchema = z.record(z.string(), z.object({ estado: z.string(), id_contrato: z.string().nullable(), ts: z.string() }))
type Procesados = z.infer<typeof ProcesadosSchema>

async function leerProcesados(ctx: Ctx): Promise<Procesados> {
  if (!(await existe(abs(ctx, OUT, "procesados.json")))) return {}
  return leerJson(abs(ctx, OUT, "procesados.json"), ProcesadosSchema, "procesados.json")
}

async function marcarProcesado(ctx: Ctx, id: string, estado: string, idContrato: string | null): Promise<void> {
  const procesados = await leerProcesados(ctx)
  procesados[id] = { estado, id_contrato: idContrato, ts: new Date().toISOString() }
  await fs.mkdir(abs(ctx, OUT), { recursive: true })
  await fs.writeFile(abs(ctx, OUT, "procesados.json"), JSON.stringify(procesados, null, 2))
}

async function abrirMensaje(ctx: Ctx, id: string): Promise<Correo> {
  if (!(await existe(rutaMensaje(ctx, id)))) {
    throw new ErrorClaro(`el mensaje "${id}" no existe en el buzón. Mensajes: ${(await listarMensajes(ctx)).join(", ") || "ninguno"}`)
  }
  return leerCorreo(ctx, id)
}

// ───────────────────────────── Maestro (CSV) ─────────────────────────────

function parsearCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let celda = ""
  let entreComillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i] ?? ""
    if (entreComillas) {
      if (c === '"' && texto[i + 1] === '"') celda += texto[++i]
      else if (c === '"') entreComillas = false
      else celda += c
    } else if (c === '"') entreComillas = true
    else if (c === ",") {
      fila.push(celda)
      celda = ""
    } else if (c === "\n") {
      fila.push(celda)
      filas.push(fila)
      fila = []
      celda = ""
    } else if (c !== "\r") celda += c
  }
  if (celda || fila.length) filas.push([...fila, celda])
  return filas.filter((f) => f.some((v) => v !== ""))
}

const celdaCsv = (valor: string) => (/[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor)

/** RN6: la primera vez copia el fixture a out/sharepoint/. El fixture nunca se escribe. */
async function leerMaestro(ctx: Ctx): Promise<Fila[]> {
  if (!(await existe(rutaMaestro(ctx)))) {
    await fs.mkdir(abs(ctx, SHAREPOINT), { recursive: true })
    await fs.copyFile(abs(ctx, FIXTURES, "maestro-contratos.csv"), rutaMaestro(ctx)).catch(() => {
      throw new ErrorClaro("no se encontró el maestro de contratos en fixtures/reto-02/")
    })
  }
  const [encabezado, ...filas] = parsearCsv(await fs.readFile(rutaMaestro(ctx), "utf8"))
  if (!encabezado || COLUMNAS.some((c) => !encabezado.includes(c))) throw new ErrorClaro("el maestro no tiene los encabezados esperados")
  return filas.map((f) => Object.fromEntries(COLUMNAS.map((c) => [c, f[encabezado.indexOf(c)] ?? ""])) as Fila)
}

async function escribirMaestro(ctx: Ctx, filas: Fila[]): Promise<void> {
  const lineas = [COLUMNAS.join(","), ...filas.map((f) => COLUMNAS.map((c) => celdaCsv(f[c])).join(","))]
  const temporal = `${rutaMaestro(ctx)}.tmp`
  await fs.writeFile(temporal, lineas.join("\n") + "\n")
  await fs.rename(temporal, rutaMaestro(ctx)) // reemplazo atómico: nunca queda un maestro a medio escribir
}

// ───────────────────────────── Validación (RN1–RN5) ─────────────────────────────

const PALABRAS_VACIAS = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "a", "en", "para", "con"])
const tokens = (t: string) => new Set(normalizar(t).split(" ").filter((p) => p && !PALABRAS_VACIAS.has(p)))

function similitud(a: string, b: string): number {
  const [ta, tb] = [tokens(a), tokens(b)]
  if (ta.size === 0 || tb.size === 0) return 0
  const comunes = [...ta].filter((t) => tb.has(t)).length
  return comunes / (ta.size + tb.size - comunes)
}

const ComercialesSchema = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string().default("") }))

async function resolverComercial(ctx: Ctx, correo: Correo): Promise<{ nombre: string; aviso?: string }> {
  const catalogo = await leerJson(abs(ctx, FIXTURES, "comerciales.json"), ComercialesSchema, "comerciales.json")
  const hallado = catalogo.find((c) => c.email.toLowerCase() === correo.de.toLowerCase())
  if (hallado) return { nombre: hallado.nombre }
  return { nombre: "", aviso: `remitente ${correo.de} no está en el catálogo de comerciales; el contrato quedará sin comercial asignado` }
}

function buscarExistente(maestro: Fila[], c: Contrato): Fila | undefined {
  const porId = c.id_contrato ? maestro.find((f) => f.id_contrato === c.id_contrato) : undefined
  if (porId) return porId
  if (!c.nit_cliente || !c.objeto) return undefined
  return maestro.find((f) => f.nit_cliente === c.nit_cliente && similitud(f.objeto, c.objeto ?? "") >= SIMILITUD_OBJETO)
}

const comoTexto = (v: string | number | boolean | null) => (v === null ? "" : String(v))

function diferenciasCon(fila: Fila, c: Contrato): Diferencia[] {
  const campos: Campo[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"]
  return campos.flatMap((campo) => {
    const nuevo = c[campo]
    if (nuevo === null || comoTexto(nuevo) === fila[campo]) return []
    return [{ campo, anterior: fila[campo], nuevo: comoTexto(nuevo) }]
  })
}

function combinar(extraido: Contrato, entrada: ContratoEntradaT | undefined): { contrato: Contrato; corregidos: Campo[] } {
  const contrato = { ...extraido }
  const corregidos: Campo[] = []
  for (const campo of CAMPOS) {
    const recibido = entrada?.[campo]
    if (recibido === undefined || comoTexto(recibido as string | number | boolean).trim() === comoTexto(extraido[campo]).trim()) continue
    Object.assign(contrato, { [campo]: recibido })
    corregidos.push(campo)
  }
  for (const fecha of [contrato.fecha_inicio, contrato.fecha_fin]) {
    if (fecha && !esFechaValida(fecha)) throw new ErrorClaro(`fecha inválida: ${fecha}`)
  }
  if (contrato.requiere_poliza === false) contrato.tipo_poliza = ""
  return { contrato, corregidos }
}

function rechazo(motivo: string, comercial: string, avisos: string[]): Evaluacion {
  const vacio = Object.fromEntries(CAMPOS.map((c) => [c, null])) as unknown as Contrato
  return {
    clasificacion: "rechazado", motivo, id_contrato_existente: null, requiere_revision: [], detalle_revision: [], diferencias: [],
    comercial, avisos, contrato: vacio, tipo_documento: null, numero_otrosi: null, adjunto: null,
  }
}

/** Núcleo compartido por `validar` y `registrar`: ambas deciden exactamente con las mismas reglas. */
async function evaluar(ctx: Ctx, mensajeId: string, entrada: ContratoEntradaT | undefined): Promise<Evaluacion> {
  const correo = await abrirMensaje(ctx, mensajeId)
  const comercial = await resolverComercial(ctx, correo)
  const avisos = comercial.aviso ? [comercial.aviso] : []
  const { adjunto, motivo } = await buscarContrato(ctx, mensajeId, correo)
  if (!adjunto) return rechazo(motivo, comercial.nombre, avisos)

  const extraccion = extraerDeTexto(adjunto.texto)
  const { contrato, corregidos } = combinar(extraccion.contrato, entrada)
  const esOtrosi = extraccion.tipo_documento === "otrosi"
  if (!contrato.cliente && !contrato.objeto) {
    return rechazo("el texto no contiene partes ni objeto identificables", comercial.nombre, avisos)
  }

  const maestro = await leerMaestro(ctx)
  const existente = buscarExistente(maestro, contrato)
  const base = { comercial: comercial.nombre, avisos, contrato, tipo_documento: extraccion.tipo_documento, numero_otrosi: extraccion.numero_otrosi, adjunto: adjunto.nombre }
  if (esOtrosi && !existente) {
    return { ...rechazo(`otrosí del contrato ${contrato.id_contrato ?? "sin número"}, que no está en el maestro: hay que pedir el contrato original`, comercial.nombre, avisos), contrato }
  }

  const revision = new Map<string, Revision>()
  const pedir = (campo: Campo, motivoRevision: string, confianza = extraccion.confianza[campo]) =>
    revision.set(campo, { campo, valor: contrato[campo], confianza, motivo: motivoRevision })
  // RN5: baja confianza. En un otrosí solo se revisan los campos que el documento modifica.
  for (const campo of CAMPOS) {
    if (campo === "id_contrato" && !existente) continue // sin número se asigna AUTO-…
    if (campo === "tipo_poliza" && !contrato.requiere_poliza) continue
    if (existente && contrato[campo] === null) continue
    if (extraccion.confianza[campo] < UMBRAL_CONFIANZA) pedir(campo, extraccion.notas[campo] ?? "no se encontró en el documento o es ambiguo")
  }
  for (const campo of corregidos) pedir(campo, `valor distinto al extraído del documento (${comoTexto(extraccion.contrato[campo]) || "vacío"})`, 0)

  if (!existente) return { ...base, clasificacion: "nuevo", motivo: null, id_contrato_existente: null, requiere_revision: [...revision.keys()], detalle_revision: [...revision.values()], diferencias: [] }

  const diferencias = diferenciasCon(existente, contrato)
  const mismosTerminos = !diferencias.some((d) => ["valor", "fecha_inicio", "fecha_fin"].includes(d.campo))
  if (mismosTerminos && (esOtrosi ? diferencias.length === 0 : true)) {
    // RN1: mismo contrato, mismo valor y mismas fechas. No se escribe nada.
    return { ...base, clasificacion: "duplicado", motivo: `ya está en el maestro como ${existente.id_contrato} con el mismo valor y las mismas fechas`, id_contrato_existente: existente.id_contrato, requiere_revision: [], detalle_revision: [], diferencias: [] }
  }
  // RN2: conflictos con el maestro. La identidad de la contraparte y la moneda no deberían cambiar,
  // y un cambio de términos que no viene en un otrosí es sospechoso.
  for (const d of diferencias) {
    const identidad = ["nit_cliente", "pais", "moneda"].includes(d.campo)
    if (identidad) pedir(d.campo as Campo, `conflicto con el maestro: allí figura "${d.anterior}"`, 0)
    else if (!esOtrosi && ["valor", "fecha_inicio", "fecha_fin"].includes(d.campo)) {
      pedir(d.campo as Campo, `conflicto con el maestro ("${d.anterior}") y el documento no es un otrosí`, 0)
    }
  }
  const aplicables = esOtrosi ? diferencias : diferencias.filter((d) => !["cliente", "objeto"].includes(d.campo))
  return { ...base, clasificacion: "actualizacion", motivo: null, id_contrato_existente: existente.id_contrato, requiere_revision: [...revision.keys()], detalle_revision: [...revision.values()], diferencias: aplicables }
}

// ───────────────────────────── Registro y archivo ─────────────────────────────

const SUFIJO_SOCIETARIO = /\s+(S\.?\s?A\.?\s?S\.?|S\.?\s?A\.?\s?C\.?|S\.?\s?A\.?|S\.\s?de\s?R\.?\s?L\.?|S\.?\s?R\.?\s?L\.?|LTDA\.?|INC\.?|CORP\.?)$/i
const slug = (cliente: string) => normalizar(cliente.replace(SUFIJO_SOCIETARIO, "")).replace(/ /g, "-") || "sin-cliente"

function idAutomatico(maestro: Fila[], ano: string): string {
  const prefijo = `AUTO-${ano}-`
  const usados = maestro.filter((f) => f.id_contrato.startsWith(prefijo)).map((f) => Number(f.id_contrato.slice(prefijo.length)) || 0)
  return `${prefijo}${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`
}

async function archivar(ctx: Ctx, mensajeId: string, adjunto: string, carpeta: string, nombre: string): Promise<string> {
  const relativa = path.join("Contratos", carpeta, `${nombre}${path.extname(adjunto)}`)
  const destino = abs(ctx, SHAREPOINT, relativa)
  await fs.mkdir(path.dirname(destino), { recursive: true })
  await fs.copyFile(path.join(rutaMensaje(ctx, mensajeId), adjunto), destino)
  return posix(relativa)
}

async function anotarHistorial(ctx: Ctx, idContrato: string, accion: string, cambios: Diferencia[], mensajeId: string, archivo: string): Promise<void> {
  const linea = { ts: new Date().toISOString(), id_contrato: idContrato, accion, cambios, mensaje_id: mensajeId, archivo }
  await fs.appendFile(abs(ctx, SHAREPOINT, "historial.jsonl"), JSON.stringify(linea) + "\n")
}

interface Registro {
  id_contrato: string | null
  accion: "insertado" | "actualizado" | "duplicado_sin_escritura" | "rechazado"
  ruta_archivo: string | null
  motivo: string | null
  cambios: Diferencia[]
  avisos: string[]
}

async function insertar(ctx: Ctx, mensajeId: string, e: Evaluacion, maestro: Fila[]): Promise<Registro> {
  const c = e.contrato
  const obligatorios: Campo[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"]
  const faltan = obligatorios.filter((campo) => c[campo] === null)
  if (faltan.length) throw new ErrorClaro(`no se puede registrar: faltan campos obligatorios (${faltan.join(", ")}). Envíalos en "contrato" tras confirmarlos con la analista`)
  const ano = (c.fecha_inicio ?? "").slice(0, 4)
  const id = c.id_contrato ?? idAutomatico(maestro, ano)
  if (maestro.some((f) => f.id_contrato === id)) throw new ErrorClaro(`el id ${id} ya existe en el maestro`)
  const ruta = await archivar(ctx, mensajeId, e.adjunto ?? "", path.join(ano, slug(c.cliente ?? "")), id)
  const fila: Fila = {
    id_contrato: id, cliente: c.cliente ?? "", nit_cliente: c.nit_cliente ?? "", pais: c.pais ?? "", objeto: c.objeto ?? "",
    valor: String(c.valor ?? 0), moneda: c.moneda ?? "", fecha_inicio: c.fecha_inicio ?? "", fecha_fin: c.fecha_fin ?? "",
    requiere_poliza: String(c.requiere_poliza ?? false), tipo_poliza: c.requiere_poliza ? (c.tipo_poliza ?? "") : "",
    estado_poliza: c.requiere_poliza ? "pendiente" : "no_aplica", comercial: e.comercial, ruta_sharepoint: ruta,
    fecha_registro: fechaHoy(), fuente: "buzon",
  }
  await escribirMaestro(ctx, [...maestro, fila])
  const cambios = COLUMNAS.map((col) => ({ campo: col, anterior: "", nuevo: fila[col] }))
  await anotarHistorial(ctx, id, "insertar", cambios, mensajeId, ruta)
  return { id_contrato: id, accion: "insertado", ruta_archivo: `out/sharepoint/${ruta}`, motivo: null, cambios: [], avisos: e.avisos }
}

async function actualizar(ctx: Ctx, mensajeId: string, e: Evaluacion, maestro: Fila[]): Promise<Registro> {
  const fila = maestro.find((f) => f.id_contrato === e.id_contrato_existente)
  if (!fila) throw new ErrorClaro("el contrato a actualizar ya no está en el maestro")
  const cambios = [...e.diferencias]
  for (const d of e.diferencias) Object.assign(fila, { [d.campo]: d.nuevo })
  // Si cambia el plazo de un contrato con póliza, la póliza vigente ya no cubre: vuelve a quedar pendiente.
  const cambiaPlazo = e.diferencias.some((d) => d.campo === "fecha_fin")
  if (cambiaPlazo && fila.requiere_poliza === "true" && fila.estado_poliza !== "pendiente") {
    cambios.push({ campo: "estado_poliza", anterior: fila.estado_poliza, nuevo: "pendiente" })
    fila.estado_poliza = "pendiente"
  }
  const sufijo = e.tipo_documento === "otrosi" ? `-otrosi-${e.numero_otrosi ?? mensajeId}` : `-actualizacion-${mensajeId}`
  const carpeta = path.join(fila.fecha_inicio.slice(0, 4), slug(fila.cliente))
  const ruta = await archivar(ctx, mensajeId, e.adjunto ?? "", carpeta, `${fila.id_contrato}${sufijo}`)
  await escribirMaestro(ctx, maestro)
  await anotarHistorial(ctx, fila.id_contrato, "actualizar", cambios, mensajeId, ruta)
  return { id_contrato: fila.id_contrato, accion: "actualizado", ruta_archivo: `out/sharepoint/${ruta}`, motivo: null, cambios, avisos: e.avisos }
}

// ───────────────────────────── Alertas ─────────────────────────────

interface Alerta {
  id_contrato: string
  cliente: string
  detalle: string
}

function textoAlertas(hoy: string, vencen: Alerta[], polizas: Alerta[], registrados: Alerta[]): string {
  const seccion = (titulo: string, items: Alerta[], vacio: string) => [
    `## ${titulo}`,
    "",
    ...(items.length ? ["| Contrato | Cliente | Detalle |", "|---|---|---|", ...items.map((a) => `| ${a.id_contrato} | ${a.cliente} | ${a.detalle} |`)] : [vacio]),
    "",
  ]
  return [
    "# Alertas de contratos",
    "",
    `Fecha de referencia: ${hoy}`,
    "",
    ...seccion(`Contratos vencidos o que vencen en ${DIAS_ALERTA} días o menos`, vencen, "Ninguno."),
    ...seccion("Pólizas exigidas que no están vigentes", polizas, "Ninguna."),
    ...seccion(`Contratos registrados después del corte del ${FECHA_CORTE}`, registrados, "Ninguno: el vacío de registro sigue abierto."),
  ].join("\n")
}

// ───────────────────────────── Herramientas exportadas ─────────────────────────────

export const leer_buzon = {
  description:
    "Lista los mensajes del buzón de contratos que aún no se han procesado, con remitente, asunto, adjuntos y si traen un contrato; es el primer paso.",
  args: {},
  async execute(_args: Record<string, never>, ctx: Ctx): Promise<string> {
    return ejecutar("leer_buzon", null, ctx, async () => {
      const procesados = await leerProcesados(ctx)
      const ids = await listarMensajes(ctx)
      const mensajes = []
      for (const id of ids.filter((i) => !procesados[i])) {
        try {
          const correo = await leerCorreo(ctx, id)
          const { adjunto, motivo } = await buscarContrato(ctx, id, correo)
          const base = { id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos, tiene_contrato: Boolean(adjunto) }
          mensajes.push(adjunto ? base : { ...base, clasificacion: "rechazado", motivo })
        } catch (e) {
          mensajes.push({ id, tiene_contrato: false, clasificacion: "rechazado", motivo: e instanceof Error ? e.message : "mensaje ilegible" })
        }
      }
      const data = { mensajes, pendientes: mensajes.length, ya_procesados: ids.length - mensajes.length }
      return { data, resumen: `${mensajes.length} pendientes, ${data.ya_procesados} ya procesados` }
    })
  },
}

export const extraer = {
  description:
    "Lee el contrato u otrosí adjunto a un mensaje y devuelve sus datos estructurados con un nivel de confianza por campo; no escribe nada.",
  args: {
    mensaje_id: MensajeId.describe("Id del mensaje en el buzón, p. ej. msg-001"),
  },
  async execute(args: { mensaje_id: string }, ctx: Ctx): Promise<string> {
    return ejecutar("extraer", args.mensaje_id, ctx, async () => {
      const correo = await abrirMensaje(ctx, args.mensaje_id)
      const { adjunto, motivo } = await buscarContrato(ctx, args.mensaje_id, correo)
      if (!adjunto) throw new ErrorClaro(`el mensaje ${args.mensaje_id} no trae un contrato: ${motivo}`)
      const e = extraerDeTexto(adjunto.texto)
      const data = { ...e.contrato, valor_indeterminado: e.valor_indeterminado, tipo_documento: e.tipo_documento, adjunto: adjunto.nombre, confianza: e.confianza, notas: e.notas }
      const bajos = CAMPOS.filter((c) => e.contrato[c] !== null && e.confianza[c] < UMBRAL_CONFIANZA)
      return { data, resumen: `${e.tipo_documento} ${e.contrato.id_contrato ?? "sin número"}; confianza baja en: ${bajos.join(", ") || "ninguno"}` }
    })
  },
}

export const validar = {
  description:
    "Clasifica el contrato de un mensaje como nuevo, actualizacion, duplicado o rechazado contra el maestro, e indica qué campos requieren revisión humana; no escribe nada.",
  args: {
    mensaje_id: MensajeId.describe("Id del mensaje en el buzón"),
    contrato: ContratoEntrada.optional().describe(
      "Contrato devuelto por contratos_extraer. Opcional: lo que falte se toma del documento. Un valor distinto al del documento pasa a revisión.",
    ),
  },
  async execute(args: { mensaje_id: string; contrato?: ContratoEntradaT }, ctx: Ctx): Promise<string> {
    return ejecutar("validar", args.mensaje_id, ctx, async () => {
      const e = await evaluar(ctx, args.mensaje_id, args.contrato)
      const data = {
        clasificacion: e.clasificacion,
        motivo: e.motivo,
        id_contrato_existente: e.id_contrato_existente,
        requiere_revision: e.requiere_revision,
        detalle_revision: e.detalle_revision,
        diferencias: e.diferencias,
        comercial: e.comercial || null,
        avisos: e.avisos,
        contrato: e.contrato,
      }
      return { data, resumen: `${e.clasificacion}${e.requiere_revision.length ? `; revisar: ${e.requiere_revision.join(", ")}` : ""}${e.motivo ? `; ${e.motivo}` : ""}` }
    })
  },
}

export const registrar = {
  description:
    "Cierra un mensaje: inserta o actualiza el contrato en el maestro, archiva el documento y deja historial; si hay campos en revisión exige confirmado=true, y no escribe nada en duplicados ni rechazados.",
  args: {
    mensaje_id: MensajeId.describe("Id del mensaje en el buzón"),
    contrato: ContratoEntrada.optional().describe(
      "Contrato a registrar. Opcional: lo que falte se toma del documento. Envía aquí solo las correcciones que la analista haya dictado.",
    ),
    confirmado: z.boolean().optional().describe("true únicamente si la analista confirmó de forma explícita los campos en revisión en su último mensaje"),
  },
  async execute(args: { mensaje_id: string; contrato?: ContratoEntradaT; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    return ejecutar<Registro>("registrar", args.mensaje_id, ctx, async () => {
      if ((await leerProcesados(ctx))[args.mensaje_id]) throw new ErrorClaro(`el mensaje ${args.mensaje_id} ya fue procesado; no se registra dos veces`)
      const e = await evaluar(ctx, args.mensaje_id, args.contrato)
      if (e.clasificacion === "rechazado" || e.clasificacion === "duplicado") {
        const accion = e.clasificacion === "rechazado" ? "rechazado" : "duplicado_sin_escritura"
        await marcarProcesado(ctx, args.mensaje_id, e.clasificacion, e.id_contrato_existente)
        const data: Registro = { id_contrato: e.id_contrato_existente, accion, ruta_archivo: null, motivo: e.motivo, cambios: [], avisos: e.avisos }
        return { data, resumen: `${accion}: ${e.motivo ?? ""}` }
      }
      if (e.requiere_revision.length > 0 && args.confirmado !== true) {
        throw new ErrorClaro(`requiere revisión: ${e.requiere_revision.join(", ")}`)
      }
      const maestro = await leerMaestro(ctx)
      const data = e.clasificacion === "nuevo" ? await insertar(ctx, args.mensaje_id, e, maestro) : await actualizar(ctx, args.mensaje_id, e, maestro)
      await marcarProcesado(ctx, args.mensaje_id, e.clasificacion, data.id_contrato)
      const confirmados = e.requiere_revision.length ? `; confirmados por humano: ${e.requiere_revision.join(", ")}` : ""
      return { data, resumen: `${data.accion} ${data.id_contrato}${confirmados}` }
    })
  },
}

export const alertas = {
  description:
    "Genera out/alertas.md con los contratos vencidos o que vencen en 60 días o menos, las pólizas exigidas que no están vigentes y los contratos registrados después del corte.",
  args: {
    hoy: FechaIso.describe("Fecha de referencia YYYY-MM-DD para calcular vencimientos"),
  },
  async execute(args: { hoy: string }, ctx: Ctx): Promise<string> {
    return ejecutar("alertas", null, ctx, async () => {
      if (!esFechaValida(args.hoy)) throw new ErrorClaro(`fecha inválida: ${args.hoy}`)
      const maestro = await leerMaestro(ctx)
      const vencen = maestro
        .filter((f) => esFechaValida(f.fecha_fin) && diasEntre(args.hoy, f.fecha_fin) <= DIAS_ALERTA)
        .sort((a, b) => a.fecha_fin.localeCompare(b.fecha_fin))
        .map((f) => {
          const dias = diasEntre(args.hoy, f.fecha_fin)
          const estado = dias < 0 ? `VENCIDO hace ${-dias} días` : `vence en ${dias} días`
          return { id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias_restantes: dias, detalle: `${estado} (${f.fecha_fin})` }
        })
      const polizas_pendientes = maestro
        .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
        .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, detalle: `${f.tipo_poliza || "tipo sin definir"}: ${f.estado_poliza}` }))
      const registrados_desde_corte = maestro
        .filter((f) => f.fecha_registro > FECHA_CORTE)
        .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_registro: f.fecha_registro, detalle: `registrado el ${f.fecha_registro} (${f.fuente})` }))
      await fs.mkdir(abs(ctx, OUT), { recursive: true })
      await fs.writeFile(abs(ctx, OUT, "alertas.md"), textoAlertas(args.hoy, vencen, polizas_pendientes, registrados_desde_corte))
      const data = { ruta: "out/alertas.md", hoy: args.hoy, vencen, polizas_pendientes, registrados_desde_corte }
      return { data, resumen: `${vencen.length} vencen o vencidos, ${polizas_pendientes.length} pólizas pendientes, ${registrados_desde_corte.length} registrados desde el corte` }
    })
  },
}

export const solicitar_confirmacion = {
  description:
    "Registra que el agente necesita la confirmación de la analista antes de registrar un mensaje con campos en revisión; llámala justo antes de cerrar el turno con la pregunta.",
  args: {
    mensaje_id: MensajeId.describe("Mensaje cuyo registro queda a la espera de confirmación"),
    pregunta: z.string().min(5).max(400).describe("Pregunta de sí o no que verá la analista, con los campos y valores a confirmar"),
  },
  async execute(args: { mensaje_id: string; pregunta: string }, ctx: Ctx): Promise<string> {
    return ejecutar("solicitar_confirmacion", args.mensaje_id, ctx, async () => {
      await abrirMensaje(ctx, args.mensaje_id)
      const data = { mensaje_id: args.mensaje_id, accion: "registrar", pregunta: args.pregunta, estado: "esperando_confirmacion" }
      return { data, resumen: `confirmación pendiente para registrar ${args.mensaje_id}` }
    })
  },
}
