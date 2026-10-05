# SOLUCION · Reto 03 "Órdenes de compra"

## 1. Problema en una frase

Cada factura que entra a Periferia obliga a la analista administrativa a digitar a mano una orden
de compra en SAP y a verificar de memoria si quien aprobó podía aprobar ese monto en ese centro de
costo, mientras nadie mide cuántas órdenes se crean después de que la compra ya ocurrió. Le duele a
la analista (tiempo y errores que aparecen en el cierre contable), a contabilidad y auditoría
(controles que no dejan rastro) y a la dirección (un desvío de proceso sin cifra).

## 2. Arquitectura

```
┌────────────────┐  POST /api/chat (NDJSON)  ┌──────────────────────────────────────────────┐
│ web/           │ ────────────────────────▶ │ src/server.ts   transporte, límites de uso    │
│ chat, llamadas │ ◀──────────────────────── │        │                                      │
│ confirmación   │      eventos por línea    │        ▼                                      │
└────────────────┘                           │ src/agent/ciclo.ts  ── src/llm/adapter.ts ──▶ modelo
                                             │   │  confirmacion.ts      openai | anthropic  │
                                             │   ▼                                           │
                                             │ src/tools/registro.ts  (zod → JSON Schema)    │
                                             │   ▼                                           │
                                             │ src/tools/oc.ts (6 herramientas)              │
                                             │   ▼                                           │
                                             │ src/sap/adapter.ts ── mock.ts | SAP real      │
                                             └───────┬───────────────────────┬───────────────┘
                                         fixtures/reto-03 (lectura)     out/ (escritura)
                                         solicitudes/, maestros/        sap/, control.csv, <caso>/
```

| Qué | Dónde vive | Cambia cuando |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cambia el orden de pasos, el tono o lo que el agente tiene prohibido. |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Cambia un control que el agente debe poder explicar. |
| Ejecución | `src/tools/oc.ts` | Cambia cómo se valida, se construye o se registra. |
| Sistema de registro | `src/sap/` | Cambia la forma de hablar con SAP. Las reglas no se enteran. |
| Transporte | `src/server.ts` | Cambia la API. No contiene reglas de negocio. |

`oc_validar`, `oc_construir_payload` y `oc_crear` comparten una sola función, `evaluar`, que lee
el paquete y aplica los controles: deciden siempre con las mismas reglas y sobre los mismos datos.

## 3. Ciclo del agente

`ejecutarTurno` (en `src/agent/ciclo.ts`) hace lo siguiente por cada mensaje del usuario:

1. Revisa si el turno anterior dejó confirmaciones pendientes y si el mensaje actual es una
   afirmación explícita. Si ambas se cumplen, esos casos quedan autorizados para este turno. Las
   pendientes se borran siempre: solo valen para el mensaje inmediatamente siguiente.
2. Llama al modelo con sistema + historial + definiciones de herramientas.
3. Si el modelo pide herramientas, cada una pasa por `aplicarConfirmacion`, luego por la validación
   zod y luego se ejecuta. Los resultados vuelven al modelo y se repite el paso 2.
4. Si el modelo responde solo texto, el turno termina.

**Tope de iteraciones (CA1).** `MAX_ITERACIONES` (25). Al alcanzarlo, el backend arma una respuesta
determinista con lo ejecutado y lo que falta, sin otra llamada al modelo.

**Confirmación humana (CA3).** Tres capas, ninguna depende de que el modelo obedezca:

- La herramienta: `oc_crear` rechaza con "requiere confirmación: …" si hay confirmaciones y no
  llega `confirmado: true`, y deja el intento como `pendiente_confirmacion` en `control.csv`.
- El backend: si el modelo envía `confirmado: true` sin que el usuario haya confirmado ese caso en
  su último turno, el ciclo cambia el argumento a `false` antes de ejecutar.
- El front: `needsConfirmation: true` enciende el aviso ámbar con los botones de confirmar.

Un **bloqueo** no pasa por ninguna confirmación: `oc_crear` lo rechaza aunque llegue
`confirmado: true` en un turno confirmado. `scripts/prueba-ciclo.ts` comprueba los dos caminos con
un modelo guionizado que intenta saltárselos.

