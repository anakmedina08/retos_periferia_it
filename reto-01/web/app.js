// Front de chat sin framework. Habla con /api/chat en modo NDJSON para pintar cada
// llamada a herramienta apenas ocurre. La clave del modelo nunca llega aquí.
const $ = (id) => document.getElementById(id)
const historial = $("historial")
const formulario = $("formulario")
const mensaje = $("mensaje")
const confirmacion = $("confirmacion")

const nuevaSesion = () => `s-${crypto.randomUUID()}`
let sessionId = sessionStorage.getItem("sessionId") ?? nuevaSesion()
sessionStorage.setItem("sessionId", sessionId)
let ocupado = false

const escapar = (t) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

/** Markdown mínimo y seguro: se escapa todo y luego se permiten negrita, código y listas. */
function formatear(texto) {
  const enLinea = (t) => escapar(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>")
  const bloques = []
  let lista = null
  for (const linea of texto.split("\n")) {
    const item = linea.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)
    if (item) {
      if (!lista) bloques.push((lista = []))
      lista.push(`<li>${enLinea(item[1])}</li>`)
    } else {
      lista = null
      if (linea.trim()) bloques.push(`<p>${enLinea(linea.replace(/^#+\s*/, ""))}</p>`)
    }
  }
  return bloques.map((b) => (Array.isArray(b) ? `<ul>${b.join("")}</ul>` : b)).join("")
}

function agregar(html, clase) {
  const li = document.createElement("li")
  li.className = clase
  li.innerHTML = html
  historial.append(li)
  historial.scrollTop = historial.scrollHeight
  return li
}

function bonito(valor) {
  try {
    return JSON.stringify(typeof valor === "string" ? JSON.parse(valor) : valor, null, 2)
  } catch {
    return String(valor)
  }
}

function pintar(evento) {
  if (evento.tipo === "usuario") agregar(formatear(evento.texto), "msg usuario")
  if (evento.tipo === "error") agregar(formatear(evento.texto), "msg error")
  if (evento.tipo === "asistente") {
    const aviso = evento.needsConfirmation ? `<span class="etiqueta-pide">Pide tu confirmación</span>` : ""
    agregar(aviso + formatear(evento.texto), `msg asistente${evento.needsConfirmation ? " pide" : ""}`)
  }
  if (evento.tipo === "herramienta") {
    const l = evento.llamada
    agregar(
      `<details><summary><span class="marca">${l.ok ? "ok" : "falló"}</span><span class="nombre">${escapar(l.nombre)}</span>` +
        `<span class="resumen">${escapar(l.resumen)} (${l.ms} ms)</span></summary>` +
        `<dl><dt>Argumentos</dt><dd><pre>${escapar(bonito(l.args))}</pre></dd>` +
        `<dt>Resultado</dt><dd><pre>${escapar(bonito(l.resultado))}</pre></dd></dl></details>`,
      `llamada${l.ok ? "" : " fallo"}`,
    )
  }
}

function mostrarConfirmacion(activa) {
  confirmacion.hidden = !activa
  if (activa) $("btn-confirmar").focus()
}

function bloquear(valor) {
  ocupado = valor
  for (const b of document.querySelectorAll("button")) b.disabled = valor
  mensaje.disabled = valor
}

async function enviar(texto) {
  if (ocupado || !texto.trim()) return
  bloquear(true)
  mostrarConfirmacion(false)
  pintar({ tipo: "usuario", texto })
  const pensando = agregar("El agente está trabajando", "pensando")
  let necesitaConfirmacion = false
  try {
    const respuesta = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ sessionId, message: texto }),
    })
    if (!respuesta.headers.get("content-type")?.includes("ndjson")) {
      const cuerpo = await respuesta.json().catch(() => ({}))
      pintar({ tipo: "error", texto: cuerpo.error ?? "El servidor no pudo procesar el mensaje." })
      return
    }
    const lector = respuesta.body.pipeThrough(new TextDecoderStream()).getReader()
    let resto = ""
    for (;;) {
      const { value, done } = await lector.read()
      if (done) break
      const lineas = (resto + value).split("\n")
      resto = lineas.pop() ?? ""
      for (const linea of lineas.filter(Boolean)) {
        const evento = JSON.parse(linea)
        if (evento.tipo === "fin") {
          necesitaConfirmacion = evento.needsConfirmation
          $("tokens").textContent = `Tokens usados en esta sesión: ${evento.tokensSesion.toLocaleString("es-CO")}`
        } else {
          pintar(evento)
          historial.append(pensando) // el indicador siempre queda al final
        }
      }
    }
  } catch {
    pintar({ tipo: "error", texto: "Se perdió la conexión con el servidor. Tu sesión sigue activa: intenta de nuevo." })
  } finally {
    pensando.remove()
    bloquear(false)
    mostrarConfirmacion(necesitaConfirmacion)
    if (!necesitaConfirmacion) mensaje.focus()
    cargarArchivos()
  }
}

async function cargarArchivos() {
  const lista = $("archivos")
  const { archivos = [] } = await fetch("/api/files").then((r) => r.json()).catch(() => ({}))
  const visibles = archivos.filter((a) => a.includes("/") && !a.startsWith("_"))
  if (visibles.length === 0) return
  const grupos = Map.groupBy(visibles, (a) => a.split("/")[0])
  lista.innerHTML = [...grupos]
    .map(([caso, rutas]) => {
      const enlaces = rutas.map((r) => `<li><a href="/api/files/${encodeURI(r)}">${escapar(r.slice(caso.length + 1))}</a></li>`)
      return `<li class="grupo">${escapar(caso)}</li>${enlaces.join("")}`
    })
    .join("")
}

async function iniciar() {
  const salud = await fetch("/api/health").then((r) => r.json()).catch(() => null)
  const estado = $("estado")
  if (salud?.configurado) estado.textContent = `Modelo: ${salud.model}`
  else {
    estado.textContent = salud ? "Falta la clave del modelo" : "Servidor sin respuesta"
    estado.classList.add("alerta")
  }
  const { casos = [] } = await fetch("/api/casos").then((r) => r.json()).catch(() => ({}))
  $("casos").innerHTML = casos.map((c) => `<li><button type="button" data-caso="${escapar(c)}">${escapar(c)}</button></li>`).join("")
  const previa = await fetch(`/api/sessions/${sessionId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (previa?.historial?.length) {
    previa.historial.forEach(pintar)
    mostrarConfirmacion(previa.needsConfirmation)
  } else {
    pintar({ tipo: "asistente", texto: "Hola. Elige un caso de la bandeja o escríbeme cuál quieres procesar. Leo la solicitud, lleno el formulario desde el repositorio maestro y armo el paquete para firma." })
  }
  cargarArchivos()
}

formulario.addEventListener("submit", (e) => {
  e.preventDefault()
  const texto = mensaje.value
  mensaje.value = ""
  enviar(texto)
})
mensaje.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    formulario.requestSubmit()
  }
})
$("casos").addEventListener("click", (e) => {
  const caso = e.target.closest("button")?.dataset.caso
  if (caso) enviar(`Procesa el caso "${caso}". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.`)
})
$("btn-confirmar").addEventListener("click", () => enviar("Sí, confirmo."))
$("btn-rechazar").addEventListener("click", () => enviar("No, todavía no."))
$("btn-nueva").addEventListener("click", () => {
  sessionId = nuevaSesion()
  sessionStorage.setItem("sessionId", sessionId)
  historial.innerHTML = ""
  $("tokens").textContent = ""
  mostrarConfirmacion(false)
  iniciar()
})

iniciar()
