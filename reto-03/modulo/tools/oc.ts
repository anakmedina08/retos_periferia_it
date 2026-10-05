/**
 * Herramientas del agente "Órdenes de compra".
 *
 * Cada export es un objeto { description, args, execute } y el modelo lo ve como `oc_<export>`.
 * Reglas del contrato (PRD 6.2):
 *   - `execute` devuelve SIEMPRE un string JSON `{ ok: true, data }` o `{ ok: false, error }`.
 *   - Ninguna herramienta lanza: todo pasa por `ejecutar()`, que captura y registra en out/log.jsonl.
 *   - Las rutas se resuelven desde `ctx.directory`; nunca absolutas, nunca shell.
 *   - Los argumentos `paquete`, `derivados` y `payload` existen por contrato, pero NO son fuente de
 *     valores: cada herramienta relee el caso y recalcula. El modelo no puede alterar un monto.
 *
 * Solo depende de zod, pdf-lib y del adaptador SAP (`../sap/`), para empaquetarse en `modulo/`.
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { z } from "zod"
import { OrdenCompraSchema, type OrdenCompra, type SapAdapter } from "../sap/adapter.ts"
import { crearSapMock } from "../sap/mock.ts"

// ───────────────────────────── Tipos y constantes ─────────────────────────────

export interface Ctx {
  directory: string
  sessionId: string
}

const FIXTURES = path.join("fixtures", "reto-03")
const OUT = "out"
const TOLERANCIA_COTIZACION = 0.02 // RC5
const TOLERANCIA_ARITMETICA = 1 // RC10: una unidad monetaria
const MONEDA_DE_TOPES = "COP"
const SOCIEDAD = "1000"
const ORGANIZACION_COMPRAS = "1000"
const COLUMNAS_CONTROL = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

/** Punto único de sustitución: en producción aquí se devuelve el adaptador SAP real. */
const sapDe = (ctx: Ctx): SapAdapter => crearSapMock(ctx.directory)

const CasoId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "el caso solo admite minúsculas, números y guiones")
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "se espera una fecha YYYY-MM-DD")
const Monto = z.number({ error: "debe ser un número" }).finite().nonnegative()

const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().default(""),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: Monto.positive(),
  valor_unitario: Monto,
  valor_total: Monto,
  moneda: z.string().min(1),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: Fecha,
})
type Solicitud = z.infer<typeof SolicitudSchema>

const CorreoSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() })
const AprobacionSchema = z.object({ de: z.string(), para: z.string().default(""), fecha: z.string(), asunto: z.string().default(""), cuerpo: z.string().default("") })
type AprobacionCruda = z.infer<typeof AprobacionSchema>

const ProveedorSchema = z.object({
  codigo_sap: z.string(), nit: z.string(), nombre: z.string(),
  condiciones_pago_default: z.string(), indicador_iva_default: z.string(), activo: z.boolean(),
})
type Proveedor = z.infer<typeof ProveedorSchema>
const CentroSchema = z.object({
  centro_costo: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().default(""), tope: z.number() })),
})
type Centro = z.infer<typeof CentroSchema>
const CodigoSchema = z.object({ codigo: z.string(), descripcion: z.string().default("") })

interface Cotizacion {
  referencia: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  fecha: string | null
  validez_hasta: string | null
  texto: string
}
interface Aprobacion {
  de: string
  fecha: string
  aprobado: boolean
  texto: string
}
interface Factura {
  numero: string
  fecha: string
  total: number
}
interface Paquete {
  correo: z.infer<typeof CorreoSchema>
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  faltantes: string[]
}

interface Bloqueo {
  regla: string
  detalle: string
  accion_sugerida: string
}
interface Confirmacion {
  regla: string
  detalle: string
}
interface Derivado {
  valor: string
  fuente: string
  motivo: string
}
interface Validacion {
  apta: boolean
  bloqueos: Bloqueo[]
  confirmaciones: Confirmacion[]
  derivados: Record<string, Derivado>
  retroactiva: boolean
  avisos: string[]
}
interface Evaluacion {
  paquete: Paquete
  validacion: Validacion
  proveedor: Proveedor | undefined
  aprobacionCruda: AprobacionCruda | null
}
interface Traza {
  campo: string
  valor: string | number | null
  fuente: string
  detalle?: string
}

/** Error esperado: su mensaje es apto para mostrarse al usuario. */
class ErrorClaro extends Error {}

// ───────────────────────────── Utilidades base ─────────────────────────────

const abs = (ctx: Ctx, ...partes: string[]) => path.join(ctx.directory, ...partes)
const rutaCaso = (ctx: Ctx, caso: string) => abs(ctx, FIXTURES, "solicitudes", caso)
const rutaSalida = (ctx: Ctx, caso: string) => abs(ctx, OUT, caso)
const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
const normalizar = (t: string) => sinTildes(t).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
const dinero = (n: number, moneda: string) => `${moneda} ${n.toLocaleString("es-CO")}`
/** NIT sin puntos ni dígito de verificación: "900.555.111-2" → "900555111". */
const normalizarNit = (nit: string) => nit.trim().replace(/-\d$/, "").replace(/\D/g, "")

async function existe(ruta: string): Promise<boolean> {
  try {
    await fs.access(ruta)
    return true
  } catch {
    return false
  }
}