**Valores sin invención (CA2).** Los argumentos `paquete`, `derivados` y `payload` existen porque
el contrato los pide, pero ninguna herramienta los usa como fuente: cada una relee el caso y
recalcula. Si el payload que manda el modelo difiere del calculado, `oc_crear` crea la OC con el
calculado e informa qué campos diferían. El modelo no puede "arreglar" un monto.

**Errores (CA5).** Las herramientas devuelven `{ ok: false, error }` y nunca lanzan. Un fallo del
proveedor LLM se traduce a una frase clara y la sesión sigue viva. Ante un 429 el adaptador espera
15 segundos y reintenta hasta tres veces.

**Trazabilidad (CA4).** Cada llamada aparece en el chat y en `out/log.jsonl`. Cada intento de
creación deja además una fila en `out/control.csv`, que es el insumo de contabilidad y auditoría.

## 4. Elección del modelo

**Google Gemini, `gemini-3-flash-preview`**, por su endpoint compatible con OpenAI Chat Completions
(`src/llm/openai.ts`). Se configura con `LLM_PROVIDER`, `LLM_MODEL` y `OPENAI_BASE_URL`.

- El modelo solo orquesta herramientas y redacta. Los controles, el payload y la creación son
  deterministas, así que un modelo de gama Flash es suficiente.
- Tiene capa gratuita en la API, lo que permite desarrollar y demostrar sin costo.
- El adaptador conserva la firma de razonamiento que Gemini 3 exige devolver en cada llamada a
  herramienta, sin que el ciclo del agente sepa de ella.

El adaptador de Anthropic (`src/llm/anthropic.ts`) también está implementado; cambiar a
`claude-haiku-4-5` es cambiar variables de entorno.

**Costo por caso.** En la capa gratuita es cero. Como referencia para producción, con el precio de
lista de la capa de pago (USD 0,50 por millón de tokens de entrada y USD 3,00 por millón de salida):

| Concepto | Tokens aproximados |
|---|---|
| Sistema + definiciones de herramientas, por llamada | 4.000 |
| Llamadas al modelo por solicitud (leer, validar, construir, confirmar, crear) | 5 a 7 |
| Entrada acumulada por solicitud | 28.000 |
| Salida, incluido razonamiento | 2.500 |

Esto da cerca de **USD 0,02 por solicitud procesada**. Son cifras estimadas. Medición real con
el prompt de ejemplo: **PENDIENTE tokens** (el front muestra el total de la sesión).

En la capa gratuita Google puede usar las solicitudes para mejorar sus productos. Los fixtures son
ficticios; con datos reales de compras se usaría la capa de pago o un proveedor con acuerdo de
tratamiento de datos.

Controles de gasto: tope de iteraciones, tope de tokens por sesión, tope global diario, límite de
solicitudes por IP, tope de caracteres por mensaje y tope de tokens por respuesta.

## 5. Matriz de controles

| Regla | Tipo | Implementación (`src/tools/oc.ts`) | Caso que la ejercita |
|---|---|---|---|
| RC1 | Bloqueo | `controlProveedor`: busca por NIT normalizado (sin puntos ni dígito de verificación); sin NIT, por nombre normalizado. Luego consulta `SapAdapter.consultarProveedor` para saber si está activo. | `sol-002` (no existe). `sol-006` se identifica por nombre. |
| RC2 | Bloqueo | `controlAprobacion`: hay correo, el cuerpo aprueba (`estaAprobado` descarta "no aprobado" y "rechazado") y el remitente es aprobador del centro. | `sol-003` (aprueba un líder de otro centro). |
| RC3 | Bloqueo | `controlAprobacion`: `valor_total` contra el tope del aprobador en ese centro. Si la moneda no es COP, bloquea porque el tope no es comparable. | Cubierto por `sol-001`, `004`, `005`, `006` (pasan). |
| RC4 | Bloqueo | `controlCentro`: el centro existe y la subárea está en su lista. | Pasa en los seis casos. |
| RC5 | Confirmación | `controlCotizacion`: diferencia relativa mayor al 2 %, cotización ausente o en otra moneda. El detalle trae los dos valores. | `sol-004` (26,5 frente a 25 millones: 6,0 %). |
| RC6 | Confirmación y derivado | `controlDerivados`: toma `indicador_iva_default` del proveedor y pide confirmación. | `sol-006`. |
| RC7 | Derivado | `controlDerivados`: toma `condiciones_pago_default`. Solo se informa. | `sol-006`. |
| RC8 | Confirmación | `evaluar`: factura con fecha anterior a `fecha_solicitud` marca `retroactiva = true`, que viaja a `control.csv`. | `sol-005`. |
| RC9 | Confirmación | `controlAprobacion`: fecha de aprobación anterior a la de solicitud. | Pasa en los seis casos. |
| RC10 | Bloqueo | `evaluar`: `cantidad × valor_unitario` contra `valor_total`, con tolerancia de 1. Se evalúa primero. | Pasa en los seis casos. |
| M1, M2, M3 | Bloqueo | El indicador de IVA, la condición de pago y la moneda deben existir en sus maestros. Agregadas: sin ellas SAP rechazaría la OC. | Pasan en los seis casos. |

