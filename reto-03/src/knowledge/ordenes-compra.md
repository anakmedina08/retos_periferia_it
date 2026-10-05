# Conocimiento del proceso: órdenes de compra

## El paquete

Cada solicitud llega por correo con la solicitud de compra, la cotización del proveedor y el correo
de aprobación del líder. A veces trae además la factura. Casos disponibles hoy: `sol-001` a
`sol-006`. Una solicitud tiene como máximo una OC: volver a crearla devuelve la misma.

## Controles

| Regla | Qué verifica | Si no cumple |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo. | Bloqueo |
| RC2 | Hay correo de aprobación, dice "Aprobado" y viene de un aprobador del centro de costo. | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador para ese centro. | Bloqueo |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo |
| RC5 | La cotización y la solicitud difieren 2 % o menos. Sin cotización también aplica. | Confirmación |
| RC6 | Si falta el indicador de IVA, se toma el del proveedor por defecto. | Confirmación y derivado |
| RC7 | Si faltan las condiciones de pago, se toman las del proveedor por defecto. | Solo se informa |
| RC8 | Hay factura con fecha anterior a la solicitud: la OC es retroactiva. | Confirmación y marca en control |
| RC9 | La aprobación no puede ser anterior a la solicitud. | Confirmación |
| RC10 | Cantidad por valor unitario es igual al valor total (más o menos 1). | Bloqueo |
| M1, M2, M3 | El indicador de IVA, la condición de pago y la moneda existen en los maestros. | Bloqueo |

Un **bloqueo** impide crear la OC y se resuelve en el origen: el solicitante corrige y reenvía. Una
**confirmación** permite crearla solo cuando la analista la acepta de forma explícita; queda
registrada como excepción dentro de la OC. Un **derivado** es un valor que no venía en la solicitud
y se completó desde un maestro.

## Quién aprueba

Cada centro de costo tiene sus aprobadores, cada uno con un tope en COP. Que un líder apruebe no
basta: debe ser aprobador de ese centro y su tope debe cubrir el valor. Cuando falla RC2 o RC3, la
acción sugerida nombra a quien sí puede aprobar ese monto, o indica que hay que escalar.

## Cuando la cotización y la solicitud no coinciden

La OC se crea por el valor de la solicitud, que es lo que el líder aprobó. La diferencia se muestra
con los dos valores para que la analista decida si continúa o devuelve la solicitud.

## OC retroactivas

Una OC es retroactiva cuando la factura del proveedor tiene fecha anterior a la solicitud: la
compra ya ocurrió y la OC se está creando para poder radicar la factura. No se bloquea, pero exige
confirmación y queda con `retroactiva = true` en `out/control.csv`, que es lo que la dirección usa
para medir el desvío.

## Qué queda registrado

- `out/sap/ordenes.jsonl`: las OC creadas, numeradas desde 4500000001.
- `out/control.csv`: una fila por cada intento de creación (creada, bloqueada, pendiente de
  confirmación o idempotente), con las reglas que aplicaron.
- `out/<caso>/aprobacion.txt` y `aprobacion.pdf`: la evidencia de aprobación con su sha256.
- `out/<caso>/payload.json` y `trazabilidad.json`: la OC y de dónde salió cada valor.
