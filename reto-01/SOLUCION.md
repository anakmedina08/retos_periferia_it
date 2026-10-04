# SOLUCION · Reto 01 "Registro como proveedor"

## 1. Problema en una frase

La analista administrativa transcribe a mano, entre 8 y 12 veces al mes, los mismos datos de
Periferia a formularios de clientes con formatos distintos, con riesgo de error en datos sensibles
(NIT, cuenta bancaria) y días de demora que retrasan la facturación. Le duele a ella, que queda
sola con el proceso, y a la empresa, que cobra más tarde.

## 2. Arquitectura

```
┌────────────────┐  POST /api/chat (NDJSON)  ┌──────────────────────────────────────────────┐
│ web/           │ ────────────────────────▶ │ src/server.ts   transporte, límites de uso    │
│ chat, llamadas │ ◀──────────────────────── │        │                                      │
│ confirmación   │      eventos por línea    │        ▼                                      │
└────────────────┘                           │ src/agent/ciclo.ts  ── src/llm/adapter.ts ──▶ modelo
                                             │   │  confirmacion.ts      anthropic | openai  │
                                             │   ▼                                           │
                                             │ src/tools/registro.ts  (zod → JSON Schema)    │
                                             │   ▼                                           │
                                             │ src/tools/proveedor.ts (6 herramientas)       │
                                             └───────┬───────────────────────┬───────────────┘
                                         fixtures/reto-01 (lectura)     out/ (escritura)
```

| Qué | Dónde vive | Cambia cuando |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cambia el tono, el orden de pasos o lo que el agente tiene prohibido. |
| Conocimiento | `src/knowledge/registro-proveedor.md` | Cambia una regla del proceso que el agente debe poder explicar. |
| Ejecución | `src/tools/proveedor.ts` | Cambia cómo se calcula o se escribe algo. |
| Transporte | `src/server.ts` | Cambia la API. No contiene reglas de negocio. |

El prompt y el conocimiento se concatenan al arrancar y forman el mensaje de sistema. Las
herramientas no importan nada del servidor: `demo.ts` y `modulo/` las usan directamente.

## 3. Ciclo del agente

`ejecutarTurno` (en `src/agent/ciclo.ts`) hace lo siguiente por cada mensaje del usuario:

1. Revisa si el turno anterior dejó una confirmación pendiente y si el mensaje actual es una
   afirmación explícita. Si ambas se cumplen, la acción queda autorizada para este turno. La
   pendiente se borra siempre: solo vale para el mensaje inmediatamente siguiente.
2. Llama al modelo con sistema + historial + definiciones de herramientas.
3. Si el modelo pide herramientas, cada una pasa por `aplicarConfirmacion`, luego por la validación
   zod y luego se ejecuta. El resultado vuelve al modelo y se repite el paso 2.
4. Si el modelo responde solo texto, el turno termina.

**Tope de iteraciones (CA1).** `MAX_ITERACIONES` (25). Al alcanzarlo, el backend arma una respuesta
determinista con lo ejecutado y lo que falta, sin otra llamada al modelo.

**Confirmación humana (CA3, RN4).** No depende de que el modelo obedezca el prompt. Si el modelo
llama a `proveedor_simular_envio` con `confirmado: true` sin autorización vigente para ese caso, el
backend cambia el argumento a `false`, la herramienta responde "requiere confirmación explícita" y
el turno cierra con `needsConfirmation: true`. La autorización es de un solo uso.
`proveedor_solicitar_confirmacion` es la vía normal: el agente la llama antes de preguntar y eso
enciende el aviso ámbar en el front. `scripts/prueba-ciclo.ts` comprueba los cuatro escenarios con
un modelo guionizado que intenta saltarse la regla.