Además hay **avisos** que no bloquean ni piden confirmación: cotización vencida antes de la
solicitud, cotización con un NIT distinto al del proveedor, y factura presente aunque no sea
anterior a la solicitud.

Cada bloqueo sale con una **acción sugerida**. En RC2 y RC3 la acción nombra a quién del centro sí
puede aprobar ese monto. En `sol-003` el resultado es más útil que "aprobador inválido": ningún
aprobador de CC-2020 tiene tope para COP 74 millones (el máximo es COP 30 millones), así que hay
que escalar.

**La más difícil: RC2.** Parece una búsqueda de correo en una lista y no lo es, por tres razones:

- Falla de varias formas distintas (no hay correo, el correo no aprueba, quien aprueba no pertenece
  al centro) y cada una pide una acción diferente.
- "Contiene la palabra Aprobado" es una regla frágil: "No aprobado" también la contiene. La
  detección actual descarta las negaciones más comunes, pero sigue siendo texto libre.
- Se cruza con RC3: cuando el aprobador no es del centro, no hay un tope contra el cual comparar,
  y lo útil para la analista es saber quién sí podría aprobar. Esa respuesta exige recorrer los
  topes del centro, que es justo la verificación que hoy se hace de memoria.

## 6. Diseño del adaptador SAP real

**Punto de partida.** No está confirmado que Periferia pueda conectarse a SAP, ni qué versión
tiene. Por eso el diseño tiene tres escalones detrás de la misma interfaz `SapAdapter`. Lo que sigue
es un diseño: los nombres de campos y servicios deben confirmarse con el equipo de Basis sobre el
sistema real.

| Opción | Cuándo aplica | Evaluación |
|---|---|---|
| **OData `API_PURCHASEORDER_PROCESS_SRV`** (elegida si el SAP es S/4HANA) | S/4HANA, en nube u on-premise con el servicio activo. | API estándar y soportada, HTTPS, sin componentes instalados en el servidor del agente, creación de cabecera y posiciones en una sola llamada. |
| BAPI `BAPI_PO_CREATE1` por RFC | SAP ECC o un S/4HANA sin el servicio OData publicado. | Estable y conocida por cualquier consultor MM, pero exige conectividad RFC (librerías y red) y manejo explícito del commit. |
| SAP Integration Suite | Si la compañía ya la tiene. | No es una alternativa sino una capa: expone cualquiera de las dos anteriores con seguridad, monitoreo y reintentos centralizados. Si existe, se usa. |
| Carga por archivo | Si no hay conexión viable. | Es el Plan B (ver abajo). |

**Decisión.** OData si el sistema lo permite, publicado a través de Integration Suite o API
Management si existen; BAPI por RFC como segunda opción. La elección no cambia nada del agente: se
reemplaza `crearSapMock` por la implementación real en un solo punto (`sapDe` en `oc.ts`).

**Mapeo del payload (OData; entre paréntesis el campo equivalente del BAPI).**

