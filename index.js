/**
 * MotoVA® — Bot de WhatsApp Business (Cloudflare Worker)
 * "Detallado y Cuidado Vehicular" · https://www.motova.shop/
 *
 * Bindings / variables requeridas (NO hardcodear secretos):
 *   - MOTOVA_KV        → KV Namespace (estado, historial y pedidos)
 *   - WHATSAPP_TOKEN   → Token permanente de la API de WhatsApp Cloud (secret)
 *   - PHONE_NUMBER_ID  → ID del número de WhatsApp Business
 *   - VERIFY_TOKEN     → Token de verificación del webhook (el que pones en Meta)
 *   - APP_SECRET       → App Secret de Meta (valida la firma X-Hub-Signature-256)
 *   - NOTIFY_PHONE     → (opcional) número que recibe aviso de pedidos/handoff, ej. 5219931958951
 *
 * Despliegue:
 *   wrangler kv namespace create MOTOVA_KV
 *   wrangler secret put WHATSAPP_TOKEN   (idem VERIFY_TOKEN, APP_SECRET)
 *   wrangler deploy
 */

// ───────────────────────── Configuración del negocio ─────────────────────────
const GRAPH_API = "https://graph.facebook.com/v21.0";
const BRAND = "MotoVA®";
const SUPPORT_PHONE = "+52 993 195 8951";
const WEBSITE = "https://www.motova.shop/";
const TIMEZONE = "America/Mexico_City"; // Villahermosa, Tabasco (UTC-6, sin horario de verano)
const PAUSE_MS = 2 * 60 * 60 * 1000; // 2 horas de pausa en handoff
const STATE_TTL = 60 * 60 * 24 * 30; // 30 días en KV
const MAX_LOG = 20; // mensajes guardados por chat

// Horario: 0 = domingo … 6 = sábado. Horas en formato 24 h.
const SCHEDULE = {
  1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19], // Lun-Vie
  6: [9, 14], // Sábado
};

// ───────────────────────── Catálogo ─────────────────────────
const PRODUCTS = [
  { id: 1, name: "Shampoo Hidrofóbico con Cera", size: "500 ml", price: 250, bulk: 165 },
  { id: 2, name: "Desengrasante de Cadena y Motor", size: "500 ml", price: 270, bulk: 180 },
  { id: 3, name: "Restaurador y Protector UV de Plásticos", size: "250 ml", price: 250, bulk: 165 },
  { id: 4, name: "Limpiador de Espejos, Faros y Micas / TFT", size: "125 ml", price: 150, bulk: 95 },
  { id: 5, name: "Limpiador de Visores y Cascos", size: "125 ml", price: 150, bulk: 95 },
];
const BULK_MIN = 3; // piezas mínimas para precio por volumen

const COMBO = {
  name: "Combo Insignia: Kit Completa tu Kit de 4 Piezas",
  includes: "Shampoo 500 ml + Desengrasante 500 ml + Restaurador 250 ml + Limpiador de visores 125 ml",
  price: 750,
  regular: 920,
  savings: 170,
};

// ───────────────────────── Textos ─────────────────────────
const MENU_TEXT =
`¡Hola, gracias por escribir a MotoVA. Más que limpieza, es protección.

¿Qué necesitas?
1️⃣ Precios y Combo $750
2️⃣ Asesoría: qué producto necesito
3️⃣ Hacer un pedido
4️⃣ Envío a todo México
5️⃣ Entrega local en Villahermosa
6️⃣ Horario
0️⃣ Hablar con una persona

Escribe el número de tu opción (ej. 1).`;

const SCHEDULE_TEXT =
`🕘 Horario de atención ${BRAND} (hora de Villahermosa):
• Lunes a Viernes: 9:00 a 19:00
• Sábados: 9:00 a 14:00
• Domingos: cerrado`;

function pricesText() {
  const lines = PRODUCTS.map(
    (p) => `${p.id}. ${p.name} (${p.size})\n   💲$${p.price} MXN c/u · A partir de ${BULK_MIN} piezas: $${p.bulk} c/u`
  );
  return (
`🏍️ *Precios ${BRAND}*

${lines.join("\n\n")}

⭐ *${COMBO.name}*
Incluye: ${COMBO.includes}.
Precio del combo: *$${COMBO.price} MXN* (suelto $${COMBO.regular} MXN, ¡ahorras $${COMBO.savings} MXN!)

🛒 Catálogo completo: ${WEBSITE}

Escribe *3* para hacer tu pedido o *menu* para volver al inicio.`
  );
}

