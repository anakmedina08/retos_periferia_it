---
name: registro-proveedor
description: Reglas del proceso de registro como proveedor (estados de campo, identificador tributario por país, soportes y vigencias, formatos). Úsalo al procesar una solicitud de registro.
---

# Conocimiento del proceso: registro como proveedor

## Qué es un caso

Cada solicitud de un cliente vive en `fixtures/reto-01/casos/<caso>/` con el correo
(`solicitud.json`), la plantilla (`plantilla-celdas.json` para Excel, `plantilla-campos.json` para
PDF o portal) y `soportes-exigidos.json`. Casos disponibles hoy: `co-industrias-delta`,
`ec-corp-andina`, `hn-agroexport-sula`, `pa-logistica-istmo`.

## Estados de un campo

| Estado | Significado | ¿Se escribe en el formulario? |
|---|---|---|
| `lleno` | Hay un dato en el maestro y el mapeo es confiable (confianza >= 0.8). | Sí |
| `faltante` | El maestro no tiene el dato o la etiqueta no se reconoce. | No, queda en blanco |
| `requiere_confirmacion` | Mapeo dudoso (confianza < 0.8) o regla de país. | Solo si la regla lo indica (`llenar: true`) |

## Identificador tributario por país (RN1)

| País del cliente | Identificador que espera |
|---|---|
| CO | NIT |
| EC | RUC |
| PE | RUC |
| PA | RUC |
| HN | RTN |

Periferia solo tiene NIT colombiano. Para un cliente de otro país el campo se llena con el NIT y
queda en `requiere_confirmacion` con la nota "identificador extranjero": la analista decide si el
cliente lo acepta o si pide un registro local. Una etiqueta genérica como "Identificación
tributaria" también requiere confirmación.

## Datos bancarios (RN2)

Se llenan únicamente cuando la plantilla los pide con una etiqueta bancaria reconocida (banco, tipo
de cuenta, número de cuenta, titular, SWIFT). Nunca aparecen en `borrador-correo.md` ni se repiten
en el chat sin que la analista lo pida.

## Soportes y estado "listo para firma" (RN3)

- Un soporte exigido que no existe en el repositorio está **ausente** y bloquea la firma.
- Un soporte con `vigencia_hasta` anterior a la fecha de ejecución está **vencido** y bloquea la
  firma. La Cámara de Comercio vence a los 30 días y los parafiscales cada mes: son los que más se
  vencen.
- Un campo `faltante` no bloquea la firma, pero aparece en el checklist para que la analista decida.
- El formato portal nunca queda listo para firma: no hay documento que firmar.

## Formatos de salida

| Formato | Resultado |
|---|---|
| `xlsx` | `out/<caso>/formulario.xlsx`, cada etiqueta y valor en la hoja y celda de la plantilla. |
| `pdf` | `out/<caso>/formulario.pdf`, todos los campos en el orden de la plantilla. |
| `portal` | No soportado. Se deja `out/<caso>/valores-portal.md` para que una persona copie los valores. |

## Paquete para firma

`out/<caso>/paquete/` contiene el formulario, las copias de los soportes exigidos que existen,
`checklist.md` y `borrador-correo.md`. El envío es simulado: escribe `out/<caso>/ENVIO-SIMULADO.md`
y requiere confirmación explícita (RN4).
