/**
 * Confirmación humana aplicada por el backend (CA3).
 *
 * El prompt le pide al modelo que pregunte antes de crear una OC con confirmaciones pendientes,
 * pero la garantía no depende de que obedezca: el ciclo solo deja pasar `confirmado: true` si
 *   1) el turno anterior cerró pidiendo confirmación para ese mismo caso, y
 *   2) el mensaje actual del usuario es una afirmación explícita.
 */
import type { Pendiente } from "./sesiones.ts"

interface Regla {
  argumento: string // booleano que autoriza la acción
  clave: string // argumento que identifica sobre qué se actúa (aquí, el caso)
  accion: string
  errorQuePideConfirmacion: RegExp
}

/** Herramientas cuya escritura puede requerir confirmación humana. */
export const ACCIONES_CONFIRMABLES: Record<string, Regla> = {
  oc_crear: { argumento: "confirmado", clave: "caso", accion: "crear", errorQuePideConfirmacion: /requiere confirmaci[óo]n/i },
}
export const HERRAMIENTA_PREGUNTA = "oc_solicitar_confirmacion"

const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
const AFIRMA = /^(si|confirmo|confirmado|confirmar|dale|procede|adelante|ok|okay|de acuerdo|hazlo|crea|creala|crear|claro|correcto|apruebo|aprobado)\b/
const NIEGA = /\b(no|todavia|aun|espera|cancela|cancelar|despues)\b/

export function esConfirmacionExplicita(mensaje: string): boolean {
  const texto = sinTildes(mensaje)
  return texto.length <= 200 && AFIRMA.test(texto) && !NIEGA.test(texto)
}

export interface Control {
  args: unknown
  bloqueada: boolean
  objetivo?: Pendiente
}

export const mismaPendiente = (a: Pendiente, b: Pendiente) => a.accion === b.accion && a.clave === b.clave

/** Devuelve los argumentos que realmente se ejecutan: sin autorización vigente, `confirmado` pasa a false. */
export function aplicarConfirmacion(nombre: string, args: unknown, autorizadas: Pendiente[]): Control {
  const regla = ACCIONES_CONFIRMABLES[nombre]
  if (!regla || typeof args !== "object" || args === null) return { args, bloqueada: false }
  const entrada = args as Record<string, unknown>
  const objetivo: Pendiente = { accion: regla.accion, clave: typeof entrada[regla.clave] === "string" ? (entrada[regla.clave] as string) : "" }
  const permitido = autorizadas.some((a) => mismaPendiente(a, objetivo))
  if (entrada[regla.argumento] === true && !permitido) return { args: { ...entrada, [regla.argumento]: false }, bloqueada: true, objetivo }
  return { args, bloqueada: false, objetivo }
}