const ADVICE_MENU =
`🔧 *Asesoría: ¿qué producto necesito?*

¿Qué quieres resolver? Responde con una letra:
A) Lavar mi moto y darle brillo
B) Limpiar cadena o motor con grasa
C) Plásticos opacos o resecos
D) Espejos, faros, micas o pantalla TFT
E) Visor del casco
F) Quiero lo completo (kit)

Escribe *menu* para volver al inicio.`;

const ADVICE_ANSWERS = {
  a: `🧼 Para lavar y dar brillo te conviene el *Shampoo Hidrofóbico con Cera (500 ml)*: limpia y deja una capa protectora que repele el agua.\n💲$250 c/u · 3+ piezas: $165 c/u`,
  b: `⚙️ Para grasa y suciedad pesada usa el *Desengrasante de Cadena y Motor (500 ml)*.\n💲$270 c/u · 3+ piezas: $180 c/u`,
  c: `🛡️ Para plásticos opacos o resecos, el *Restaurador y Protector UV de Plásticos (250 ml)* devuelve el color y protege del sol.\n💲$250 c/u · 3+ piezas: $165 c/u`,
  d: `🔍 Para espejos, faros, micas y TFT, el *Limpiador de Espejos, Faros y Micas / TFT (125 ml)*.\n💲$150 c/u · 3+ piezas: $95 c/u`,
  e: `🪖 Para el visor del casco, el *Limpiador de Visores y Cascos (125 ml)*.\n💲$150 c/u · 3+ piezas: $95 c/u`,
  f: `⭐ Lo mejor es el *${COMBO.name}*: ${COMBO.includes}.\n💲$${COMBO.price} MXN (suelto $${COMBO.regular}, ahorras $${COMBO.savings}).`,
};

// ───────────────────────── Utilidades ─────────────────────────

/** Minúsculas, sin acentos ni signos: facilita comparar palabras clave. */
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GREETING_RE = /^(hola+|holi+|buenas|buenos dias|buenas tardes|buenas noches|buen dia|hey|hi|hello|menu|inicio|empezar|info|informacion)\b/;
const HUMAN_RE = /\b(humano|asesor|asesora|persona|agente|ejecutivo|operador|atencion humana)\b/;

/** Devuelve { day, hour, minute } en hora de Villahermosa. */
function localTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: days[get("weekday")], hour: Number(get("hour")), minute: Number(get("minute")) };
}

/** ¿Estamos dentro del horario de atención? */
function isOpenNow(date = new Date()) {
  const { day, hour } = localTime(date);
  const range = SCHEDULE[day];
  return !!range && hour >= range[0] && hour < range[1];
}

/** Comparación en tiempo constante (evita ataques de timing). */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Valida X-Hub-Signature-256 con HMAC-SHA256 usando APP_SECRET. */
async function verifySignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(hex, header.slice(7));
}

// ───────────────────────── Estado en KV ─────────────────────────

const stateKey = (waId) => `chat:${waId}`;

async function getState(env, waId) {
  const raw = await env.MOTOVA_KV.get(stateKey(waId), "json");
  return raw || { step: "menu", paused: false, pausedUntil: 0, name: null, log: [] };
}

async function saveState(env, waId, state) {
  await env.MOTOVA_KV.put(stateKey(waId), JSON.stringify(state), { expirationTtl: STATE_TTL });
}

/** Agrega una entrada al historial del chat (se conservan las últimas MAX_LOG). */
function logMessage(state, direction, text) {
  state.log = state.log || [];
  state.log.push({ t: new Date().toISOString(), d: direction, m: String(text).slice(0, 500) });
  if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
}

// ───────────────────────── WhatsApp Cloud API ─────────────────────────