/** Lee y valida un JSON. Devuelve null si el archivo no existe; lanza ErrorClaro si está dañado. */
async function leerJsonOpcional<T>(ruta: string, esquema: z.ZodType<T>, nombre: string, queHacer: string): Promise<T | null> {
  const crudo = await fs.readFile(ruta, "utf8").catch(() => null)
  if (crudo === null) return null
  let json: unknown
  try {
    json = JSON.parse(crudo)
  } catch {
    throw new ErrorClaro(`${nombre} está malformado: no es JSON válido. ${queHacer}`)
  }
  const validado = esquema.safeParse(json)
  if (!validado.success) {
    const problema = validado.error.issues[0]
    throw new ErrorClaro(`${nombre} tiene un dato inválido en "${problema?.path.join(".")}" (${problema?.message}). ${queHacer}`)
  }
  return validado.data
}

async function leerMaestro<T>(ctx: Ctx, archivo: string, esquema: z.ZodType<T>): Promise<T[]> {
  const datos = await leerJsonOpcional(abs(ctx, FIXTURES, "maestros", archivo), z.array(esquema), `el maestro ${archivo}`, "Avisa a quien administra los maestros.")
  if (!datos) throw new ErrorClaro(`no se encontró el maestro ${archivo}`)
  return datos
}

