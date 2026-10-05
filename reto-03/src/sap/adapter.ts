/**
 * Contrato con SAP. El agente y las herramientas solo conocen esta interfaz: el SAP simulado
 * (`mock.ts`) y un adaptador real (diseñado en SOLUCION.md) son intercambiables sin tocar las reglas.
 */
import { z } from "zod"

/** Payload de la orden de compra (PRD 7.4). Es lo único que se le entrega a SAP. */
export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string().min(1), correo_id: z.string().min(1), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().regex(/^\d+$/), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({ email: z.string().email(), fecha_aprobacion: z.string().min(1), evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().min(1).max(40), // límite del texto breve en SAP
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string().min(1),
        subarea: z.string().min(1),
        indicador_iva: z.string().min(1),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