| Payload (7.4) | Destino en SAP | Nota |
|---|---|---|
| `sociedad` | `CompanyCode` (`POHEADER-COMP_CODE`) | |
| `organizacion_compras` | `PurchasingOrganization` (`PURCH_ORG`) | |
| `proveedor.codigo_sap` | `Supplier` (`VENDOR`) | El NIT y el nombre no se envían: SAP los tiene. |
| `moneda` | `DocumentCurrency` (`CURRENCY`) | |
| `condiciones_pago` | `PaymentTerms` (`PMNTTRMS`) | |
| `referencia.solicitud_id` | Campo de referencia de cabecera (por ejemplo "Su referencia") | Es la llave de idempotencia; `SOL-2026-004` cabe en 12 caracteres. |
| `posiciones[].numero` | `PurchaseOrderItem` (`POITEM-PO_ITEM`) | |
| `posiciones[].descripcion` | `PurchaseOrderItemText` (`SHORT_TEXT`) | Máximo 40 caracteres, ya recortado. |
| `posiciones[].cantidad`, `unidad` | `OrderQuantity`, `PurchaseOrderQuantityUnit` (`QUANTITY`, `PO_UNIT`) | Requiere tabla de conversión de unidades (UN, H, MES) a las del sistema. |
| `posiciones[].precio_unitario` | `NetPriceAmount` (`NET_PRICE`) | Ver la advertencia sobre el IVA más abajo. |
| `posiciones[].indicador_iva` | `TaxCode` (`TAX_CODE`) | |
| `posiciones[].centro_costo` | Imputación tipo K: `CostCenter` (`POACCOUNT-COSTCENTER`) | |
| `posiciones[].subarea` | Sin campo estándar | Hay que definirlo con contabilidad: orden interna, un campo de seguimiento o un campo Z. |
| `aprobador`, `excepciones` | Texto de cabecera | Quién aprobó, cuándo, el sha256 de la evidencia y las excepciones confirmadas. |
| Evidencia (`aprobacion.pdf`) | Adjunto del documento | Segundo paso, por el servicio de adjuntos. Si falla, la OC existe y el adjunto se reintenta. |

Datos que SAP exige y que el payload del reto no trae: clase de documento, grupo de compras,
centro logístico, grupo de artículos y cuenta de mayor. Se resuelven por configuración (valores por
defecto por centro de costo) y deben definirse con el área de compras antes de construir.

**Advertencia sobre el IVA.** En los fixtures el `valor_total` de la solicitud coincide con el
total de la cotización con IVA incluido. SAP espera el precio neto y calcula el impuesto con el
indicador. Enviar el valor con IVA como precio neto junto con el indicador C1 duplicaría el
impuesto. Antes de conectar hay que decidir si el formato de solicitud pide el valor antes de IVA o
si el adaptador calcula la base con la tasa del maestro.

**Autenticación y credenciales.** Usuario técnico de SAP con permiso solo para crear y consultar
órdenes de compra en la organización de compras 1000. OAuth 2.0 (credenciales de cliente) o
certificado; usuario y contraseña solo si no hay alternativa. Las credenciales viven en el gestor
de secretos de la plataforma donde corre el backend y las lee únicamente la implementación del
adaptador. Nunca están en el prompt, en el contexto del modelo, en el repositorio ni en los logs. El
modelo solo ve el resultado: un número de OC o un error.

**Idempotencia y reintentos.**

- Antes de crear, `buscarOrdenPorReferencia` consulta en SAP por la referencia de la solicitud. Si
  existe, se devuelve esa OC. Así un reintento tras un timeout no duplica.
- Si la creación no responde (timeout), no se reintenta a ciegas: primero se vuelve a consultar por
  la referencia. Reintentos con espera creciente y un máximo de tres.
- En OData la creación de cabecera y posiciones es una sola operación: o entra todo o nada. En el
  BAPI se revisa la tabla `RETURN`: con cualquier mensaje de error no se hace commit y se revierte.
- **Error parcial** real: la OC se crea pero falla el adjunto de la evidencia. La OC no se anula.
  El caso queda en `control.csv` como "creada, evidencia pendiente" con el número de OC, y el
  adjunto se reintenta por separado.
- Los errores de SAP (proveedor bloqueado, periodo cerrado, centro de costo inválido) se traducen
  a `{ ok: false, error }` con el mensaje original, para que la analista sepa qué corregir.
- Los maestros dejan de leerse de archivos: proveedores, centros de costo, indicadores y
  condiciones de pago se consultan en SAP, con caché corta.

**Plan B: sin conexión a SAP.** El agente sigue haciendo lo que más tiempo y riesgo quita: leer el
paquete, validar los controles, construir la OC y generar la evidencia. Cambia solo el último paso:

1. **Archivo de carga masiva.** Un adaptador `SapArchivo` implementa la misma interfaz: `crearOrden`
   agrega la OC a un archivo con la plantilla de carga que use el equipo SAP. La analista lo carga
   una vez al día en lugar de digitar cada orden.
2. **Hoja para digitar.** Si tampoco hay carga masiva, el agente genera por caso una hoja con los
   campos en el orden de la pantalla de creación de órdenes de SAP, lista para copiar, más el PDF de
   evidencia para adjuntar. Se elimina la búsqueda y la verificación; queda solo el tecleo.
3. En ambos casos el número de OC lo asigna SAP después: la analista lo registra en el chat y el
   agente completa `control.csv`. La medición de retroactivas funciona igual.

## 7. Lectura del proceso: las OC retroactivas

**Lo que diría a la dirección.**

Una OC retroactiva no es un problema de digitación: es una compra que se hizo sin orden. En
`sol-005` la cotización es del 5 de agosto, la factura del 10 de agosto, la solicitud del 27 y la
aprobación del 28. El líder aprobó 18 días después de que el proveedor facturó, y su correo lo dice:
"Ya llegó la factura, por favor crear la OC para poder radicarla". La orden dejó de ser la
autorización de la compra y pasó a ser un trámite para poder pagar.

Eso tiene tres consecuencias. El control de topes es decorativo, porque quien aprueba ya no puede
decir que no. El gasto no se compromete en el presupuesto hasta que llega la factura, así que nadie
ve lo que ya se debe. Y no hay contra qué verificar la factura, porque la orden se escribe copiando
la factura.

En los fixtures es 1 de 6 solicitudes. Esa cifra no es una medición: es un caso de prueba. La
medición real empieza con este agente, que marca cada caso en `out/control.csv`.

**Qué propondría.**

1. **Medir un mes antes de decidir.** Porcentaje de OC retroactivas por centro de costo, por
   solicitante y por proveedor. Si se concentra en compras pequeñas y recurrentes, el problema es
   de diseño del proceso; si se concentra en ciertas áreas, es de disciplina.
2. **Sacar del proceso lo que no debería pasar por él.** Las compras menores y recurrentes
   (papelería, por ejemplo) van por un contrato marco con una OC abierta por trimestre, o por un
   fondo de compras menores con tope. Pedir una OC por cada compra pequeña es lo que empuja a
   saltársela.
3. **Hacer que la regularización cueste.** Una OC retroactiva por encima de un monto mínimo la
   aprueba el nivel superior al aprobador habitual y lleva un motivo obligatorio. Hoy regularizar
   es tan fácil como hacerlo bien.
4. **Cerrar la puerta del lado del proveedor.** Regla comunicada a proveedores: la factura debe
   citar el número de OC; sin él, se devuelve. Con fecha de entrada en vigencia y un periodo de
   transición.
5. **Quitar la excusa del tiempo.** Si crear una OC limpia toma minutos con el agente, "no alcanzaba
   a esperar la orden" deja de ser un argumento.