**Valores sin invención (CA2).** `generar_formulario` recibe el mapeo, pero solo toma de él la
decisión (etiqueta → ruta). El valor se vuelve a leer del maestro. Aunque el modelo escriba un
valor propio en el mapeo, no llega al formulario. Las rutas `banco.*` solo se aceptan si el glosario
asocia esa etiqueta a ese dato bancario (RN2).

**Errores (CA5).** Las herramientas devuelven `{ ok: false, error }` y nunca lanzan. Un fallo del
proveedor LLM (timeout, 401, 429) se traduce a una frase clara, se muestra en el chat y la sesión
sigue viva.

**Trazabilidad (CA4, RN5).** Cada llamada aparece en el chat, en `out/log.jsonl` (global, con
argumentos) y en `out/<caso>/log.jsonl` (por caso, escrito por la propia herramienta).

## 4. Elección del modelo

**Anthropic, `claude-haiku-4-5`**, configurable con `LLM_MODEL`.

El trabajo del modelo aquí es orquestar cinco herramientas en orden y redactar un resumen. Toda la
lógica de negocio es determinista y vive en las herramientas, así que no hace falta un modelo
grande. Haiku es el más barato de la familia, sigue bien instrucciones de uso de herramientas y
responde rápido, que es lo que nota la analista.

Costo estimado por caso (precio de lista de referencia: USD 1 por millón de tokens de entrada y
USD 5 por millón de salida; verificar el precio vigente antes de la defensa):

| Concepto | Tokens aproximados |
|---|---|
| Sistema + definiciones de herramientas, por llamada | 2.800 |
| Llamadas al modelo por caso | 6 |
| Entrada acumulada (el historial crece en cada vuelta) | 25.000 |
| Salida (llamadas + resumen final) | 1.200 |

Esto da cerca de **USD 0,03 por caso** y menos de USD 0,50 al mes con 12 solicitudes. El front
muestra los tokens reales de la sesión para contrastar la estimación. El adaptador marca el sistema
y las herramientas como cacheables; el ahorro aplica cuando el prefijo supera el mínimo cacheable
del modelo.

Controles de gasto: tope de iteraciones, tope de tokens por sesión, tope global diario, límite de
solicitudes por IP, tope de caracteres por mensaje y `max_tokens` por respuesta.

## 5. Diseño del portal web (no implementado)

**Estrategia.** Navegador asistido en el equipo de la analista, no RPA desatendido. Una extensión de
navegador (o Playwright en modo visible) abre el portal, la persona inicia sesión y el agente
rellena los campos que reconoce con los valores de `valores-portal.md`. La persona revisa y hace
clic en Enviar.

| Alternativa | Por qué no es la primera opción |
|---|---|
| RPA desatendido en servidor | Obliga a guardar credenciales del representante legal en un servidor y se rompe con MFA o CAPTCHA. |
| Agente que controla el navegador por visión | Costoso por caso, lento y frágil ante cambios de layout; difícil de auditar. |
| Extensión que rellena y no envía (elegida) | La sesión y las credenciales nunca salen del navegador de la persona. |

**Límites.** CAPTCHA y MFA los resuelve la persona. Un cambio de layout degrada a "copiar y pegar
desde `valores-portal.md`", que es lo que ya entrega este reto. El mapeo campo del portal → clave
del maestro se guarda por cliente y se versiona; si un selector no aparece, el campo se reporta como
no llenado en lugar de adivinar.

**Credenciales.** Viven en el gestor de contraseñas corporativo, a nombre de quien el cliente
autorizó. Las ingresa una persona en el portal. Nunca están en el repositorio, en el prompt, en el
contexto del modelo ni en los logs. El agente solo recibe la URL y los nombres de los campos.

