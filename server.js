// Backend del panel de presión arterial.
// Sirve el frontend, protege el sitio con una contraseña simple (son datos de
// salud), y hace de proxy hacia el Google Apps Script Web App: el token de
// Sheets vive solo aquí, nunca llega al navegador.

require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");

const {
  PORT = 3000,
  SESSION_SECRET,
  APP_PASSWORD,
  SHEETS_WEBAPP_URL,
  SHEETS_TOKEN,
} = process.env;

if (!SESSION_SECRET || !APP_PASSWORD || !SHEETS_WEBAPP_URL || !SHEETS_TOKEN) {
  console.error(
    "Faltan variables de entorno. Revisa .env.example y crea tu propio .env con " +
    "SESSION_SECRET, APP_PASSWORD, SHEETS_WEBAPP_URL y SHEETS_TOKEN."
  );
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1); // detrás de Nginx

app.use(express.json());
app.use(
  cookieSession({
    name: "bp_session",
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // requiere HTTPS en producción
  })
);

// ---- Login ----
app.get("/login", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Acceso</title>
<style>
  body { font-family: -apple-system, sans-serif; background:#f7f7f8; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  form { background:white; padding:28px; border-radius:10px; border:1px solid #e2e2e2; width:260px; }
  input { width:100%; padding:9px; margin-top:6px; margin-bottom:14px; border:1px solid #ddd; border-radius:6px; box-sizing:border-box; }
  button { width:100%; padding:10px; background:#1d1d1f; color:white; border:none; border-radius:6px; cursor:pointer; }
  .err { color:#a0182a; font-size:13px; margin-bottom:10px; }
</style></head>
<body>
  <form method="POST" action="/login">
    <label>Contraseña</label>
    <input type="password" name="password" autofocus required>
    ${req.query.error ? '<div class="err">Contraseña incorrecta.</div>' : ""}
    <button type="submit">Entrar</button>
  </form>
</body></html>`);
});

app.use(express.urlencoded({ extended: false }));

app.post("/login", (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    req.session.authed = true;
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("/login");
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "no autenticado" });
  return res.redirect("/login");
}

app.use(requireAuth);

// ---- Proxy hacia el Apps Script Web App ----
async function callSheetsApi(params, body) {
  let url = SHEETS_WEBAPP_URL;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  const options = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, token: SHEETS_TOKEN }) }
    : { method: "GET" };
  if (!body) url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(SHEETS_TOKEN);
  const resp = await fetch(url, options);
  return resp.json();
}

app.get("/api/readings", async (req, res) => {
  try {
    const data = await callSheetsApi({ action: "list" });
    res.json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});

app.post("/api/readings", async (req, res) => {
  try {
    const data = await callSheetsApi(null, { action: "add", ...req.body });
    res.json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});

app.put("/api/readings/:id", async (req, res) => {
  try {
    const data = await callSheetsApi(null, { action: "update", id: req.params.id, ...req.body });
    res.json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});

app.delete("/api/readings/:id", async (req, res) => {
  try {
    const data = await callSheetsApi(null, { action: "delete", id: req.params.id });
    res.json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});

// ---- Frontend estático (protegido por requireAuth) ----
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Panel de presión arterial escuchando en http://localhost:${PORT}`);
});
