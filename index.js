/**
 * WhatsApp bot — Baileys (pairing-code login)
 *
 * Features:
 *   - Receives WhatsApp messages
 *   - Replies via Gemini API (Roman Urdu personality)
 *   - Appointment booking flow
 *   - Google Calendar integration (service account)
 *
 * Login: a PAIRING CODE is printed to the logs (refreshed every ~55s), and a
 * scannable QR is served at the /qr route (page auto-refreshes every 30s).
 * Both stay current until the device is linked — no manual restart needed.
 *
 * Required environment variables:
 *   GEMINI_KEY          - Google Gemini API key
 *   GOOGLE_CREDENTIALS  - Service-account JSON (the whole JSON, as a string)
 *   CALENDAR_ID         - Target Google Calendar id (e.g. xxxx@group.calendar.google.com)
 *   PAIRING_NUMBER      - Your WhatsApp number, digits only, with country code (e.g. 923001234567)
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const GEMINI_KEY = process.env.GEMINI_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, '');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Karachi';

// Session storage. On Railway, mount a Volume at this path so the session
// survives redeploys/restarts and pairing is only ever needed once.
// Override locally with AUTH_DIR=auth_info (relative path) if /app is not writable.
const AUTH_DIR = process.env.AUTH_DIR || '/app/auth_info';
const PORT = process.env.PORT || 3000;

// How often to refresh the linking credentials (ms). 55s = just under the
// ~60s WhatsApp expiry, so a fresh QR / pairing code is always ready.
const REFRESH_MS = 55 * 1000;

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// ----------------------------------------------------------------------------
// Live linking state (shared with the /qr web page)
// ----------------------------------------------------------------------------
const link = {
  connected: false,
  qrString: null,     // raw QR payload from Baileys
  qrDataUrl: null,    // QR rendered as a PNG data URL for the web page
  pairingCode: null,  // latest pairing code
  updatedAt: null,
};

if (!GEMINI_KEY) console.warn('⚠️  GEMINI_KEY is not set — AI replies will be disabled.');
if (!PAIRING_NUMBER) console.warn('⚠️  PAIRING_NUMBER is not set — pairing code cannot be requested.');

// ----------------------------------------------------------------------------
// Gemini
// ----------------------------------------------------------------------------
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

const SYSTEM_PROMPT = `Tum aik friendly WhatsApp assistant ho jo Roman Urdu mein baat karta hai.
Hamesha Roman Urdu (Urdu in English letters) mein jawab dena, casual aur dostana lehje mein.
Jawab chote aur to-the-point rakho (1-3 lines) kyunki ye WhatsApp chat hai.
Agar user appointment / booking / meeting set karna chahe to usay batao ke wo "appointment" likhe taake booking shuru ho jaye.
Emojis thori si use kar sakte ho lekin zyada nahi.`;

async function geminiReply(history, userText) {
  if (!genAI) return 'Maaf kijiye, AI abhi available nahi hai (GEMINI_KEY missing).';
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userText);
    return result.response.text().trim() || 'Hmm, samajh nahi aya. Dobara likhein?';
  } catch (err) {
    console.error('Gemini error:', err?.message || err);
    return 'Maaf kijiye, abhi reply generate nahi ho saka. Thori dair baad koshish karein.';
  }
}

// Ask Gemini to parse a free-form date/time into structured fields.
async function parseDateTime(text) {
  if (!genAI) return null;
  const now = new Date();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const prompt = `Current date-time (timezone ${TIMEZONE}): ${now.toString()}.
User ne ye date/time likha hai: "${text}".
Is ko interpret karke STRICT JSON return karo (sirf JSON, koi aur text nahi):
{"date":"YYYY-MM-DD","time":"HH:MM","ok":true}
Agar samajh na aaye to {"ok":false}. 24-hour time use karo.`;
  try {
    const res = await model.generateContent(prompt);
    const raw = res.response.text().replace(/```json|```/g, '').trim();
    const obj = JSON.parse(raw);
    if (!obj.ok || !obj.date || !obj.time) return null;
    return { date: obj.date, time: obj.time };
  } catch (err) {
    console.error('parseDateTime error:', err?.message || err);
    return null;
  }
}

// ----------------------------------------------------------------------------
// Google Calendar
// ----------------------------------------------------------------------------
function getCalendarClient() {
  if (!process.env.GOOGLE_CREDENTIALS || !CALENDAR_ID) return null;
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.JWT(
      creds.client_email,
      undefined,
      creds.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    return google.calendar({ version: 'v3', auth });
  } catch (err) {
    console.error('Calendar auth error:', err?.message || err);
    return null;
  }
}

async function createCalendarEvent({ name, purpose, date, time, phone }) {
  const calendar = getCalendarClient();
  if (!calendar) return { ok: false, reason: 'Calendar configured nahi hai.' };

  // Build start/end (1 hour slot) in the given timezone.
  const start = new Date(`${date}T${time}:00`);
  if (isNaN(start.getTime())) return { ok: false, reason: 'Date/time invalid hai.' };
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const event = {
    summary: `Appointment: ${name}`,
    description: `Purpose: ${purpose}\nBooked by (WhatsApp): ${phone}`,
    start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
    end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
  };

  try {
    const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event });
    return { ok: true, link: res.data.htmlLink };
  } catch (err) {
    console.error('Calendar insert error:', err?.message || err);
    return { ok: false, reason: 'Calendar mein event add nahi ho saka.' };
  }
}

// ----------------------------------------------------------------------------
// Per-user session state
// ----------------------------------------------------------------------------
/** @type {Map<string, {flow?: string, step?: string, data?: any, history: any[]}>} */
const sessions = new Map();