La pregunta que la dirección debe responder, y que no le corresponde al agente, es si las tolera
con marca o las rechaza. Mi recomendación es tolerarlas con marca durante la medición y pasar a
rechazo por encima de un monto en cuanto exista la vía para compras menores. La meta que propondría
es menos de 5 % de retroactivas a los tres meses.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Las herramientas ignoran `paquete`, `derivados` y `payload` como fuente y releen el caso. | Usar lo que envía el modelo, como sugiere la firma del contrato. | Es el riesgo que el PRD nombra: que el modelo arregle un monto. Los argumentos se aceptan para cumplir el contrato y se comparan solo para avisar. El costo es releer archivos pequeños en cada llamada. |
| La OC se crea por el valor de la solicitud cuando difiere de la cotización. | Usar el valor de la cotización, o dejar elegir en el chat. | La solicitud es lo que el líder aprobó ("Aprobado por 25 millones"). Crear por 26,5 millones sería una OC por un monto que nadie aprobó. Si el valor correcto es el de la cotización, la solicitud debe corregirse y aprobarse de nuevo. |
| Un bloqueo no se puede confirmar en el chat. | Permitir que la analista lo fuerce con una confirmación. | Un bloqueo es un control de la compañía, no una duda. Si se puede saltar con un "confirmo", deja de ser un control. |
| Los intentos bloqueados y pendientes también van a `control.csv`. | Registrar solo las OC creadas. | Lo que no se creó es justo lo que auditoría quiere ver. Además permite medir cuántas solicitudes llegan mal. |
| Idempotencia en dos niveles: la herramienta consulta antes y el adaptador tampoco duplica. | Confiar en una sola verificación. | Con un SAP real hay timeouts y reintentos. Una OC duplicada es un pago duplicado en potencia. |
| El adaptador SAP se elige en un solo punto (`sapDe`). | Inyectarlo desde el servidor en el contexto de cada herramienta. | El contrato fija `ctx` en `{ directory, sessionId }`. Un punto único de sustitución cumple el contrato y deja el cambio a SAP real en una línea. |
| Validaciones adicionales (M1, M2, M3) como bloqueos, y vencimiento de cotización como aviso. | Limitarse a RC1 a RC10. | Un código de IVA inexistente lo rechazaría SAP de todas formas; es mejor decirlo antes. Lo que el PRD no clasifica como bloqueo o confirmación se dejó como aviso para no cambiar el resultado esperado de los casos. |
| `node:http` y `fetch` directos; front en HTML plano. | Framework HTTP, SDK del proveedor, React. | Corre igual en Node y Bun, sin paso de build. |

Dependencias: `zod` (obligatoria; argumentos, fixtures y esquema de la OC), `pdf-lib` (evidencia en
PDF sin binarios nativos) y `tsx` (ejecutar TypeScript en Node sin compilar).

## 9. Supuestos

1. **Fuentes de trazabilidad.** El PRD lista `solicitud`, `cotizacion`, `maestro.<nombre>` y
   `derivado`. Se agregaron `aprobacion` y `correo`, porque el aprobador y el id del correo salen de
   ahí y llamarlos "derivado" sería menos preciso.
2. **Una posición por OC.** La solicitud trae un solo ítem; el payload lleva la posición 10.
3. **Unidad.** No viene en la solicitud. Se infiere de la descripción: "horas" da `H`; "N meses de"
   con N igual a la cantidad da `MES`; en otro caso `UN`. Queda marcada como derivada en la traza.
4. **Descripción de 40 caracteres.** Se recorta en palabra completa. El texto original queda en
   `trazabilidad.json`.
5. **RC8 literal.** Retroactiva es factura con fecha anterior a la solicitud. Si hay factura con
   fecha igual o posterior, se deja un aviso pero no se marca.
6. **RC9 por fecha, no por hora.** Se compara el día de la aprobación con `fecha_solicitud`.
7. **Topes en COP.** Una solicitud en USD se bloquea por RC3 porque no hay tasa de cambio definida.
8. **Solicitud o correo ausentes** devuelven `{ ok: false }`: sin ellos no hay caso. Cotización,
   aprobación y factura ausentes se devuelven como `null` y los controles deciden.
9. **Herramienta adicional** `oc_solicitar_confirmacion`: no está en el contrato mínimo. Sirve para
   que "esperando confirmación" sea un hecho registrado (y una fila en `control.csv`), también
   cuando la analista pide no crear todavía una OC limpia.
10. **`confirmado_por`** registra "analista (sesión …)" porque no hay autenticación. En producción
    sería la identidad del usuario.
11. **Valores con IVA incluido.** La OC lleva el `valor_unitario` de la solicitud tal cual. La
    implicación para un SAP real está en la sección 6.

## 10. Cobertura

