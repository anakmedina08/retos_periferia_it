# Reto 01 · Agente "Registro como proveedor"

Agente conversacional que lee la solicitud de un cliente, cruza los campos con el repositorio
maestro, genera el formulario (Excel o PDF) y arma el paquete para la firma del representante
legal. Prepara; nunca firma ni envía sin confirmación humana.

**Link de prueba:** `PENDIENTE: pega aquí la URL del despliegue`

## Levantar en local

Requiere Node 20+ (o Bun 1.1+).

```bash
cp .env.example .env        # y configura el proveedor y la clave (ver abajo)
npm install && npm run dev  # o: bun install && bun run dev
```

Abre <http://localhost:3000>. Front y backend salen del mismo proceso.

Configuración usada en la entrega (Gemini por su endpoint compatible con OpenAI):

```
LLM_PROVIDER=openai
LLM_MODEL=gemini-3-flash-preview
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
OPENAI_API_KEY=<clave de Google AI Studio>
```

En Windows PowerShell, si `npm` está bloqueado por la política de scripts, usa `npm.cmd`.

## Verificación sin modelo

No necesita clave ni red:

```bash
npm run demo      # o: bun run demo.ts   → procesa los 4 casos y deja todo en out/
npm run prueba    # ciclo del agente con un modelo guionizado: confirmación, topes, errores
npm run typecheck
```

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `LLM_PROVIDER` | No (`anthropic`) | `anthropic` u `openai` (cualquier API compatible con Chat Completions). |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Sí, la del proveedor elegido | Solo la lee el backend. |
| `LLM_MODEL` | No | Por defecto `claude-haiku-4-5` o `gpt-4.1-mini`. |
| `OPENAI_BASE_URL` | No | Para Azure, Groq, Mistral, Ollama, etc. |
| `MAX_ITERACIONES` | No (25) | Tope de vueltas herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | No (150000) | Tope de tokens por sesión. |
| `MAX_TOKENS_DIA` | No (2000000) | Tope global diario del servidor. |
| `MAX_SOLICITUDES_POR_MINUTO` | No (20) | Límite por IP. |
| `LLM_TIMEOUT_MS` | No (60000) | Timeout de cada llamada al modelo. |
| `FECHA_EJECUCION` | No (hoy) | Fija la fecha con la que se evalúan vigencias (`YYYY-MM-DD`). |
| `PORT` | No (3000) | Puerto HTTP. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ ok, reply, toolCalls[], needsConfirmation, tokensSesion }`. Con `Accept: application/x-ndjson` devuelve un evento por línea (`herramienta`, `asistente`, `error`, `fin`). |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado }`. Nunca expone claves. |
| `GET` | `/api/casos` | Casos disponibles en `fixtures/`. |
| `GET` | `/api/files` y `/api/files/<ruta>` | Lista y descarga lo generado en `out/`. |

## Estructura

```
agent/prompt.md                 comportamiento del agente
src/knowledge/                  conocimiento del proceso (reglas de negocio en prosa)
src/tools/proveedor.ts          herramientas tipadas con zod (ejecución)
src/tools/registro.ts           nombres proveedor_*, JSON Schema y validación
src/agent/ciclo.ts              ciclo del agente, tope de iteraciones y de tokens
src/agent/confirmacion.ts       confirmación humana aplicada por el backend
src/agent/sesiones.ts           sesiones en memoria + respaldo en out/sesiones/
src/llm/adapter.ts              interfaz enviar(mensajes, herramientas)
src/llm/anthropic.ts, openai.ts implementaciones del adaptador
src/server.ts                   API HTTP y archivos estáticos
web/                            front de chat (HTML, CSS y JS planos)
demo.ts                         verificación sin modelo
scripts/prueba-ciclo.ts         prueba del ciclo con modelo guionizado
scripts/build-modulo.ts         genera modulo/ desde las mismas fuentes (bonus)
modulo/                         agente empaquetado: agent.md, tools/, skill/
```

## Desplegar

El repositorio incluye `Dockerfile` y `render.yaml`. En Render: *New → Blueprint*, apunta al
repositorio y define `OPENAI_API_KEY` como secreto. Si el proyecto está en una subcarpeta del repositorio, indícala en Root Directory. En Railway o Fly.io basta el `Dockerfile` y
la misma variable. El disco es efímero: `out/` se pierde al reiniciar, lo cual es aceptable aquí.

## Módulo reutilizable

`modulo/` se genera con `npm run modulo` a partir de `agent/prompt.md`, `src/tools/proveedor.ts` y
`src/knowledge/registro-proveedor.md`. `npm run modulo -- --check` falla si hay divergencia.