/** Envía un mensaje de texto por WhatsApp Cloud API. */
async function sendText(env, to, body) {
  const res = await fetch(`${GRAPH_API}/${env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  if (!res.ok) {
    console.error("sendText error", res.status, await res.text());
  }
  return res.ok;
}

/** Envía y registra la respuesta del bot en el historial. */
async function reply(env, state, to, body) {
  logMessage(state, "out", body);
  return sendText(env, to, body);
}

/** Aviso opcional al dueño/asesor (requiere NOTIFY_PHONE). */
async function notifyTeam(env, text) {
  if (!env.NOTIFY_PHONE) return;
  try {
    await sendText(env, env.NOTIFY_PHONE, text);
  } catch (e) {
    console.error("notifyTeam error", e);
  }
}

// ───────────────────────── Lógica del bot ─────────────────────────

async function startHandoff(env, state, from) {
  state.paused = true;
  state.pausedUntil = Date.now() + PAUSE_MS;
  state.step = "menu";
  const open = isOpenNow();
  await reply(
    env, state, from,
    open
      ? `👤 Listo, un asesor de ${BRAND} atenderá tu solicitud en breve. Pausé el asistente automático por 2 horas para que platiquen con calma.\n\nSi es urgente, también puedes llamar o escribir al ${SUPPORT_PHONE}.`
      : `👤 Registré tu solicitud. Ahora estamos fuera de horario, pero un asesor de ${BRAND} te responderá en cuanto abramos.\n\n${SCHEDULE_TEXT}\n\nContacto: ${SUPPORT_PHONE}`
  );
  await notifyTeam(env, `🔔 ${BRAND}: el cliente ${state.name || ""} (+${from}) pidió hablar con una persona.`);
}

async function handleOrderText(env, state, from, text) {
  const open = isOpenNow();
  const orderId = `order:${Date.now()}:${from}`;
  await env.MOTOVA_KV.put(
    orderId,
    JSON.stringify({ from, name: state.name, text, createdAt: new Date().toISOString(), inHours: open }),
    { expirationTtl: 60 * 60 * 24 * 90 }
  );
  state.step = "menu";
  await reply(
    env, state, from,
    open
      ? `✅ ¡Gracias! Recibí tu pedido:\n\n"${text}"\n\nUn asesor lo confirmará contigo en breve (total, forma de pago y entrega).`
      : `✅ ¡Gracias! Dejé registrado tu pedido:\n\n"${text}"\n\nEstamos fuera de horario; lo confirmaremos contigo en cuanto abramos.\n\n${SCHEDULE_TEXT}`
  );
  await notifyTeam(env, `🛒 Nuevo pedido ${BRAND} de ${state.name || ""} (+${from}):\n${text}`);
}

async function handleText(env, from, name, rawText) {
  const state = await getState(env, from);
  if (name) state.name = name;
  logMessage(state, "in", rawText);

  const text = normalize(rawText);
  const now = Date.now();

  // 1) Si el chat está pausado (handoff): no responder, salvo que el cliente pida el menú.
  if (state.paused) {
    if (now < state.pausedUntil && !/^(menu|inicio|reactivar|bot)$/.test(text)) {
      await saveState(env, from, state); // solo registramos el chat
      return;
    }
    state.paused = false;
    state.pausedUntil = 0;
    state.step = "menu";
  }

  // 2) Handoff por palabra clave u opción 0.
  if (text === "0" || HUMAN_RE.test(text)) {
    await startHandoff(env, state, from);
    return saveState(env, from, state);
  }

  // 3) Saludo / menú.
  if (GREETING_RE.test(text) || text === "menu") {
    state.step = "menu";
    await reply(env, state, from, MENU_TEXT);
    return saveState(env, from, state);
  }

  // 4) Flujos con estado.
  if (state.step === "pedido") {
    await handleOrderText(env, state, from, rawText.trim());
    return saveState(env, from, state);
  }

  if (state.step === "asesoria" && ADVICE_ANSWERS[text]) {
    await reply(env, state, from, `${ADVICE_ANSWERS[text]}\n\nEscribe *3* para pedir, otra letra para otra consulta o *menu* para volver al inicio.`);
    return saveState(env, from, state);
  }

  // 5) Opciones del menú.
  switch (text) {
    case "1":
      state.step = "menu";
      await reply(env, state, from, pricesText());
      break;

    case "2":
      state.step = "asesoria";
      await reply(env, state, from, ADVICE_MENU);
      break;

    case "3":
      state.step = "pedido";
      await reply(
        env, state, from,
        `🛒 *Hacer un pedido*\n\nEscríbeme en un solo mensaje:\n• Producto(s) y cantidad (ej. "1 Combo Insignia" o "3 Shampoo 500 ml")\n• Tu nombre\n• Ciudad y si es envío o entrega local\n\nRecuerda: desde ${BULK_MIN} piezas del mismo producto aplica precio por volumen.\n\n${isOpenNow() ? "Un asesor lo confirmará contigo en breve." : "Estamos fuera de horario: tomo tu pedido y lo confirmamos al abrir."}`
      );
      break;

    case "4":
      state.step = "menu";
      await reply(
        env, state, from,
        `📦 *Envío a todo México*\n\nEnviamos a toda la República. El costo y tiempo de entrega dependen de tu código postal y se confirman al hacer tu pedido.\n\nEscribe *3* para hacer tu pedido o compra en ${WEBSITE}\n\nEscribe *menu* para volver al inicio.`
      );
      break;

    case "5":
      state.step = "menu";
      await reply(
        env, state, from,
        `📍 *Entrega local en Villahermosa*\n\nSi estás en Villahermosa, coordinamos la entrega de tu pedido directamente contigo (punto y horario).\n\nEscribe *3* para hacer tu pedido o *0* para hablar con una persona.\n\nEscribe *menu* para volver al inicio.`
      );
      break;

    case "6":
      state.step = "menu";
      await reply(
        env, state, from,
        `${SCHEDULE_TEXT}\n\n${isOpenNow() ? "✅ Ahora mismo estamos en horario de atención." : "⏰ Ahora estamos fuera de horario; deja tu mensaje y te respondemos al abrir."}\n\nContacto: ${SUPPORT_PHONE}\n\nEscribe *menu* para volver al inicio.`
      );
      break;

    default:
      // No entendido: recordar el menú.
      await reply(env, state, from, `No logré entender tu mensaje 😅\n\n${MENU_TEXT}`);
  }

  await saveState(env, from, state);
}

/** Mensajes que no son texto (imágenes, audios, ubicación…). */
async function handleNonText(env, from, name, type) {
  const state = await getState(env, from);
  if (name) state.name = name;
  logMessage(state, "in", `[${type}]`);

  if (state.paused && Date.now() < state.pausedUntil) {
    return saveState(env, from, state); // un asesor humano está atendiendo
  }
  if (state.step === "pedido") {
    // Un adjunto durante el pedido: se registra y se pasa a un asesor.
    await startHandoff(env, state, from);
  } else {
    await reply(env, state, from, `Por ahora solo puedo leer mensajes de texto 🙂\n\n${MENU_TEXT}`);
  }
  await saveState(env, from, state);
}

// ───────────────────────── Procesamiento del webhook ─────────────────────────

async function processWebhook(env, payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      // Ignorar estados de entrega/lectura (statuses): solo procesamos messages.
      if (!value.messages || !value.messages.length) continue;

      const contacts = value.contacts || [];
      for (const msg of value.messages) {
        try {
          // Deduplicación: Meta puede reenviar el mismo mensaje.
          const dedupKey = `msg:${msg.id}`;
          if (await env.MOTOVA_KV.get(dedupKey)) continue;
          await env.MOTOVA_KV.put(dedupKey, "1", { expirationTtl: 60 * 60 * 24 });

          const from = msg.from;
          const name = contacts.find((c) => c.wa_id === from)?.profile?.name || null;

          if (msg.type === "text") {
            await handleText(env, from, name, msg.text?.body || "");
          } else if (msg.type === "button") {
            await handleText(env, from, name, msg.button?.text || "");
          } else if (msg.type === "interactive") {
            const i = msg.interactive || {};
            const title = i.button_reply?.title || i.list_reply?.title || "";
            await handleText(env, from, name, title);
          } else {
            await handleNonText(env, from, name, msg.type);
          }
        } catch (err) {
          console.error("Error procesando mensaje", msg?.id, err);
        }
      }
    }
  }
}

// ───────────────────────── Entry point ─────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Verificación del webhook (Meta → GET)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && env.VERIFY_TOKEN && safeEqual(token, env.VERIFY_TOKEN)) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // Recepción de eventos (Meta → POST)
    if (request.method === "POST") {
      const rawBody = await request.text();

      const valid = await verifySignature(rawBody, request.headers.get("X-Hub-Signature-256"), env.APP_SECRET);
      if (!valid) return new Response("Invalid signature", { status: 401 });

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      // Responder 200 de inmediato y procesar en segundo plano (Meta exige respuesta rápida).
      ctx.waitUntil(processWebhook(env, payload));
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
              