| Historia | Estado | Evidencia | Falta para producción |
|---|---|---|---|
| HU-1 Leer el paquete | Hecho | `oc_leer_paquete`; adjunto ausente como `null` y listado en `faltantes`. | Leer el `.xlsx`, el PDF y el `.eml` reales. |
| HU-2 Validar | Hecho | `oc_validar`; RC1 a RC10 más M1 a M3, con acción sugerida por bloqueo. | Maestros consultados en SAP en tiempo real. |
| HU-3 Payload | Hecho | `oc_construir_payload`; válido contra `OrdenCompraSchema`; `trazabilidad.json`. | Varias posiciones y los campos que SAP exige (sección 6). |
| HU-4 Evidencia (P0 txt, P1 pdf) | Hecho | `aprobacion.txt` y `aprobacion.pdf` con sha256. | Conservar el `.eml` original; firma digital si auditoría la exige. |
| HU-5 Crear en SAP simulado | Hecho | `oc_crear`; numeración desde 4500000001, idempotencia, `control.csv`. | Adaptador SAP real. |
| HU-6 Errores | Hecho | Paquete incompleto, JSON malformado y monto no numérico devuelven un error legible con qué pedir. | Alertas y métricas. |
| `oc_leer_excel` (P1 opcional) | No hecho | Los fixtures traen la solicitud como JSON. | Lectura de Excel. |
| Bonus módulo | Hecho | `modulo/` generado desde las mismas fuentes, incluido `sap/`; `--check` detecta divergencia. | Probarlo dentro de la plataforma destino. |

Los seis casos dan el resultado esperado por los objetivos O1 a O4 (`npm run demo`): `sol-001`
crea OC sin intervención; `sol-002` y `sol-003` se bloquean; `sol-004`, `sol-005` y `sol-006`
esperan confirmación; `sol-005` queda con `retroactiva = true`.

## 11. Uso de IA

| Asistente | Para qué | Qué se descartó o corrigió |
|---|---|---|
| Claude (claude.ai) | Lectura del PRD y los fixtures, diseño de los controles y del adaptador SAP, código completo, pruebas, análisis de las OC retroactivas y este documento. Reutilizó la base de los Retos 01 y 02 (servidor, ciclo, adaptador y chat). | Se descartó usar como fuente el paquete y el payload que envía el modelo. Se descartó convertir el vencimiento de la cotización en una confirmación, para no alterar los resultados esperados. Se corrigió la acción sugerida de `sol-003`, que estaba mal redactada, y el recorte de la descripción, que terminaba en una preposición suelta. |
| Gemini (`gemini-3-flash-preview`) | Es el modelo que ejecuta el agente. No se usó para escribir código. | No aplica. |

Trabajo propio: PENDIENTE (qué revisé línea por línea, qué cambié y qué probé con el modelo real).

El diseño del adaptador SAP (sección 6) lo propuso el asistente a partir de conocimiento general de
SAP y no se validó contra un sistema real.

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| La conexión a SAP no es viable a corto plazo. | Plan B de la sección 6: mismo agente, salida a archivo de carga o a hoja para digitar. |
| OC duplicada por reintento. | Consulta por referencia antes de crear y después de un timeout; el adaptador tampoco duplica. |
| IVA duplicado por enviar valores con IVA como precio neto. | Decidir la convención antes de conectar (sección 6) y probar con un caso real en ambiente de calidad. |
| Maestros desactualizados (aprobadores, topes, proveedores). | Consultarlos en SAP y en el sistema de delegaciones, no en archivos. Un dueño por maestro. |
| Aprobación falsificada o reenviada: el correo es texto. | Tomar el `.eml` original con sus cabeceras desde el buzón, no un texto pegado. Firma o flujo de aprobación si auditoría lo exige. |
| "Aprobado" dentro de una frase que no aprueba. | La detección descarta negaciones comunes; ante duda, pedir respuesta explícita. En producción, botón de aprobación en lugar de texto libre. |
| Fraccionamiento de compras para quedar bajo el tope. | Hoy no se detecta. Con `control.csv` se puede alertar por solicitudes del mismo proveedor y centro en pocos días. |
| El modelo altera un valor. | Ninguna herramienta toma valores del modelo; la OC se reconstruye desde el caso. |
| Inyección de instrucciones en la cotización o en el correo de aprobación. | Esos textos llegan al modelo recortados y solo como datos. Aunque el modelo obedeciera, no puede saltar un bloqueo ni confirmar por el usuario: lo impiden la herramienta y el backend. |
| Abuso del link público y gasto de la clave. | Topes por sesión, por día y por IP. En producción, autenticación corporativa; `/api/reset` debe desaparecer. |
| Confirmación por coincidencia de texto ("sí", "confirmo"). | Es estricta: ante duda no autoriza. En producción, botón con identidad del aprobador. |
| Disco efímero en el despliegue. | `control.csv` y las evidencias deben ir a almacenamiento persistente: son registros de auditoría. |
