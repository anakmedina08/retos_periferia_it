/**
 * SAP simulado sobre archivos. Los proveedores salen del maestro de fixtures (solo lectura) y las
 * órdenes se guardan en out/sap/ordenes.jsonl, una por línea, con número secuencial.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4_500_000_001
const ProveedorSap = z.object({ codigo_sap: z.string(), nit: z.string(), activo: z.boolean() })
const OrdenGuardada = z.object({ numero_oc: z.string(), fecha: z.string(), solicitud_id: z.string() })
type OrdenGuardadaT = z.infer<typeof OrdenGuardada>

/** Fecha contable del documento. `FECHA_EJECUCION` permite reproducir una corrida. */
function fechaDocumento(): string {
  const fijada = process.env.FECHA_EJECUCION
  return fijada && /^\d{4}-\d{2}-\d{2}$/.test(fijada) ? fijada : new Date().toISOString().slice(0, 10)
}

export function crearSapMock(directorio: string): SapAdapter {
  const carpeta = path.join(directorio, "out", "sap")
  const archivo = path.join(carpeta, "ordenes.jsonl")

  async function leerOrdenes(): Promise<OrdenGuardadaT[]> {
    const texto = await fs.readFile(archivo, "utf8").catch(() => "")
    return texto.split("\n").filter(Boolean).flatMap((linea) => {
      try {
        const orden = OrdenGuardada.safeParse(JSON.parse(linea))
        return orden.success ? [orden.data] : []
      } catch {
        return []
      }
    })
  }

  return {
    async consultarProveedor(nit) {
      const ruta = path.join(directorio, "fixtures", "reto-03", "maestros", "proveedores.json")
      const maestro = z.array(ProveedorSap).safeParse(JSON.parse(await fs.readFile(ruta, "utf8")))
      const hallado = maestro.success ? maestro.data.find((p) => p.nit === nit) : undefined
      return hallado ? { codigo_sap: hallado.codigo_sap, activo: hallado.activo } : null
    },

    async buscarOrdenPorReferencia(solicitud_id) {
      const existente = (await leerOrdenes()).find((o) => o.solicitud_id === solicitud_id)
      return existente ? { numero_oc: existente.numero_oc } : null
    },

    async crearOrden(orden: OrdenCompra) {
      const ordenes = await leerOrdenes()
      // Defensa en profundidad: aunque la herramienta ya consulta antes, el adaptador tampoco duplica.
      const existente = ordenes.find((o) => o.solicitud_id === orden.referencia.solicitud_id)
      if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }
      const numero_oc = String(PRIMER_NUMERO + ordenes.length)
      const fecha = fechaDocumento()
      await fs.mkdir(carpeta, { recursive: true })
      const linea = { numero_oc, fecha, solicitud_id: orden.referencia.solicitud_id, creada_en: new Date().toISOString(), orden }
      await fs.appendFile(archivo, JSON.stringify(linea) + "\n")
      return { numero_oc, fecha }
    },
  }
}