async function registrarLog(ctx: Ctx, herramienta: string, caso: string, ok: boolean, resumen: string): Promise<void> {
  try {
    await fs.mkdir(abs(ctx, OUT), { recursive: true })
    const linea = { ts: new Date().toISOString(), herramienta, caso, ok, resumen, sessionId: ctx.sessionId }
    await fs.appendFile(abs(ctx, OUT, "log.jsonl"), JSON.stringify(linea) + "\n")
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

/** Envoltura común: valida que el caso exista, captura todo error y deja traza. Nunca lanza. */
async function ejecutar<T>(herramienta: string, caso: string, ctx: Ctx, trabajo: () => Promise<{ data: T; resumen: string }>): Promise<string> {
  try {
    if (!(await existe(rutaCaso(ctx, caso)))) {
      const disponibles = (await fs.readdir(abs(ctx, FIXTURES, "solicitudes")).catch(() => [])).sort()
      throw new ErrorClaro(`el caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ") || "ninguno"}`)
    }
    const { data, resumen } = await trabajo()
    await registrarLog(ctx, herramienta, caso, true, resumen)
    return JSON.stringify({ ok: true, data })
  } catch (e) {
    const claro = e instanceof ErrorClaro
    const error = claro ? e.message : `error interno en ${herramienta}; revisa out/log.jsonl`
    await registrarLog(ctx, herramienta, caso, false, claro ? error : `${error} (${e instanceof Error ? e.message : String(e)})`)
    return JSON.stringify({ ok: false, error })
  }
}

// ───────────────────────────── Lectura del paquete (HU-1) ─────────────────────────────

/** "11.400.000" y "1,250.50": el último separador es decimal solo si no agrupa de a tres. */
function cifraANumero(cifra: string): number | undefined {
  const limpia = cifra.replace(/[.,]+$/, "")
  const ultimo = Math.max(limpia.lastIndexOf("."), limpia.lastIndexOf(","))
  const hayAmbos = limpia.includes(".") && limpia.includes(",")
  const esDecimal = ultimo >= 0 && (hayAmbos || limpia.length - ultimo - 1 !== 3)
  const entero = (esDecimal ? limpia.slice(0, ultimo) : limpia).replace(/[.,]/g, "")
  const numero = Number(esDecimal ? `${entero}.${limpia.slice(ultimo + 1)}` : entero)
  return limpia && Number.isFinite(numero) ? numero : undefined
}

function sumarDias(iso: string, dias: number): string {
  const fecha = new Date(`${iso}T00:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

const campo = (texto: string, etiqueta: RegExp) => etiqueta.exec(texto)?.[1]?.trim()

function leerTotal(texto: string): { total: number; moneda: string } | undefined {
  const m = /^\s*TOTAL[^:\n]*:\s*([A-Z]{3})\s*\$?\s*([\d.,]+)/im.exec(texto)
  const total = m ? cifraANumero(m[2] ?? "") : undefined
  return m && total !== undefined ? { total, moneda: m[1] ?? "" } : undefined
}

function normalizarCotizacion(texto: string): Cotizacion {
  const total = leerTotal(texto)
  if (!total) throw new ErrorClaro("la cotización no trae un TOTAL numérico legible. Pide al solicitante la cotización con el total y la moneda.")
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m) ?? null
  const diasValidez = Number(campo(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i) ?? NaN)
  const nit = campo(texto, /^NIT:\s*([\d.\-]+)/m)
  return {
    referencia: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/m) ?? null,
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: total.total,
    moneda: total.moneda,
    fecha,
    validez_hasta: fecha && Number.isFinite(diasValidez) ? sumarDias(fecha, diasValidez) : null,
    texto: texto.slice(0, 1500),
  }
}

function normalizarFactura(texto: string): Factura {
  const fecha = campo(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const total = leerTotal(texto)
  if (!fecha || !total) throw new ErrorClaro("la factura no trae fecha de emisión o total legibles. Pide la factura completa.")
  return { numero: campo(texto, /No\.\s*(\S+)/) ?? "sin número", fecha, total: total.total }
}

/** "Aprobado" cuenta; "No aprobado", "rechazado" o "pendiente de aprobación" no. */
function estaAprobado(cuerpo: string): boolean {
  const texto = normalizar(cuerpo)
  return /\baprobad[oa]\b/.test(texto) && !/\b(no|sin) (esta |fue |queda )?aprobad[oa]\b|\brechazad[oa]\b|\bno apruebo\b/.test(texto)
}

async function leerTexto(ctx: Ctx, caso: string, archivo: string): Promise<string | null> {
  const texto = await fs.readFile(path.join(rutaCaso(ctx, caso), archivo), "utf8").catch(() => null)
  return texto && texto.trim() ? texto : null
}

async function leerPaquete(ctx: Ctx, caso: string): Promise<{ paquete: Paquete; aprobacionCruda: AprobacionCruda | null }> {
  const carpeta = rutaCaso(ctx, caso)
  const pedir = "Pide al solicitante reenviar el archivo."
  const correo = await leerJsonOpcional(path.join(carpeta, "correo.json"), CorreoSchema, "correo.json", pedir)
  const solicitud = await leerJsonOpcional(path.join(carpeta, "solicitud.json"), SolicitudSchema, "solicitud.json", "Pide al solicitante corregir el Excel de solicitud.")
  if (!correo) throw new ErrorClaro("paquete incompleto: falta correo.json. No hay correo de entrada que procesar.")
  if (!solicitud) throw new ErrorClaro("paquete incompleto: falta la solicitud de compra (solicitud.json). Pide al solicitante el Excel de solicitud.")
  const aprobacionCruda = await leerJsonOpcional(path.join(carpeta, "aprobacion.json"), AprobacionSchema, "aprobacion.json", pedir)
  const textoCotizacion = await leerTexto(ctx, caso, "cotizacion.txt")
  const textoFactura = await leerTexto(ctx, caso, "factura.txt")
  const faltantes = [...(textoCotizacion ? [] : ["cotizacion"]), ...(aprobacionCruda ? [] : ["aprobacion"])]
  const paquete: Paquete = {
    correo,
    solicitud,
    cotizacion: textoCotizacion ? normalizarCotizacion(textoCotizacion) : null,
    aprobacion: aprobacionCruda && {
      de: aprobacionCruda.de.toLowerCase(),
      fecha: aprobacionCruda.fecha,
      aprobado: estaAprobado(aprobacionCruda.cuerpo),
      texto: aprobacionCruda.cuerpo.slice(0, 1500),
    },
    factura: textoFactura ? normalizarFactura(textoFactura) : null,
    faltantes,
  }
  return { paquete, aprobacionCruda }
}

// ───────────────────────────── Controles RC1–RC10 (HU-2) ─────────────────────────────

interface Hallazgos {
  bloqueos: Bloqueo[]
  confirmaciones: Confirmacion[]
  derivados: Record<string, Derivado>
  avisos: string[]
}

/** RC1: el proveedor existe (por NIT; sin NIT, por nombre normalizado) y está activo. */
async function controlProveedor(s: Solicitud, proveedores: Proveedor[], sap: SapAdapter, h: Hallazgos): Promise<Proveedor | undefined> {
  const nit = s.proveedor_nit ? normalizarNit(s.proveedor_nit) : undefined
  const proveedor = nit ? proveedores.find((p) => p.nit === nit) : proveedores.find((p) => normalizar(p.nombre) === normalizar(s.proveedor_nombre))
  if (!proveedor) {
    const criterio = nit ? `NIT ${nit}` : `nombre "${s.proveedor_nombre}"`
    h.bloqueos.push({ regla: "RC1", detalle: `el proveedor ${s.proveedor_nombre} no existe en el maestro (buscado por ${criterio})`, accion_sugerida: "solicitar a datos maestros la creación del proveedor en SAP y reenviar la solicitud" })
    return undefined
  }
  if (!nit) h.derivados.proveedor_nit = { valor: proveedor.nit, fuente: "maestro.proveedores", motivo: "la solicitud no trae NIT; se identificó al proveedor por nombre" }
  const enSap = await sap.consultarProveedor(proveedor.nit)
  if (!enSap || !enSap.activo) {
    h.bloqueos.push({ regla: "RC1", detalle: `el proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo`, accion_sugerida: "pedir a datos maestros reactivarlo o elegir otro proveedor" })
  }
  return proveedor
}

/** RC4: la subárea pertenece al centro de costo. */
function controlCentro(s: Solicitud, centros: Centro[], h: Hallazgos): Centro | undefined {
  const centro = centros.find((c) => c.centro_costo === s.centro_costo)
  if (!centro) {
    h.bloqueos.push({ regla: "RC4", detalle: `el centro de costo ${s.centro_costo} no existe en el maestro`, accion_sugerida: `corregir el centro de costo. Centros válidos: ${centros.map((c) => c.centro_costo).join(", ")}` })
    return undefined
  }
  if (!centro.subareas.includes(s.subarea)) {
    h.bloqueos.push({ regla: "RC4", detalle: `la subárea "${s.subarea}" no pertenece a ${s.centro_costo}`, accion_sugerida: `corregir la subárea. Subáreas de ${s.centro_costo}: ${centro.subareas.join(", ")}` })
  }
  return centro
}

/** Quién del centro puede aprobar este monto: es la acción que la analista necesita para destrabar. */
function quienPuedeAprobar(centro: Centro, valor: number, moneda: string): string {
  const capaces = centro.aprobadores.filter((a) => a.tope >= valor)
  if (capaces.length) return `pedir la aprobación a ${capaces.map((a) => `${a.nombre || a.email} <${a.email}> (tope ${dinero(a.tope, MONEDA_DE_TOPES)})`).join(" o ")}`
  const maximo = Math.max(0, ...centro.aprobadores.map((a) => a.tope))
  return `ningún aprobador de ${centro.centro_costo} tiene tope para ${dinero(valor, moneda)} (máximo ${dinero(maximo, MONEDA_DE_TOPES)}): escalar a la dirección para definir quién aprueba este monto`
}

/** RC2 y RC3: la aprobación existe, dice "Aprobado", viene de un aprobador del centro y cubre el monto. */
function controlAprobacion(p: Paquete, centro: Centro | undefined, h: Hallazgos): void {
  const s = p.solicitud
  if (!p.aprobacion) {
    h.bloqueos.push({ regla: "RC2", detalle: "el paquete no trae el correo de aprobación", accion_sugerida: "pedir al solicitante el correo de aprobación de su líder" })
    return
  }
  if (!p.aprobacion.aprobado) {
    h.bloqueos.push({ regla: "RC2", detalle: `el correo de ${p.aprobacion.de} no contiene una aprobación ("Aprobado")`, accion_sugerida: "pedir al líder una respuesta explícita de aprobación" })
  }
  if (!centro) return
  const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === p.aprobacion?.de)
  if (!aprobador) {
    h.bloqueos.push({ regla: "RC2", detalle: `${p.aprobacion.de} no es aprobador del centro ${s.centro_costo}`, accion_sugerida: quienPuedeAprobar(centro, s.valor_total, s.moneda) })
    return
  }
  if (s.moneda !== MONEDA_DE_TOPES) {
    h.bloqueos.push({ regla: "RC3", detalle: `los topes están en ${MONEDA_DE_TOPES} y la solicitud en ${s.moneda}: no se puede verificar la autoridad del aprobador`, accion_sugerida: "definir la tasa de cambio aplicable con contabilidad" })
  } else if (s.valor_total > aprobador.tope) {
    h.bloqueos.push({ regla: "RC3", detalle: `${dinero(s.valor_total, s.moneda)} supera el tope de ${aprobador.email} (${dinero(aprobador.tope, MONEDA_DE_TOPES)})`, accion_sugerida: quienPuedeAprobar(centro, s.valor_total, s.moneda) })
  }
  // RC9: la aprobación no puede ser anterior a la solicitud.
  if (p.aprobacion.fecha.slice(0, 10) < s.fecha_solicitud) {
    h.confirmaciones.push({ regla: "RC9", detalle: `la aprobación (${p.aprobacion.fecha.slice(0, 10)}) es anterior a la solicitud (${s.fecha_solicitud})` })
  }
}

/** RC5: cotización y solicitud coinciden dentro del 2 %. */
function controlCotizacion(p: Paquete, proveedor: Proveedor | undefined, h: Hallazgos): void {
  const s = p.solicitud
  if (!p.cotizacion) {
    h.confirmaciones.push({ regla: "RC5", detalle: "el paquete no trae cotización: no se puede contrastar el valor solicitado" })
    return
  }
  if (p.cotizacion.moneda !== s.moneda) {
    h.confirmaciones.push({ regla: "RC5", detalle: `la cotización está en ${p.cotizacion.moneda} y la solicitud en ${s.moneda}: los valores no son comparables` })
  } else if (s.valor_total > 0) {
    const diferencia = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
    if (diferencia > TOLERANCIA_COTIZACION) {
      const porcentaje = (diferencia * 100).toFixed(1).replace(".", ",")
      h.confirmaciones.push({ regla: "RC5", detalle: `la cotización (${dinero(p.cotizacion.total, s.moneda)}) difiere ${porcentaje} % de la solicitud (${dinero(s.valor_total, s.moneda)}); la OC se crearía por el valor de la solicitud` })
    }
  }
  if (proveedor && p.cotizacion.nit && p.cotizacion.nit !== proveedor.nit) h.avisos.push(`la cotización es de otro NIT (${p.cotizacion.nit}) distinto al del proveedor de la solicitud (${proveedor.nit})`)
  if (p.cotizacion.validez_hasta && p.cotizacion.validez_hasta < s.fecha_solicitud) h.avisos.push(`la cotización venció el ${p.cotizacion.validez_hasta}, antes de la solicitud`)
}

/** RC6 y RC7: IVA y condiciones de pago ausentes se derivan del proveedor. Los códigos deben existir. */
function controlDerivados(s: Solicitud, proveedor: Proveedor | undefined, ivas: string[], condiciones: string[], h: Hallazgos): void {
  if (!s.indicador_iva && proveedor) {
    h.derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores", motivo: "la solicitud no informa indicador de IVA" }
    h.confirmaciones.push({ regla: "RC6", detalle: `la solicitud no informa indicador de IVA; se propone ${proveedor.indicador_iva_default}, el del proveedor por defecto` })
  }
  if (!s.condiciones_pago && proveedor) {
    h.derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores", motivo: "la solicitud no informa condiciones de pago" }
  }
  const iva = s.indicador_iva ?? h.derivados.indicador_iva?.valor
  const pago = s.condiciones_pago ?? h.derivados.condiciones_pago?.valor
  if (iva && !ivas.includes(iva)) h.bloqueos.push({ regla: "M1", detalle: `el indicador de IVA "${iva}" no existe en el maestro`, accion_sugerida: `usar uno de: ${ivas.join(", ")}` })
  if (pago && !condiciones.includes(pago)) h.bloqueos.push({ regla: "M2", detalle: `la condición de pago "${pago}" no existe en el maestro`, accion_sugerida: `usar una de: ${condiciones.join(", ")}` })
}

async function evaluar(ctx: Ctx, caso: string): Promise<Evaluacion> {
  const { paquete, aprobacionCruda } = await leerPaquete(ctx, caso)
  const s = paquete.solicitud
  const [proveedores, centros, ivas, condiciones] = await Promise.all([
    leerMaestro(ctx, "proveedores.json", ProveedorSchema),
    leerMaestro(ctx, "centros-costo.json", CentroSchema),
    leerMaestro(ctx, "indicadores-iva.json", CodigoSchema),
    leerMaestro(ctx, "condiciones-pago.json", CodigoSchema),
  ])
  const h: Hallazgos = { bloqueos: [], confirmaciones: [], derivados: {}, avisos: [] }

  // RC10: la aritmética de la solicitud debe cuadrar antes de mirar cualquier otra cosa.
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    h.bloqueos.push({ regla: "RC10", detalle: `cantidad × valor unitario = ${dinero(calculado, s.moneda)}, pero el valor total dice ${dinero(s.valor_total, s.moneda)}`, accion_sugerida: "pedir al solicitante corregir el Excel de solicitud" })
  }
  if (!OrdenCompraSchema.shape.moneda.safeParse(s.moneda).success) {
    h.bloqueos.push({ regla: "M3", detalle: `la moneda "${s.moneda}" no está admitida en SAP para este flujo`, accion_sugerida: "usar COP o USD" })
  }
  const proveedor = await controlProveedor(s, proveedores, sapDe(ctx), h)
  const centro = controlCentro(s, centros, h)
  controlAprobacion(paquete, centro, h)
  controlCotizacion(paquete, proveedor, h)
  controlDerivados(s, proveedor, ivas.map((i) => i.codigo), condiciones.map((c) => c.codigo), h)

  // RC8: factura anterior a la solicitud = la compra ya ocurrió. Se mide y se confirma.
  const retroactiva = paquete.factura !== null && paquete.factura.fecha < s.fecha_solicitud
  if (retroactiva && paquete.factura) {
    h.confirmaciones.push({ regla: "RC8", detalle: `OC retroactiva: la factura ${paquete.factura.numero} es del ${paquete.factura.fecha}, anterior a la solicitud (${s.fecha_solicitud})` })
  } else if (paquete.factura) {
    h.avisos.push(`el paquete ya trae la factura ${paquete.factura.numero} (${paquete.factura.fecha}): la OC se crea después de facturar`)
  }
  const validacion: Validacion = { apta: h.bloqueos.length === 0, ...h, retroactiva }
  return { paquete, validacion, proveedor, aprobacionCruda }
}

// ───────────────────────────── Evidencia de aprobación (HU-4) ─────────────────────────────

const aWinAnsi = (texto: string) => texto.replace(/[^\x20-\x7E\u00A1-\u00FF]/g, "?")

async function escribirPdf(destino: string, lineas: string[]): Promise<void> {
  const pdf = await PDFDocument.create()
  pdf.setTitle("Evidencia de aprobación")
  pdf.setCreationDate(new Date(0)) // metadatos fijos: mismo archivo en cada corrida
  pdf.setModificationDate(new Date(0))
  const fuente = await pdf.embedFont(StandardFonts.Courier)
  let pagina = pdf.addPage([595, 842])
  let y = 790
  for (const linea of lineas.flatMap((l) => l.match(/.{1,84}/g) ?? [""])) {
    if (y < 50) {
      pagina = pdf.addPage([595, 842])
      y = 790
    }
    pagina.drawText(aWinAnsi(linea), { x: 44, y, size: 10, font: fuente })
    y -= 14
  }
  await fs.writeFile(destino, await pdf.save({ useObjectStreams: false }))
}

interface Evidencia {
  ruta: string
  ruta_pdf: string
  sha256: string
}

/** P0: aprobacion.txt con encabezados, cuerpo y sha256. P1: el mismo contenido en PDF. */
async function generarEvidencia(ctx: Ctx, caso: string, aprobacion: AprobacionCruda | null, solicitudId: string): Promise<Evidencia> {
  if (!aprobacion) throw new ErrorClaro("no hay correo de aprobación en el paquete: no se puede generar la evidencia. Pide al solicitante el correo de su líder.")
  const contenido = [
    "EVIDENCIA DE APROBACIÓN",
    `Solicitud: ${solicitudId} (caso ${caso})`,
    `De: ${aprobacion.de}`,
    `Para: ${aprobacion.para}`,
    `Fecha: ${aprobacion.fecha}`,
    `Asunto: ${aprobacion.asunto}`,
    "",
    aprobacion.cuerpo,
  ].join("\n")
  const sha256 = createHash("sha256").update(contenido, "utf8").digest("hex")
  const pie = ["", "---", `sha256 del contenido anterior: ${sha256}`]
  await fs.mkdir(rutaSalida(ctx, caso), { recursive: true })
  await fs.writeFile(path.join(rutaSalida(ctx, caso), "aprobacion.txt"), [contenido, ...pie].join("\n") + "\n")
  await escribirPdf(path.join(rutaSalida(ctx, caso), "aprobacion.pdf"), [...contenido.split("\n"), ...pie])
  return { ruta: `out/${caso}/aprobacion.txt`, ruta_pdf: `out/${caso}/aprobacion.pdf`, sha256 }
}

// ───────────────────────────── Payload y trazabilidad (HU-3) ─────────────────────────────

function unidadDe(descripcion: string, cantidad: number): OrdenCompra["posiciones"][number]["unidad"] {
  const texto = normalizar(descripcion)
  if (/\bhoras?\b/.test(texto)) return "H"
  const meses = /\b(\d+) mes(es)? de\b/.exec(texto)
  return meses && Number(meses[1]) === cantidad ? "MES" : "UN"
}

/** Texto breve de SAP: máximo 40 caracteres, cortado en palabra completa y sin terminar en una preposición suelta. */
function textoBreve(descripcion: string): string {
  if (descripcion.length <= 40) return descripcion
  let texto = descripcion.slice(0, 40).replace(/\s+\S*$/, "")
  while (/\s(de|del|la|el|los|las|para|con|y|en|a)$|[,;:.]$/i.test(texto)) texto = texto.replace(/\s+\S*$|[,;:.]$/, "")
  return texto
}

function bloqueosComoTexto(v: Validacion): string {
  return v.bloqueos.map((b) => `${b.regla}: ${b.detalle}. Acción sugerida: ${b.accion_sugerida}`).join(" | ")
}

async function construirOrden(ctx: Ctx, caso: string, e: Evaluacion, confirmadoPor: string | null): Promise<{ orden: OrdenCompra; traza: Traza[] }> {
  const { paquete: p, validacion: v, proveedor } = e
  if (!v.apta || !proveedor || !p.aprobacion) throw new ErrorClaro(`la solicitud no es apta: no se construye la OC. ${bloqueosComoTexto(v)}`)
  const s = p.solicitud
  const evidencia = await generarEvidencia(ctx, caso, e.aprobacionCruda, s.solicitud_id)
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor ?? ""
  const pago = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor ?? ""
  const candidata = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: SOCIEDAD,
    organizacion_compras: ORGANIZACION_COMPRAS,
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: evidencia.sha256 },
    posiciones: [{
      numero: 10, descripcion: textoBreve(s.descripcion), cantidad: s.cantidad, unidad: unidadDe(s.descripcion, s.cantidad),
      precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: iva,
    }],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: confirmadoPor })),
  }
  const validada = OrdenCompraSchema.safeParse(candidata)
  if (!validada.success) {
    const problema = validada.error.issues[0]
    throw new ErrorClaro(`el payload no cumple el esquema de la OC en "${problema?.path.join(".")}": ${problema?.message}`)
  }
  const orden = validada.data
  const posicion = orden.posiciones[0]
  const derivado = (clave: string, fuenteSolicitud: boolean) => (fuenteSolicitud ? "solicitud" : (v.derivados[clave]?.fuente ?? "derivado"))
  const traza: Traza[] = [
    { campo: "referencia.solicitud_id", valor: orden.referencia.solicitud_id, fuente: "solicitud" },
    { campo: "referencia.correo_id", valor: orden.referencia.correo_id, fuente: "correo" },
    { campo: "referencia.cotizacion_ref", valor: orden.referencia.cotizacion_ref, fuente: "cotizacion" },
    { campo: "sociedad", valor: orden.sociedad, fuente: "derivado", detalle: "constante de configuración" },
    { campo: "organizacion_compras", valor: orden.organizacion_compras, fuente: "derivado", detalle: "constante de configuración" },
    { campo: "proveedor.codigo_sap", valor: orden.proveedor.codigo_sap, fuente: "maestro.proveedores" },
    { campo: "proveedor.nit", valor: orden.proveedor.nit, fuente: derivado("proveedor_nit", Boolean(s.proveedor_nit)) },
    { campo: "proveedor.nombre", valor: orden.proveedor.nombre, fuente: "maestro.proveedores" },
    { campo: "moneda", valor: orden.moneda, fuente: "solicitud" },
    { campo: "condiciones_pago", valor: orden.condiciones_pago, fuente: derivado("condiciones_pago", Boolean(s.condiciones_pago)), detalle: v.derivados.condiciones_pago?.motivo },
    { campo: "aprobador.email", valor: orden.aprobador.email, fuente: "aprobacion" },
    { campo: "aprobador.fecha_aprobacion", valor: orden.aprobador.fecha_aprobacion, fuente: "aprobacion" },
    { campo: "aprobador.evidencia_sha256", valor: orden.aprobador.evidencia_sha256, fuente: "derivado", detalle: `sha256 de ${evidencia.ruta}` },
    { campo: "posiciones[0].numero", valor: posicion?.numero ?? null, fuente: "derivado", detalle: "numeración SAP de a 10" },
    { campo: "posiciones[0].descripcion", valor: posicion?.descripcion ?? null, fuente: "solicitud", detalle: s.descripcion.length > 40 ? `recortada a 40 caracteres; original: ${s.descripcion}` : undefined },
    { campo: "posiciones[0].cantidad", valor: posicion?.cantidad ?? null, fuente: "solicitud" },
    { campo: "posiciones[0].unidad", valor: posicion?.unidad ?? null, fuente: "derivado", detalle: "inferida de la descripción" },
    { campo: "posiciones[0].precio_unitario", valor: posicion?.precio_unitario ?? null, fuente: "solicitud" },
    { campo: "posiciones[0].centro_costo", valor: posicion?.centro_costo ?? null, fuente: "solicitud" },
    { campo: "posiciones[0].subarea", valor: posicion?.subarea ?? null, fuente: "solicitud" },
    { campo: "posiciones[0].indicador_iva", valor: posicion?.indicador_iva ?? null, fuente: derivado("indicador_iva", Boolean(s.indicador_iva)), detalle: v.derivados.indicador_iva?.motivo },
  ]
  return { orden, traza }
}

/** Compara lo que mandó el modelo con lo que la herramienta calculó, solo para avisar. Nunca se usa su valor. */
function diferenciasCon(recibido: unknown, calculado: unknown, ruta = ""): string[] {
  if (recibido === undefined || recibido === null) return []
  if (typeof calculado !== "object" || calculado === null) return recibido === calculado ? [] : [ruta || "valor"]
  if (typeof recibido !== "object") return [ruta || "valor"]
  return Object.entries(calculado).flatMap(([clave, valor]) =>
    diferenciasCon((recibido as Record<string, unknown>)[clave], valor, ruta ? `${ruta}.${clave}` : clave),
  )
}

// ───────────────────────────── Log de control (HU-5) ─────────────────────────────

const celdaCsv = (valor: string) => (/[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor)

async function registrarControl(ctx: Ctx, solicitudId: string, resultado: string, numeroOc: string, v: Validacion): Promise<void> {
  const ruta = abs(ctx, OUT, "control.csv")
  await fs.mkdir(abs(ctx, OUT), { recursive: true })
  if (!(await existe(ruta))) await fs.writeFile(ruta, COLUMNAS_CONTROL.join(",") + "\n")
  const fila = [
    solicitudId, resultado, numeroOc, String(v.retroactiva),
    v.bloqueos.map((b) => b.regla).join(";"), v.confirmaciones.map((c) => c.regla).join(";"), new Date().toISOString(),
  ]
  await fs.appendFile(ruta, fila.map(celdaCsv).join(",") + "\n")
}

// ───────────────────────────── Herramientas exportadas ─────────────────────────────

const ArgIgnorado = z.looseObject({ solicitud_id: z.string().optional().describe("Identificador de la solicitud") })

export const leer_paquete = {
  description:
    "Lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura si existe) y lo devuelve normalizado; es el primer paso de todo caso.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. sol-004"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return ejecutar("leer_paquete", args.caso, ctx, async () => {
      const { paquete } = await leerPaquete(ctx, args.caso)
      const s = paquete.solicitud
      const falta = paquete.faltantes.length ? `; falta: ${paquete.faltantes.join(", ")}` : ""
      return { data: paquete, resumen: `${s.solicitud_id}: ${s.proveedor_nombre}, ${dinero(s.valor_total, s.moneda)}, ${s.centro_costo}/${s.subarea}${paquete.factura ? "; trae factura" : ""}${falta}` }
    })
  },
}

export const validar = {
  description:
    "Aplica los controles RC1 a RC10 contra los maestros y devuelve si la solicitud es apta, los bloqueos con su acción sugerida, las confirmaciones pendientes, los valores derivados y si es retroactiva; no escribe nada.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso"),
    paquete: ArgIgnorado.optional().describe("Paquete devuelto por oc_leer_paquete. Opcional y no se usa como fuente: la herramienta relee el caso."),
  },
  async execute(args: { caso: string; paquete?: unknown }, ctx: Ctx): Promise<string> {
    return ejecutar("validar", args.caso, ctx, async () => {
      const { paquete, validacion } = await evaluar(ctx, args.caso)
      const distintos = diferenciasCon((args.paquete as { solicitud?: unknown } | undefined)?.solicitud, paquete.solicitud, "solicitud")
      const avisos = distintos.length ? [...validacion.avisos, `el paquete recibido difiere del caso en ${distintos.join(", ")}; se usó el del caso`] : validacion.avisos
      const reglas = (lista: { regla: string }[]) => lista.map((x) => x.regla).join(", ") || "ninguno"
      const resumen = `apta=${validacion.apta}; bloqueos: ${reglas(validacion.bloqueos)}; confirmaciones: ${reglas(validacion.confirmaciones)}; retroactiva=${validacion.retroactiva}`
      return { data: { ...validacion, avisos }, resumen }
    })
  },
}

export const construir_payload = {
  description:
    "Construye la orden de compra tal como quedaría en SAP, validada contra su esquema, y guarda la trazabilidad de cada valor en out/<caso>/trazabilidad.json; solo para solicitudes aptas y no crea nada en SAP.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso"),
    paquete: ArgIgnorado.optional().describe("Opcional y no se usa como fuente: la herramienta relee el caso."),
    derivados: ArgIgnorado.optional().describe("Opcional y no se usa como fuente: los derivados se recalculan desde los maestros."),
  },
  async execute(args: { caso: string; paquete?: unknown; derivados?: unknown }, ctx: Ctx): Promise<string> {
    return ejecutar("construir_payload", args.caso, ctx, async () => {
      const e = await evaluar(ctx, args.caso)
      const { orden, traza } = await construirOrden(ctx, args.caso, e, null)
      await fs.writeFile(path.join(rutaSalida(ctx, args.caso), "trazabilidad.json"), JSON.stringify(traza, null, 2))
      await fs.writeFile(path.join(rutaSalida(ctx, args.caso), "payload.json"), JSON.stringify(orden, null, 2))
      const total = orden.posiciones.reduce((suma, p) => suma + p.cantidad * p.precio_unitario, 0)
      const data = { orden, valor_total: total, ruta_trazabilidad: `out/${args.caso}/trazabilidad.json`, confirmaciones_pendientes: e.validacion.confirmaciones }
      return { data, resumen: `OC para ${orden.proveedor.nombre} por ${dinero(total, orden.moneda)}; ${orden.excepciones.length} excepciones por confirmar` }
    })
  },
}

export const generar_evidencia = {
  description:
    "Genera la evidencia de aprobación del líder en out/<caso>/aprobacion.txt y aprobacion.pdf, con encabezados, cuerpo y el sha256 del contenido.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return ejecutar("generar_evidencia", args.caso, ctx, async () => {
      const { paquete, aprobacionCruda } = await leerPaquete(ctx, args.caso)
      const data = await generarEvidencia(ctx, args.caso, aprobacionCruda, paquete.solicitud.solicitud_id)
      return { data, resumen: `evidencia en ${data.ruta}, sha256 ${data.sha256.slice(0, 12)}…` }
    })
  },
}

interface Creacion {
  numero_oc: string
  fecha: string | null
  idempotente: boolean
  retroactiva: boolean
  ruta_evidencia: string
  excepciones_confirmadas: string[]
  payload_recibido_difiere: string[]
}

export const crear = {
  description:
    "Crea la orden de compra en SAP y registra el intento en out/control.csv; rechaza si hay bloqueos, exige confirmado=true si hay confirmaciones pendientes y devuelve la OC existente si la solicitud ya tenía una.",
  args: {
    caso: CasoId.describe("Nombre de la carpeta del caso"),
    payload: ArgIgnorado.optional().describe("Opcional y no se usa como fuente: la herramienta reconstruye la OC desde el caso. Si difiere, se informa."),
    confirmado: z.boolean().optional().describe("true únicamente si la analista confirmó de forma explícita las confirmaciones pendientes en su último mensaje"),
  },
  async execute(args: { caso: string; payload?: unknown; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    return ejecutar<Creacion>("crear", args.caso, ctx, async () => {
      const e = await evaluar(ctx, args.caso)
      const v = e.validacion
      const solicitudId = e.paquete.solicitud.solicitud_id
      const sap = sapDe(ctx)
      const ruta_evidencia = `out/${args.caso}/aprobacion.pdf`
      const comun = { retroactiva: v.retroactiva, ruta_evidencia, payload_recibido_difiere: [] as string[] }

      // Idempotencia: una solicitud tiene como máximo una OC, sin importar cuántas veces se pida.
      const existente = await sap.buscarOrdenPorReferencia(solicitudId)
      if (existente) {
        await registrarControl(ctx, solicitudId, "idempotente", existente.numero_oc, v)
        const data: Creacion = { ...comun, numero_oc: existente.numero_oc, fecha: null, idempotente: true, excepciones_confirmadas: [] }
        return { data, resumen: `la solicitud ${solicitudId} ya tenía la OC ${existente.numero_oc}; no se creó otra` }
      }
      if (!v.apta) {
        await registrarControl(ctx, solicitudId, "bloqueada", "", v)
        throw new ErrorClaro(`bloqueada, no se crea la OC. ${bloqueosComoTexto(v)}`)
      }
      if (v.confirmaciones.length > 0 && args.confirmado !== true) {
        await registrarControl(ctx, solicitudId, "pendiente_confirmacion", "", v)
        throw new ErrorClaro(`requiere confirmación: ${v.confirmaciones.map((c) => `${c.regla} (${c.detalle})`).join(" | ")}`)
      }
      const confirmadoPor = v.confirmaciones.length ? `analista (sesión ${ctx.sessionId})` : null
      const { orden, traza } = await construirOrden(ctx, args.caso, e, confirmadoPor)
      await fs.writeFile(path.join(rutaSalida(ctx, args.caso), "trazabilidad.json"), JSON.stringify(traza, null, 2))
      await fs.writeFile(path.join(rutaSalida(ctx, args.caso), "payload.json"), JSON.stringify(orden, null, 2))
      const creada = await sap.crearOrden(orden)
      await registrarControl(ctx, solicitudId, "creada", creada.numero_oc, v)
      const data: Creacion = {
        ...comun, numero_oc: creada.numero_oc, fecha: creada.fecha, idempotente: false,
        excepciones_confirmadas: v.confirmaciones.map((c) => c.regla),
        payload_recibido_difiere: diferenciasCon(args.payload, { proveedor: orden.proveedor, moneda: orden.moneda, posiciones: orden.posiciones }),
      }
      return { data, resumen: `OC ${creada.numero_oc} creada para ${solicitudId}${v.retroactiva ? " (retroactiva)" : ""}` }
    })
  },
}

export const solicitar_confirmacion = {
  description:
    "Registra que la creación de la OC queda a la espera de la confirmación de la analista y deja el intento como pendiente en out/control.csv; llámala justo antes de cerrar el turno con la pregunta.",
  args: {
    caso: CasoId.describe("Caso cuya creación queda a la espera de confirmación"),
    pregunta: z.string().min(5).max(500).describe("Pregunta de sí o no que verá la analista, con lo que debe confirmar"),
  },
  async execute(args: { caso: string; pregunta: string }, ctx: Ctx): Promise<string> {
    return ejecutar("solicitar_confirmacion", args.caso, ctx, async () => {
      const e = await evaluar(ctx, args.caso)
      if (!e.validacion.apta) throw new ErrorClaro(`no hay nada que confirmar: la solicitud está bloqueada. ${bloqueosComoTexto(e.validacion)}`)
      await registrarControl(ctx, e.paquete.solicitud.solicitud_id, "pendiente_confirmacion", "", e.validacion)
      const data = { accion: "crear", clave: args.caso, pregunta: args.pregunta, confirmaciones: e.validacion.confirmaciones, estado: "esperando_confirmacion" }
      return { data, resumen: `confirmación pendiente para crear la OC de ${args.caso}` }
    })
  },
}