**Reparto.** El agente prepara valores, rellena campos de texto y lista los soportes a cargar. La
persona ingresa credenciales, resuelve MFA y CAPTCHA, carga los archivos, revisa y envía.

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| El mapeo es determinista (glosario + similitud de tokens) y el modelo solo orquesta. | Pedirle al modelo que mapee etiquetas a claves. | Un mapeo hecho por el modelo no es reproducible ni auditable, y abre la puerta a valores inventados. El costo es que una etiqueta nueva cae en `faltante` hasta que alguien la agrega al glosario; es el fallo correcto. |
| La confirmación la aplica el backend, además del prompt. | Confiar en la instrucción del prompt. | Un prompt es una petición, no un control. Con datos bancarios y acciones externas la garantía tiene que estar en código y poder probarse. |
| `generar_formulario` relee los valores del maestro e ignora los que traiga el mapeo. | Escribir lo que el modelo envía. | Elimina la clase completa de error "el modelo cambió un dígito de la cuenta". |
| Una coincidencia difusa nunca supera 0,79 de confianza y no se escribe. | Aceptar similitud alta como match. | Una etiqueta parecida puede ser otro dato ("Número de cuenta" frente a "Número de contribuyente"). Dejar en blanco y preguntar cuesta segundos; llenar mal cuesta un rechazo. |
| `node:http` y `fetch` directos, sin framework ni SDK. | Hono o Express, SDK del proveedor. | Corre igual en Node y Bun, menos dependencias que justificar y el adaptador queda en 60 líneas legibles. Se pierde streaming de tokens, que aquí no aporta. |
| HTML, CSS y JS planos para el front. | React o Svelte. | Una sola pantalla; sin paso de build se cumple "un comando" y el despliegue es trivial. |
| Sesiones en memoria con respaldo en archivo. | Base de datos. | El PRD la excluye. En producción se reemplaza `sesiones.ts` sin tocar el ciclo. |

Dependencias: `zod` (obligatoria; valida argumentos y fixtures, y genera el JSON Schema),
`exceljs` (escribir celdas por hoja y dirección), `pdf-lib` (PDF sin binarios nativos), `tsx`
(ejecutar TypeScript en Node sin compilar).

## 7. Supuestos

1. **Fecha de ejecución** es la fecha del sistema, o `FECHA_EJECUCION` si se define. Con la fecha
   de hoy la Cámara de Comercio (vigente hasta 2026-09-30) y los parafiscales (2026-08-31) están
   vencidos, así que ningún caso queda listo para firma. Con `FECHA_EJECUCION=2026-09-03`
   `co-industrias-delta` sí queda listo.
2. **RN1**: para clientes fuera de Colombia el campo tributario se escribe con el NIT y además
   queda en `requiere_confirmacion`. Las dos cosas a la vez, como dice la regla.
3. **Portal**: `listo_para_firma` es siempre `false` porque no existe un documento que firmar. El
   paquete se arma igual con soportes, checklist y `valores-portal.md`.
4. **Envío simulado de un paquete no listo**: se permite tras confirmación y queda advertido en
   `ENVIO-SIMULADO.md`. El ejemplo de la sección 11 del PRD lo exige con `ec-corp-andina`, que tiene
   un soporte ausente.
5. **Campos `requiere_confirmacion`** no bloquean la firma (RN3 no los menciona), pero figuran en
   el checklist.
6. **Borrador de correo**: va dirigido al cliente y no incluye ningún valor del maestro, solo
   nombres de campos y de soportes. Así RN2 se cumple por construcción.
7. **"Ingresos anuales"** se escribe como el número del maestro, sin moneda, porque la plantilla
   no la pide y agregarla sería completar un dato no solicitado.
8. **Herramienta adicional** `proveedor_solicitar_confirmacion`: no está en el contrato mínimo. Se
   agregó para que el estado "esperando confirmación" sea un hecho registrado y no una
   interpretación del texto del modelo.
9. El PDF es generado, no un AcroForm rellenado, como admite HU-3.

## 8. Cobertura

