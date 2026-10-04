# SOLUCION · Reto 02 "Registro de contratos vigentes"

## 1. Problema en una frase

Desde el 30 de mayo de 2026 nadie alimenta el maestro de contratos, así que la gerencia no puede
decir qué contratos están vigentes, cuáles vencen ni qué pólizas faltan. Le duele a la analista
administrativa, que heredó un maestro congelado sin un canal de entrada, y a la empresa, que asume
el riesgo de pólizas no constituidas y contratos vencidos sin gestión.

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
                                             │ src/tools/contratos.ts (6 herramientas)       │
                                             └───────┬───────────────────────┬───────────────┘
                                         fixtures/reto-02 (lectura)     out/ (escritura)
                                                                        └ sharepoint/ maestro, historial, Contratos/
```

| Qué | Dónde vive | Cambia cuando |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cambia el orden de pasos, el tono o lo que el agente tiene prohibido. |
| Conocimiento | `src/knowledge/registro-contratos.md` | Cambia una regla del proceso que el agente debe poder explicar. |
| Ejecución | `src/tools/contratos.ts` | Cambia cómo se extrae, se clasifica o se escribe. |
| Transporte | `src/server.ts` | Cambia la API. No contiene reglas de negocio. |

El prompt y el conocimiento se concatenan al arrancar y forman el mensaje de sistema. Las
herramientas no importan nada del servidor: `demo.ts` y `modulo/` las usan directamente.

`contratos_validar` y `contratos_registrar` comparten una sola función (`evaluar`). No es posible
que la validación diga una cosa y el registro haga otra.

## 3. Ciclo del agente

`ejecutarTurno` (en `src/agent/ciclo.ts`) hace lo siguiente por cada mensaje del usuario:

1. Revisa si el turno anterior dejó confirmaciones pendientes y si el mensaje actual es una
   afirmación explícita. Si ambas se cumplen, esos mensajes quedan autorizados para este turno. Las
   pendientes se borran siempre: solo valen para el mensaje inmediatamente siguiente.
2. Llama al modelo con sistema + historial + definiciones de herramientas.
3. Si el modelo pide herramientas (puede pedir varias en un mismo paso), cada una pasa por
   `aplicarConfirmacion`, luego por la validación zod y luego se ejecuta. Los resultados vuelven al
   modelo y se repite el paso 2.
4. Si el modelo responde solo texto, el turno termina.

**Tope de iteraciones (CA1).** `MAX_ITERACIONES` (25). Al alcanzarlo, el backend arma una respuesta
determinista con lo ejecutado y lo que falta, sin otra llamada al modelo.

**Confirmación humana (CA3, RN5).** Tiene dos capas, y ninguna depende de que el modelo obedezca:

- La herramienta: `contratos_registrar` rechaza con "requiere revisión: …" si hay campos en
  revisión y no llega `confirmado: true`.
- El backend: si el modelo envía `confirmado: true` sin que el usuario haya confirmado ese mensaje
  en su último turno, el ciclo cambia el argumento a `false` antes de ejecutar. El turno cierra con
  `needsConfirmation: true` y el front muestra el aviso ámbar con los botones de confirmar.

`contratos_solicitar_confirmacion` es la vía normal: el agente la llama antes de preguntar. La
autorización es de un solo uso. `scripts/prueba-ciclo.ts` lo comprueba con un modelo guionizado que
intenta registrar lo dudoso por su cuenta.

**Valores sin invención (CA2).** La confianza la calcula siempre la extracción determinista; el
modelo no puede enviarla. Si el contrato que manda el modelo trae un valor distinto al del
documento, ese campo entra en revisión con confianza 0 y exige confirmación humana. Es el camino
previsto para que la analista corrija un dato, y cierra el camino para que el modelo "redondee".

**Errores (CA5).** Las herramientas devuelven `{ ok: false, error }` y nunca lanzan. Un fallo del
proveedor LLM se traduce a una frase clara y la sesión sigue viva. Ante un 429 (límite de la capa
gratuita) el adaptador espera 15 segundos y reintenta hasta tres veces antes de reportarlo.

**Trazabilidad (CA4, RN7).** Cada llamada aparece en el chat y en `out/log.jsonl` con
`{ ts, herramienta, mensaje_id, ok, resumen }`. La traza la escribe la propia herramienta, así que
`demo.ts` deja el mismo log que el chat. Las llamadas que no llegan a ejecutarse (argumentos
inválidos, herramienta inexistente) las registra `registro.ts`.

## 4. Elección del modelo

**Google Gemini, `gemini-3-flash-preview`**, por su endpoint compatible con OpenAI Chat Completions
(`src/llm/openai.ts`). Se configura con `LLM_PROVIDER`, `LLM_MODEL` y `OPENAI_BASE_URL`.

- El modelo solo orquesta herramientas y redacta el resumen. Extracción, clasificación y registro
  son deterministas, así que un modelo de gama Flash es suficiente.
- Tiene capa gratuita en la API, lo que permite desarrollar y demostrar sin costo.
- El adaptador conserva la firma de razonamiento que Gemini 3 exige devolver en cada llamada a
  herramienta (`LlamadaHerramienta.extra`), sin que el ciclo del agente sepa de ella.

El adaptador de Anthropic (`src/llm/anthropic.ts`) también está implementado; cambiar a
`claude-haiku-4-5` es cambiar variables de entorno.

**Costo por caso.** En la capa gratuita es cero. Como referencia para producción, con el precio de
lista de la capa de pago (USD 0,50 por millón de tokens de entrada y USD 3,00 por millón de salida):

| Concepto | Tokens aproximados |
|---|---|
| Sistema + definiciones de herramientas, por llamada | 4.500 |
| Llamadas al modelo para un buzón de 6 mensajes | 6 a 8 si agrupa herramientas; hasta 22 si las pide de una en una |
| Entrada acumulada, lote de 6 mensajes | 45.000 |
| Salida, incluido razonamiento | 4.000 |

Esto da cerca de **USD 0,035 por lote de 6 mensajes, unos USD 0,006 por contrato**. Son cifras
estimadas. Medición real con el prompt de ejemplo: **PENDIENTE tokens** (el front muestra el
total de la sesión).

En la capa gratuita Google puede usar las solicitudes para mejorar sus productos. Los fixtures son
ficticios; con contratos reales se usaría la capa de pago o un proveedor con acuerdo de tratamiento
de datos. Hoy el texto completo del contrato no llega al modelo: llegan los campos ya extraídos
(el objeto, de hasta 200 caracteres, es el único texto libre).

Controles de gasto: tope de iteraciones, tope de tokens por sesión, tope global diario, límite de
solicitudes por IP, tope de caracteres por mensaje y tope de tokens por respuesta.

## 5. Estrategia de extracción

Toda la extracción es determinista (`extraerDeTexto` en `src/tools/contratos.ts`). El documento se
parte en párrafos y cada dato se busca en la cláusula que lo contiene.

| Campo | Cómo se encuentra | Confianza |
|---|---|---|
| `id_contrato` | Número en el título (`No. CT-2026-015`). En un otrosí, el del contrato que modifica. | 0,95; 0 si no hay número (se asigna `AUTO-<año>-<secuencia>` al registrar). |
| `cliente`, `nit_cliente` | Primera parte con NIT, RUC o RTN que no sea Periferia. El nombre se toma con la grafía de la firma. El NIT se guarda sin puntos ni dígito de verificación. | 0,95 |
| `pais` | Por el tipo de identificador (NIT → CO, RTN → HN, RUC según longitud). | 0,95 si el domicilio lo confirma; 0,9 solo por identificador; 0,6 si se contradicen. |
| `objeto` | Cláusula OBJETO, recortada a 200 caracteres. | 0,9 |
| `valor`, `moneda` | Cifra con código de moneda en la cláusula VALOR. La cifra se contrasta con el valor en letras, que se convierte a número. | 0,95 si cifra y letras coinciden; 0,85 si no hay letras; 0,4 si no coinciden. |
| Valor por demanda | Frases como "no tiene un valor determinado". Se propone 0. | 0,5: siempre va a revisión. |
| `fecha_inicio`, `fecha_fin` | "desde el … (1) de agosto de 2026 hasta el …" en la cláusula PLAZO. Si además hay plazo en meses, se verifica que cuadre. | 0,95; 0,6 si la fecha escrita no cuadra con el plazo. |
| Fecha derivada | Plazo en meses desde una fecha de inicio completa. | 0,85 |
| Fecha derivada de la firma sin día | El documento solo da mes y año de firma. Inicio el día 1; fin el último día del mes en que se cumple el plazo. | Inicio 0,8; fin 0,5: va a revisión. |
| `requiere_poliza`, `tipo_poliza` | Cláusulas que mencionan póliza o garantía; el tipo sale de un catálogo de palabras clave. | 0,95; 0,9 cuando no hay ninguna mención; 0,8 si la póliza está condicionada; 0,6 si no se reconoce el tipo. |

Un campo que no está en el texto es `null` con confianza 0. Texto vacío, fecha imposible o moneda
fuera del catálogo devuelven `{ ok: false, error }`.

**Dónde entra el modelo y dónde no.** El modelo no extrae ni lee el contrato. Decide qué herramienta
llamar, interpreta la respuesta de la analista y redacta. Si la analista dicta una corrección, el
modelo la pasa en el argumento `contrato`; por ser distinta al documento entra en revisión y solo se
registra con confirmación. La decisión de qué queda en el maestro nunca es del modelo.

**Límite conocido.** Las expresiones regulares siguen la redacción de los contratos de los fixtures.
Un contrato con otra estructura dará campos en `null` y confianza baja, que es el fallo correcto:
va a revisión humana en lugar de registrarse mal. Ahí es donde un modelo puede aportar después,
proponiendo valores que un humano confirma.

## 6. Regla de gobierno

**Política de recepción y registro de contratos. Vigencia inmediata.**

1. **Canal único.** Todo contrato se envía a `contratos@periferia-ficticia.com`. El buzón lo
   administra la analista administrativa, que es la dueña del maestro. Mientras no exista área
   legal, la Gerencia Administrativa y Financiera es la responsable del proceso y de sus
   excepciones. Un contrato enviado a un correo personal no se considera entregado.

2. **Obligación del comercial.** El comercial que cierra el negocio envía al buzón, dentro de los
   **3 días hábiles** siguientes a la firma:
   - el contrato firmado por ambas partes, en PDF con texto (no fotografía), con o sin póliza;
   - todo otrosí, prórroga o modificación;
   - toda acta de terminación o liquidación.

   Asunto obligatorio: `[CONTRATO|OTROSI|TERMINACION] <cliente> - <número de contrato>`. El cuerpo
   indica si el contrato exige póliza. Cotizaciones y borradores no van a este buzón.

3. **Acuse automático.** El agente responde al remitente en menos de **1 hora hábil** con el
   resultado: registrado (con el número y la ruta de archivo), actualizado, duplicado, rechazado
   (con el motivo) o en revisión (con los campos que la analista debe confirmar). Sin acuse, el
   comercial debe asumir que el contrato no llegó. *En este reto el acuse no se envía: el resultado
   queda en el chat y en `out/log.jsonl`.*

4. **Excepciones y escalamiento.**
   - Contrato sin firmar: se rechaza y se devuelve al comercial. No entra al maestro.
   - Contrato sin valor determinado (marco o por demanda): se registra con valor 0 tras confirmación
     de la analista, y cada orden de servicio se envía al buzón como otrosí.
   - Campos en revisión sin resolver en **2 días hábiles**: la analista escala al comercial; a los
     **5 días hábiles**, a su director.
   - Remitente que no es comercial registrado: se registra el contrato y se pide a la dirección
     comercial que asigne el responsable.
   - Póliza pendiente más de **10 días hábiles** desde el registro: se escala a la Gerencia
     Administrativa y Financiera.

5. **Cierre del vacío de junio a agosto de 2026.** Una sola campaña de dos semanas:
   - Facturación entrega la lista de clientes facturados desde el 1 de junio.
   - La analista la cruza contra el maestro y obtiene los contratos facturados que no están
     registrados.
   - Cada comercial recibe su lista y tiene **5 días hábiles** para enviar esos contratos al buzón
     con el asunto estándar.
   - El agente los procesa como cualquier otro mensaje. La sección "registrados después del corte"
     del reporte de alertas mide el avance.
   - Lo que no aparezca al cierre se reporta a gerencia, por comercial.

6. **Indicador mensual.** **Porcentaje de clientes facturados en el mes que tienen un contrato
   vigente en el maestro.** Meta: 100 %. Lo calcula la analista el día 5 de cada mes y lo presenta
   a gerencia. Indicador secundario: días entre la firma y el registro, con meta de 5 días hábiles
   o menos. Si el indicador principal baja de 95 %, se repite la campaña del punto 5 para ese mes.

**Consecuencia de no cumplir.** Un contrato que no está en el maestro no tiene seguimiento de
póliza ni de vencimiento. Facturación no emite la segunda factura de un contrato que no esté
registrado.

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista con confianza calculada por reglas. | Que el modelo lea el contrato y devuelva los campos. | El PRD la pide como P0 y es reproducible. Un modelo puede redondear un valor o inferir una fecha sin avisar; una regla que no encuentra el dato devuelve `null`. El costo es rigidez ante formatos nuevos, que cae en revisión humana. |
| `validar` y `registrar` comparten la función `evaluar`, y `registrar` vuelve a evaluar. | Que `registrar` confíe en el resultado previo de `validar`. | El maestro pudo cambiar entre las dos llamadas y el modelo pudo alterar el contrato. Reevaluar cuesta milisegundos y elimina la inconsistencia. |
| `registrar` cierra también duplicados y rechazados (sin escribir en el maestro). | Una herramienta aparte para descartar. | Un solo verbo para cerrar un mensaje simplifica al agente y a `demo.ts`. La garantía se mantiene: en esos casos no se toca el maestro ni el historial. |
| El argumento `contrato` es opcional y solo sirve para correcciones. | Exigir que el modelo reenvíe el contrato completo. | Menos tokens y menos oportunidad de que el modelo altere un dato al copiarlo. Lo que llega distinto al documento va a revisión. |
| La confirmación la aplica el backend además de la herramienta. | Confiar en `confirmado` tal como lo envía el modelo. | `confirmado: true` lo escribe el modelo; sin control del backend, la revisión humana sería opcional. |
| El maestro se reescribe completo con archivo temporal y renombrado. | Agregar líneas al CSV. | Una actualización modifica una fila existente. El renombrado atómico evita un maestro a medio escribir. |
| Un otrosí que cambia el plazo deja la póliza en `pendiente`. | Conservar `vigente`. | El propio otrosí dice que las garantías deben ampliarse. Si no se marca, el riesgo no aparece en las alertas. |
| Las alertas incluyen contratos ya vencidos. | Solo los que vencen en los próximos 60 días. | Con el maestro congelado hay contratos vencidos que nadie gestionó. Omitirlos esconde el riesgo más urgente. |
| `node:http` y `fetch` directos; front en HTML plano. | Framework HTTP, SDK del proveedor, React. | Corre igual en Node y Bun, sin paso de build, con una sola dependencia de ejecución además de `tsx`. |

Dependencias: `zod` (obligatoria; valida argumentos y fixtures y genera el JSON Schema) y `tsx`
(ejecutar TypeScript en Node sin compilar). El CSV se lee y escribe con un parser propio de 30
líneas para no agregar una dependencia.

## 8. Supuestos

1. **`msg-006`, fecha de inicio.** El contrato dice "se firma en el mes de agosto de 2026" sin día.
   Se toma el día 1 con confianza 0,8 y una nota. Así el resultado coincide con el PRD, que espera
   en revisión solo `valor` y `fecha_fin`.
2. **`msg-006`, fecha de fin.** Doce meses desde una firma sin día: se propone el último día del
   mes en que se cumple el plazo (2027-08-31), que es la fecha que usa el PRD en su ejemplo.
3. **`msg-006`, póliza.** La póliza es condicional (por orden de servicio de más de COP 100
   millones). Se registra `requiere_poliza = true` con una nota, porque es más seguro alertar de
   más que de menos.
4. **Otrosí de un contrato que no está en el maestro**: se rechaza con el motivo "hay que pedir el
   contrato original". Registrarlo como nuevo dejaría un contrato sin objeto ni fecha de inicio.
5. **Conflicto con el maestro** significa: mismo contrato con otro NIT, país o moneda, o un cambio
   de valor o fechas que no viene en un otrosí. Las diferencias de redacción en cliente u objeto no
   se aplican salvo que vengan en un otrosí.
6. **Remitente desconocido**: el contrato se registra con `comercial` vacío y un aviso.
7. **Archivo de un otrosí**: va a la carpeta del contrato original como
   `<id>-otrosi-<número>.<ext>`. La columna `ruta_sharepoint` sigue apuntando al contrato; la ruta
   del otrosí queda en el historial.
8. **`fecha_registro`** es la fecha del sistema, o `FECHA_EJECUCION` si se define.
9. **Herramienta adicional** `contratos_solicitar_confirmacion`: no está en el contrato mínimo. Hace
   que "esperando confirmación" sea un hecho registrado y no una interpretación del texto.
10. **Un mensaje ya procesado no se registra dos veces**: `registrar` lo rechaza.

## 9. Cobertura

| Historia | Estado | Evidencia | Falta para producción |
|---|---|---|---|
| HU-1 Leer el buzón | Hecho | `leer_buzon`; detecta el contrato por contenido, no por nombre de archivo. | Conexión real a Exchange. |
| HU-2 Extraer | Hecho | `extraer`; confianza por campo, `null` cuando no hay dato. | OCR y formatos de contrato distintos a los de los fixtures. |
| HU-3 Validar y clasificar | Hecho | `validar`; RN1 a RN4, revisión y conflictos; comercial resuelto. | Catálogo de clientes para detectar variaciones de nombre. |
| HU-4 Registrar y archivar | Hecho | `registrar`; maestro, archivo, `historial.jsonl`, `procesados.json`. | SharePoint real y control de concurrencia entre usuarios. |
| HU-5 Alertar | Hecho | `alertas`; tres secciones, fecha de referencia como argumento. | Envío programado del reporte a gerencia. |
| HU-6 Errores | Hecho | Ninguna herramienta lanza; un mensaje malo no detiene el lote. | Alertas operativas y métricas. |
| `contratos_leer_pdf` (P1 opcional) | No hecho | Los fixtures traen el texto. Un adjunto PDF se reporta como formato no legible. | Extracción de texto de PDF y OCR. |
| Acuse al comercial | No hecho | Definido en la regla de gobierno. | Integración de correo saliente. |
| Bonus módulo | Hecho | `modulo/` generado desde las mismas fuentes; `--check` detecta divergencia. | Probarlo dentro de la plataforma destino. |

Los seis mensajes del buzón dan el resultado esperado en la sección 7.4 del PRD (`npm run demo`).

## 10. Uso de IA

| Asistente | Para qué | Qué se descartó o corrigió |
|---|---|---|
| Claude (claude.ai) | Lectura del PRD y los fixtures, diseño de la extracción y de las reglas de clasificación, código completo, pruebas, regla de gobierno y este documento. Reutilizó la base del Reto 01 (servidor, ciclo, adaptador y chat). | Se descartó una herramienta separada para descartar mensajes. Se descartó que el modelo reenviara el contrato completo. Se corrigió un reemplazo automático que dañó `web/app.js` durante la construcción; el archivo se rehízo desde la versión del Reto 01. Se quitó el log duplicado entre el ciclo y las herramientas. |
| Gemini (`gemini-3-flash-preview`) | Es el modelo que ejecuta el agente. No se usó para escribir código. | No aplica. |

Trabajo propio: PENDIENTE (qué revisé línea por línea, qué cambié y qué probé con el modelo real).

## 11. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El comercial no envía el contrato. | La regla de gobierno, el indicador mensual y el bloqueo de facturación. Sin eso el agente registra solo lo que llega, igual que hoy. |
| Falsos duplicados o falsos nuevos por variaciones del nombre del cliente. | La coincidencia es por número de contrato y por NIT, nunca por nombre. |
| Contratos con otra redacción o escaneados. | Campos en `null` y confianza baja: van a revisión, no al maestro. Siguiente paso: OCR y propuesta del modelo con confirmación humana. |
| El modelo altera un valor. | Lo distinto al documento entra en revisión con confianza 0; el backend exige confirmación del usuario. |
| Dos personas procesan el buzón a la vez. | Hoy el maestro es un archivo y no hay bloqueo. En producción, la lista de SharePoint con control de versiones o una base de datos. |
| Contenido del contrato enviado a un proveedor externo. | Hoy solo viajan los campos extraídos. Si se envía el texto, usar un proveedor con acuerdo de tratamiento de datos. |
| Inyección de instrucciones en el cuerpo del correo o del contrato. | El cuerpo del correo no llega al modelo; del contrato solo llegan campos extraídos y acotados (el objeto, hasta 200 caracteres). Las escrituras dudosas siguen detrás de la confirmación del backend. |
| Abuso del link público y gasto de la clave. | Topes por sesión, por día y por IP. En producción, autenticación corporativa. `/api/reset` debe desaparecer o protegerse. |
| Confirmación por coincidencia de texto ("sí", "confirmo"). | Es estricta: ante duda no autoriza. En producción, botón con identidad del aprobador. |
| Disco efímero en el despliegue. | Mover `out/` a almacenamiento persistente con retención definida. |