function getSession(jid) {
  if (!sessions.has(jid)) sessions.set(jid, { history: [] });
  return sessions.get(jid);
}

function pushHistory(session, role, text) {
  session.history.push({ role, parts: [{ text }] });
  // keep history bounded
  if (session.history.length > 20) session.history = session.history.slice(-20);
}

const BOOKING_TRIGGERS = /\b(appointment|booking|book|meeting|milna|mulaqat|appoinment)\b/i;
const CANCEL_TRIGGERS = /\b(cancel|cencel|chor|chhor|band|stop|rehne do)\b/i;

// Returns the reply text for a given incoming message.
async function handleMessage(jid, text, phone) {
  const session = getSession(jid);
  const trimmed = text.trim();

  // ---- Active booking flow -------------------------------------------------
  if (session.flow === 'booking') {
    if (CANCEL_TRIGGERS.test(trimmed)) {
      session.flow = undefined;
      session.step = undefined;
      session.data = undefined;
      return 'Theek hai, booking cancel kar di. Aur kuch poochna ho to batayein 🙂';
    }

    if (session.step === 'name') {
      session.data.name = trimmed;
      session.step = 'purpose';
      return `Shukriya ${trimmed}! Appointment kis cheez ke liye hai? (purpose)`;
    }
    if (session.step === 'purpose') {
      session.data.purpose = trimmed;
      session.step = 'datetime';
      return 'Perfect. Ab date aur time batayein. (misal: "kal 5 baje" ya "25 June 3pm")';
    }
    if (session.step === 'datetime') {
      const parsed = await parseDateTime(trimmed);
      if (!parsed) {
        return 'Date/time samajh nahi aya 😅. Dobara likhein, misal: "kal shaam 5 baje" ya "2026-06-25 17:00".';
      }
      session.data.date = parsed.date;
      session.data.time = parsed.time;
      session.step = 'confirm';
      return `Confirm karein 👇\n\n👤 Naam: ${session.data.name}\n📝 Purpose: ${session.data.purpose}\n📅 Date: ${parsed.date}\n⏰ Time: ${parsed.time}\n\n"haan" likhein confirm ke liye, ya "cancel".`;
    }
    if (session.step === 'confirm') {
      if (/\b(haan|han|yes|ok|theek|confirm|done)\b/i.test(trimmed)) {
        const result = await createCalendarEvent({ ...session.data, phone });
        session.flow = undefined;
        session.step = undefined;
        const data = session.data;
        session.data = undefined;
        if (result.ok) {
          return `✅ Appointment book ho gaya!\n\n📅 ${data.date} ⏰ ${data.time}\n${result.link ? '🔗 ' + result.link : ''}`;
        }
        return `❌ ${result.reason} Aap dobara koshish kar sakte hain.`;
      }
      if (CANCEL_TRIGGERS.test(trimmed) || /\b(nahi|no)\b/i.test(trimmed)) {
        session.flow = undefined;
        session.step = undefined;
        session.data = undefined;
        return 'Theek hai, booking cancel. Aur kuch ho to batayein 🙂';
      }
      return '"haan" likhein confirm ke liye ya "cancel".';
    }
  }

  // ---- Start booking flow --------------------------------------------------
  if (BOOKING_TRIGGERS.test(trimmed)) {
    session.flow = 'booking';
    session.step = 'name';
    session.data = {};
    return 'Bilkul! Appointment book karte hain 📅\n\nApna naam batayein?';
  }

  // ---- General chat via Gemini --------------------------------------------
  const reply = await geminiReply(session.history, trimmed);
  pushHistory(session, 'user', trimmed);
  pushHistory(session, 'model', reply);
  return reply;
}

