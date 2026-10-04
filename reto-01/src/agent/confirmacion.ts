/**
 * Confirmación humana aplicada por el backend (CA3, RN4).
 *
 * El prompt le pide al modelo que pregunte antes de una acción externa, pero la garantía
 * no depende de que obedezca: el ciclo solo deja pasar `confirmado: true` si
 *   1) el turno anterior cerró pidiendo confirmación para esa misma acción y caso, y
 *   2) el mensaje actual del usuario es una afirmación explícita.
 */
import type { Pendiente } from "./sesiones.ts"

/** Herramientas que ejecutan una acción externa → argumento booleano que la autoriza. */
export const ACCIONES_EXTERNAS: Record<string, { argumento: string; accion: string }> = {
  proveedor_simular_envio: { argumento: "confirmado", accion: "simular_envio" },
}
export const HERRAMIENTA_PREGUNTA = "proveedor_solicitar_confirmacion"

const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
const AFIRMA = /^(si|confirmo|confirmado|confirmar|dale|procede|adelante|ok|okay|de acuerdo|hazlo|envia|envialo|enviar|claro|correcto|apruebo|aprobado)\b/
const NIEGA = /\b(no|todavia|aun|espera|cancela|cancelar|despues)\b/

export function esConfirmacionExplicita(mensaje: string): boolean {
  const texto = sinTildes(mensaje)
  return texto.length <= 120 && AFIRMA.test(texto) && !NIEGA.test(texto)
}

export interface Autorizacion {
  args: unknown
  bloqueada: boolean
  pendiente?: Pendiente
}

/** Devuelve los argumentos que realmente se ejecutan: sin autorización vigente, `confirmado` pasa a false. */
export function aplicarConfirmacion(nombre: string, args: unknown, autorizada: Pendiente | undefined): Autorizacion {
  const regla = ACCIONES_EXTERNAS[nombre]
  if (!regla || typeof args !== "object" || args === null) return { args, bloqueada: false }
  const entrada = args as Record<string, unknown>
  const caso = typeof entrada.caso === "string" ? entrada.caso : ""
  const permitido = autorizada?.accion === regla.accion && autorizada.caso === caso
  if (entrada[regla.argumento] === true && !permitido) {
    return { args: { ...entrada, [regla.argumento]: false }, bloqueada: true, pendiente: { accion: regla.accion, caso } }
  }
  return { args, bloqueada: false, pendiente: entrada[regla.argumento] === true ? undefined : { accion: regla.accion, caso } }
}