| Historia | Estado | Evidencia | Falta para producción |
|---|---|---|---|
| HU-1 Leer la solicitud | Hecho | `leer_solicitud`; etiquetas ambiguas pasan a `requiere_confirmacion`. | Leer el `.xlsx` o `.pdf` real del adjunto en lugar de la plantilla ya normalizada. |
| HU-2 Mapear campos | Hecho | `mapear_campos`; tres estados, ruta y confianza. | Flujo para que la analista agregue sinónimos al glosario desde el chat. |
| HU-3 Formulario xlsx (P0) | Hecho | `out/<caso>/formulario.xlsx`, celdas como texto. | Escribir sobre la plantilla original conservando estilos y validaciones. |
| HU-3 Formulario pdf (P1) | Hecho | `out/<caso>/formulario.pdf` en el orden de la plantilla. | Rellenar AcroForm cuando el PDF del cliente lo tenga. |
| HU-3 Portal (P2) | Hecho según alcance | "formato no soportado" + `valores-portal.md`; diseño en la sección 5. | La extensión de navegador. |
| HU-4 Paquete para firma | Hecho | `paquete/` con checklist, borrador y soportes; bloqueo por vencido o ausente. | Integración con firma electrónica y con el repositorio documental real. |
| HU-4 Envío simulado (P1) | Hecho | `ENVIO-SIMULADO.md` solo tras confirmación aplicada por backend. | Envío real con aprobación registrada. |
| HU-5 Errores | Hecho | Ninguna herramienta lanza; mensajes claros; un caso malo no detiene el siguiente. | Alertas y métricas. |
| Bonus módulo | Hecho | `modulo/` generado desde las mismas fuentes; `--check` detecta divergencia. | Probarlo dentro de la plataforma destino. |

## 9. Uso de IA

> **Completa esta sección con tu experiencia real antes de entregar.** El PRD exige que puedas
> explicar cada línea.

| Asistente | Para qué | Qué se descartó o corrigió |
|---|---|---|
| Claude (claude.ai) | Lectura del PRD y los fixtures, diseño de la arquitectura, primera versión completa del código, pruebas y este documento. | Se descartó un bloque de "consumo de autorización" enredado en el ciclo y se reescribió en una línea. Se descartó usar un framework HTTP y los SDK de proveedor. Se corrigió que un caso inexistente creara una carpeta en `out/`. |
| _(agrega aquí lo que uses tú)_ | | |

Revisión propia pendiente de declarar: qué leíste línea por línea, qué cambiaste y qué probaste con
el modelo real.

## 10. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo afirma un valor que no salió de una herramienta. | Los valores del formulario solo vienen del maestro; el chat es informativo. Agregar una verificación que compare cifras del texto final contra los resultados de herramientas. |
| Maestro desactualizado (cambio de cuenta o de representante legal). | Dueño del dato, fecha de última revisión por campo y bloqueo si un dato sensible supera cierta antigüedad. |
| Soportes vencidos al momento de firmar. | Ya bloquea. En producción, alerta previa al vencimiento de Cámara de Comercio y parafiscales. |
| Plantillas reales peores que los fixtures (celdas combinadas, PDF escaneado). | Extracción de etiquetas con revisión humana la primera vez por cliente; la plantilla mapeada se guarda y se reutiliza. |
| Inyección de instrucciones en el cuerpo del correo del cliente. | El cuerpo no se envía al modelo en esta versión. Si se usa, se trata como dato y las acciones externas siguen detrás de la confirmación del backend. |
| Datos bancarios en logs o en el chat. | El log por caso guarda resúmenes sin valores. El log global guarda argumentos, que tampoco los traen. Pendiente: enmascarar los resultados de herramientas que se muestran en el chat. |
| Abuso del link público y gasto de la clave. | Topes por sesión, por día y por IP. En producción, autenticación corporativa. |
| Disco efímero en el despliegue. | Mover `out/` a almacenamiento de objetos con retención definida. |
| Confirmación por coincidencia de texto ("sí", "confirmo"). | Es deliberadamente estricta: ante duda no autoriza. En producción, botón con identidad del aprobador en lugar de texto libre. |