// ----------------------------------------------------------------------------
// WhatsApp connection (Baileys) with pairing code
// ----------------------------------------------------------------------------
async function startBot() {
  // Ensure the session folder exists (Railway Volume mount point or local path).
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log(`📁 Created session folder: ${AUTH_DIR}`);
  }

  // Loads an existing session from AUTH_DIR if present (no re-pairing needed),
  // otherwise starts fresh. saveCreds persists creds on every update below.
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const alreadyPaired = state.creds.registered;
  console.log(
    alreadyPaired
      ? `🔐 Existing session loaded from ${AUTH_DIR} — no pairing needed.`
      : `🆕 No saved session in ${AUTH_DIR} — pairing code will be requested.`
  );
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // we serve QR ourselves at /qr
    qrTimeout: REFRESH_MS,     // make Baileys emit a fresh QR every ~55s
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['WA Bot', 'Chrome', '1.0.0'],
  });

  // ---- Pairing code: request a fresh one every ~55s until linked ----------
  // Each request stays valid ~1 hour on WhatsApp's side, but we keep issuing
  // new ones so a current code is always in the logs (and on the /qr page).
  let pairingTimer = null;

  async function requestPairing() {
    if (sock.authState.creds.registered || !PAIRING_NUMBER) return;
    try {
      const code = await sock.requestPairingCode(PAIRING_NUMBER);
      const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
      link.pairingCode = pretty;
      link.updatedAt = new Date();
      console.log('\n==============================================');
      console.log('   📲 WHATSAPP PAIRING CODE (refreshes every 55s)');
      console.log(`   Number : +${PAIRING_NUMBER}`);
      console.log(`   CODE   : ${pretty}`);
      console.log('==============================================');
      console.log('   WhatsApp > Linked Devices > Link a Device');
      console.log('   > Link with phone number instead > enter code');
      console.log('==============================================\n');
    } catch (err) {
      console.error('❌ Failed to get pairing code:', err?.message || err);
    }
  }

  function stopRefreshers() {
    if (pairingTimer) {
      clearInterval(pairingTimer);
      pairingTimer = null;
    }
  }

  if (!sock.authState.creds.registered) {
    if (!PAIRING_NUMBER) {
      console.error('❌ PAIRING_NUMBER not set — cannot request a pairing code.');
    } else {
      // first request after a short delay, then refresh on an interval
      setTimeout(requestPairing, 3000);
      pairingTimer = setInterval(requestPairing, REFRESH_MS);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Fresh QR emitted by Baileys (auto every ~55s via qrTimeout) — render it.
    if (qr) {
      link.qrString = qr;
      link.updatedAt = new Date();
      try {
        link.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        console.log(`🔄 New QR generated — open http://localhost:${PORT}/qr`);
      } catch (err) {
        console.error('QR render error:', err?.message || err);
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      link.connected = true;
      link.qrString = null;
      link.qrDataUrl = null;
      link.pairingCode = null;
      stopRefreshers();
    } else if (connection === 'close') {
      link.connected = false;
      stopRefreshers();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
      else console.log(`❌ Logged out. Delete the ${AUTH_DIR} folder and re-pair.`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // skip groups & status

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';
        if (!text.trim()) continue;

        const phone = jid.split('@')[0];
        console.log(`📩 ${phone}: ${text}`);

        await sock.sendPresenceUpdate('composing', jid);
        const reply = await handleMessage(jid, text, phone);
        await sock.sendMessage(jid, { text: reply });
        console.log(`📤 ${phone}: ${reply.replace(/\n/g, ' ')}`);
      } catch (err) {
        console.error('Message handling error:', err?.message || err);
      }
    }
  });

  return sock;
}

// ----------------------------------------------------------------------------
// Web server — /qr page (auto-refreshes every 30s to show a fresh QR / code)
// ----------------------------------------------------------------------------
function qrPageHtml() {
  if (link.connected) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp Bot</title></head>
<body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b141a;color:#e9edef">
<h1>✅ Connected</h1><p>WhatsApp bot is linked and running.</p></body></html>`;
  }

  const qrBlock = link.qrDataUrl
    ? `<img src="${link.qrDataUrl}" alt="WhatsApp QR" style="width:320px;height:320px;background:#fff;padding:8px;border-radius:12px">`
    : `<p style="opacity:.7">Generating QR… (refresh in a few seconds)</p>`;

  const codeBlock = link.pairingCode
    ? `<div style="margin-top:24px">
         <p style="opacity:.7;margin:0">Or link with phone number — pairing code:</p>
         <div style="font-size:32px;letter-spacing:4px;font-weight:700;margin-top:8px">${link.pairingCode}</div>
       </div>`
    : '';

  const stamp = link.updatedAt ? link.updatedAt.toLocaleTimeString() : '—';

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan WhatsApp QR</title></head>
<body style="font-family:sans-serif;text-align:center;padding:32px;background:#0b141a;color:#e9edef">
<h1>📲 Link WhatsApp</h1>
<p style="opacity:.7">WhatsApp &gt; Linked Devices &gt; Link a Device</p>
${qrBlock}
${codeBlock}
<p style="opacity:.5;margin-top:24px;font-size:13px">Auto-refreshes every 30s • last update ${stamp}</p>
</body></html>`;
}

function startWebServer() {
  http
    .createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (url === '/qr' || url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(qrPageHtml());
      } else if (url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connected: link.connected, hasQr: !!link.qrDataUrl, pairingCode: link.pairingCode }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    })
    .listen(PORT, () => console.log(`🌐 Web server on :${PORT} — QR page at /qr`));
}

startWebServer();
startBot().catch((err) => console.error('Fatal startup error:', err));
