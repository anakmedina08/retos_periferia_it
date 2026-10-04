# Reto 02 · Agente "Registro de contratos vigentes"

Agente conversacional que funciona como punto único de recepción de contratos: lee el buzón,
extrae los datos de cada contrato u otrosí con un nivel de confianza por campo, lo clasifica contra
el maestro (nuevo, actualización, duplicado o rechazado), lo registra, archiva el documento y genera
alertas de vencimientos y pólizas. Lo dudoso no se registra sin confirmación humana.

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
npm run demo      # o: bun run demo.ts   → procesa los 6 mensajes y deja todo en out/
npm run prueba    # ciclo del agente con un modelo guionizado: confirmación, topes, errores
npm run typecheck
```

## Prompt de ejemplo

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio,
muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas.
No registres nada dudoso sin preguntarme.
```

Y después: `confirmo el valor 0 y la fecha fin 2027-08-31`.

El botón "Reiniciar el buzón de prueba" borra lo generado en `out/` para repetir la demostración.

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
| `FECHA_EJECUCION` | No (hoy) | Fecha con la que se sella `fecha_registro`. |
| `PORT` | No (3000) | Puerto HTTP. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ ok, reply, toolCalls[], needsConfirmation, tokensSesion }`. Con `Accept: application/x-ndjson` devuelve un evento por línea (`herramienta`, `asistente`, `error`, `fin`). |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado }`. Nunca expone claves. |
| `GET` | `/api/buzon` | Mensajes del buzón con su estado. |
| `GET` | `/api/files` y `/api/files/<ruta>` | Lista y descarga lo generado en `out/`. |
| `POST` | `/api/reset` | Borra lo generado (maestro copiado, archivo, procesados, alertas, log). |

## Estructura

```
agent/prompt.md                 comportamiento del agente
src/knowledge/                  conocimiento del proceso (reglas de negocio en prosa)
src/tools/contratos.ts          herramientas tipadas con zod (ejecución)
src/tools/registro.ts           nombres contratos_*, JSON Schema y validación
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
modulo/                         agente empaquetado: agent.md, tools/, skill/
```

## Qué queda en `out/`

```
out/sharepoint/maestro-contratos.csv     copia de trabajo del maestro (el fixture no se toca)
out/sharepoint/historial.jsonl           una línea por inserción o actualización
out/sharepoint/Contratos/<año>/<cliente>/<id>.<ext>
out/procesados.json                      mensajes ya cerrados y cómo
out/alertas.md                           reporte de riesgos
out/log.jsonl                            traza de cada llamada a herramienta
```

## Desplegar

El repositorio incluye `Dockerfile` y `render.yaml`. En Render: New → Web Service, runtime Docker,
Root Directory con la carpeta del reto si está en una subcarpeta, y `OPENAI_API_KEY` como secreto.
El disco es efímero: `out/` se pierde al reiniciar, lo cual es aceptable aquí.

## Módulo reutilizable

`modulo/` se genera con `npm run modulo` a partir de `agent/prompt.md`, `src/tools/contratos.ts` y
`src/knowledge/registro-contratos.md`. `npm run modulo -- --check` falla si hay divergencia.
