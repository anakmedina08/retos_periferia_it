# Reto 03 · Agente "Órdenes de compra"

Agente conversacional que lee el paquete de una solicitud de compra (correo, solicitud, cotización
y aprobación), lo valida contra los maestros y los controles RC1 a RC10, construye la orden de
compra, genera la evidencia de aprobación y crea la OC en un SAP simulado. Lo bloqueado no se crea;
lo dudoso espera la confirmación de la analista; las OC retroactivas quedan medidas.

**Link de prueba:** `PENDIENTE: pega aquí la URL del despliegue`

## Levantar en local

Requiere Node 20+ (o Bun 1.1+).

```bash
cp .env.example .env        # y escribe tu clave en OPENAI_API_KEY
npm install && npm run dev  # o: bun install && bun run dev
```

Abre <http://localhost:3000>. Front y backend salen del mismo proceso. En Windows PowerShell, si
`npm` está bloqueado por la política de scripts, usa `npm.cmd`.

El `.env.example` viene configurado para Gemini por su endpoint compatible con OpenAI; la clave se
crea en Google AI Studio. Para usar Anthropic: `LLM_PROVIDER=anthropic` y `ANTHROPIC_API_KEY`.

## Verificación sin modelo

No necesita clave ni red:

```bash
npm run demo      # o: bun run demo.ts   → procesa los 6 casos y deja todo en out/
npm run prueba    # ciclo del agente con un modelo guionizado: bloqueos, confirmación, idempotencia
npm run typecheck
```

## Prompt de ejemplo

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó
y cuáles no, y no la crees hasta que yo lo confirme.
```

Y después: `confirmo`. Cada solicitud de la lista lateral envía ese mismo prompt con un clic.

El botón "Reiniciar el SAP de prueba" borra lo generado en `out/` para repetir la demostración.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `LLM_PROVIDER` | No (`anthropic`) | `openai` (API compatible con Chat Completions) o `anthropic`. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Sí, la del proveedor elegido | Solo la lee el backend. |
| `LLM_MODEL` | No | Modelo a usar. |
| `OPENAI_BASE_URL` | No | Endpoint compatible con OpenAI (Gemini, Azure, Groq, Ollama, etc.). |
| `MAX_ITERACIONES` | No (25) | Tope de vueltas herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | No (150000) | Tope de tokens por sesión. |
| `MAX_TOKENS_DIA` | No (2000000) | Tope global diario del servidor. |
| `MAX_SOLICITUDES_POR_MINUTO` | No (20) | Límite por IP. |
| `LLM_TIMEOUT_MS` | No (60000) | Timeout de cada llamada al modelo. |
| `FECHA_EJECUCION` | No (hoy) | Fecha contable de las OC del SAP simulado. |
| `PORT` | No (3000) | Puerto HTTP. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ ok, reply, toolCalls[], needsConfirmation, tokensSesion }`. Con `Accept: application/x-ndjson` devuelve un evento por línea (`herramienta`, `asistente`, `error`, `fin`). |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado }`. Nunca expone claves. |
| `GET` | `/api/casos` | Solicitudes con su último estado según `out/control.csv`. |
| `GET` | `/api/files` y `/api/files/<ruta>` | Lista y descarga lo generado en `out/`. |
| `POST` | `/api/reset` | Borra lo generado (órdenes, control, evidencias, log). |

## Estructura

```
agent/prompt.md                 comportamiento del agente
src/knowledge/ordenes-compra.md conocimiento del proceso (controles en prosa)
src/tools/oc.ts                 herramientas tipadas con zod (ejecución)
src/tools/registro.ts           nombres oc_*, JSON Schema y validación
src/sap/adapter.ts              interfaz SapAdapter y esquema zod de la OC
src/sap/mock.ts                 SAP simulado sobre out/sap/
src/agent/ciclo.ts              ciclo del agente, tope de iteraciones y de tokens
src/agent/confirmacion.ts       confirmación humana aplicada por el backend
src/agent/sesiones.ts           sesiones en memoria + respaldo en out/sesiones/
src/llm/adapter.ts              interfaz enviar(mensajes, herramientas)
src/llm/openai.ts, anthropic.ts implementaciones del adaptador
src/server.ts                   API HTTP y archivos estáticos
web/                            front de chat (HTML, CSS y JS planos)
demo.ts                         verificación sin modelo
scripts/prueba-ciclo.ts         prueba del ciclo con modelo guionizado
scripts/build-modulo.ts         genera modulo/ desde las mismas fuentes (bonus)
modulo/                         agente empaquetado: agent.md, tools/, sap/, skill/
```

## Qué queda en `out/`

```
out/sap/ordenes.jsonl            OC creadas en el SAP simulado, desde 4500000001
out/control.csv                  una fila por intento: creada, bloqueada, pendiente o idempotente
out/<caso>/aprobacion.txt|.pdf   evidencia de aprobación con su sha256
out/<caso>/payload.json          la OC tal como se envió a SAP
out/<caso>/trazabilidad.json     de dónde salió cada valor del payload
out/log.jsonl                    traza de cada llamada a herramienta
```

## Desplegar

El repositorio incluye `Dockerfile` y `render.yaml`. En Render: New → Web Service, runtime Docker,
Root Directory con la carpeta del reto si está en una subcarpeta, y `OPENAI_API_KEY` como secreto.
El disco es efímero: `out/` se pierde al reiniciar, lo cual es aceptable aquí.

## Módulo reutilizable

`modulo/` se genera con `npm run modulo` a partir de `agent/prompt.md`, `src/tools/oc.ts`,
`src/sap/` y `src/knowledge/ordenes-compra.md`. `npm run modulo -- --check` falla si hay
divergencia.
