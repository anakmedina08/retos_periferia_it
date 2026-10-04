---
name: registro-contratos
description: Reglas del proceso de registro de contratos (clasificación, confianza y revisión, pólizas, archivo, alertas). Úsalo al procesar el buzón de contratos.
---

# Conocimiento del proceso: registro de contratos vigentes

## Contexto

El maestro de contratos quedó congelado el 2026-05-30. Hasta entonces solo llegaban a
administración los contratos que exigían póliza. El buzón `contratos@periferia-ficticia.com` es
ahora el punto único de recepción: debe llegar todo contrato, con o sin póliza, y todo otrosí.

## Clasificación de un mensaje

| Clasificación | Cuándo | Qué se hace |
|---|---|---|
| `nuevo` | El contrato no coincide con ninguno del maestro. | Se inserta una fila y se archiva el documento. |
| `actualizacion` | Mismo número de contrato (o mismo NIT y objeto casi idéntico) con algún término distinto, o el documento es un otrosí. | Se modifica la fila existente y el cambio queda en `historial.jsonl`. |
| `duplicado` | Mismo número, mismo valor y mismas fechas. | No se escribe nada en el maestro. Se reporta. |
| `rechazado` | El correo no trae un contrato (por ejemplo, una cotización), el texto no tiene partes ni objeto, o es un otrosí de un contrato que no está en el maestro. | No se escribe nada. Se reporta con el motivo. |

## Confianza y revisión humana

Cada campo extraído trae una confianza entre 0 y 1. Por debajo de 0.8 el campo entra en
`requiere_revision` y el contrato no se registra hasta que la analista confirme. También entran en
revisión los conflictos con el maestro (otro NIT, otra moneda u otro país para el mismo contrato, o
un cambio de valor o fechas que no viene en un otrosí) y cualquier valor distinto al del documento.

Casos típicos de baja confianza:

- Contrato marco o por demanda: no tiene valor determinado. Se propone `valor = 0`.
- Plazo en meses contado desde la firma, sin día de firma: la fecha de fin es una propuesta.
- La cifra del valor no coincide con el valor en letras.
- Se menciona una garantía pero no se reconoce el tipo de póliza.

## Pólizas

| Situación | `estado_poliza` |
|---|---|
| Contrato nuevo que exige póliza | `pendiente` |
| Contrato que no exige póliza | `no_aplica` |
| Otrosí que cambia la fecha de fin de un contrato con póliza | `pendiente` (la póliza debe ampliarse) |

Tipos reconocidos: `cumplimiento`, `calidad`, `salarios_prestaciones`, `responsabilidad_civil`,
`buen_manejo_anticipo`, `estabilidad`. Varios tipos se separan con `;`.

## Identificadores y países

| Identificador | País |
|---|---|
| NIT | CO (se guarda sin puntos ni dígito de verificación) |
| RUC de 13 dígitos | EC |
| RUC de 11 dígitos | PE |
| RUC de otra longitud | PA |
| RTN | HN |

Monedas admitidas: COP, USD, PEN, PAB, HNL.

## Comercial

El comercial se toma del remitente del correo y se resuelve contra el catálogo de comerciales. Un
remitente que no está en el catálogo no bloquea el registro: el contrato queda sin comercial y se
avisa para que la analista lo asigne.

## Archivo

- Contrato nuevo: `out/sharepoint/Contratos/<año de inicio>/<cliente>/<id_contrato>.<ext>`.
- Otrosí: en la carpeta del contrato original, como `<id_contrato>-otrosi-<número>.<ext>`.
- Un contrato sin número recibe `AUTO-<año>-<secuencia>`.

## Alertas

`out/alertas.md` tiene tres secciones: contratos vencidos o que vencen en 60 días o menos, pólizas
exigidas que no están vigentes, y contratos registrados después del corte del 2026-05-30. La fecha
de referencia la da la analista.
