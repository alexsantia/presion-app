// Backend de Reigning Blood Pressure App.
// Sirve dos vistas protegidas por contraseñas distintas (paciente y médico),
// y hace de proxy hacia el Google Apps Script Web App: el token de Sheets
// vive solo aquí, nunca llega al navegador.

require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");

const {
  PORT = 3000,
  SESSION_SECRET,
  APP_PASSWORD,
  DOCTOR_PASSWORD,
  SHEETS_WEBAPP_URL,
  SHEETS_TOKEN,
} = process.env;

if (!SESSION_SECRET || !APP_PASSWORD || !DOCTOR_PASSWORD || !SHEETS_WEBAPP_URL || !SHEETS_TOKEN) {
  console.error(
    "Faltan variables de entorno. Revisa .env.example y crea tu propio .env con " +
    "SESSION_SECRET, APP_PASSWORD, DOCTOR_PASSWORD, SHEETS_WEBAPP_URL y SHEETS_TOKEN."
  );
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1); // detrás de Nginx o de Render

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  cookieSession({
    name: "bp_session",
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  })
);

// ---- Login del paciente ----
function loginPage(title, action, error) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, sans-serif; background:#F4F7F5; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  form { background:white; padding:32px; border-radius:14px; border:1px solid #E1E9E4; width:280px; box-shadow: 0 2px 10px rgba(60,90,80,0.06); }
  h1 { font-size: 17px; margin: 0 0 4px 0; color:#33403D; }
  p.sub { font-size: 12px; color:#7C8A85; margin: 0 0 18px 0; }
  input { width:100%; padding:10px; margin-top:6px; margin-bottom:14px; border:1px solid #DCE5E0; border-radius:8px; box-sizing:border-box; font-size:14px; }
  button { width:100%; padding:11px; background:#4F7A6F; color:white; border:none; border-radius:8px; cursor:pointer; font-size:14px; }
  button:hover { background:#436A60; }
  .err { color:#B9564C; font-size:13px; margin-bottom:10px; }
</style></head>
<body>
  <form method="POST" action="${action}">
    <h1>Reigning Blood Pressure App</h1>
    <p class="sub">${title}</p>
    <label style="font-size:12px;color:#7C8A85;">Contraseña</label>
    <input type="password" name="password" autofocus required>
    ${error ? '<div class="err">Contraseña incorrecta.</div>' : ""}
    <button type="submit">Entrar</button>
  </form>
</body></html>`;
}

app.get("/login", (req, res) => {
  res.type("html").send(loginPage("Acceso del paciente", "/login", req.query.error));
});
app.post("/login", (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    req.session = { role: "patient" };
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.get("/doctor/login", (req, res) => {
  res.type("html").send(loginPage("Acceso del médico", "/doctor/login", req.query.error));
});
app.post("/doctor/login", (req, res) => {
  if (req.body.password === DOCTOR_PASSWORD) {
    req.session = { role: "doctor" };
    return res.redirect("/doctor");
  }
  res.redirect("/doctor/login?error=1");
});

app.post("/logout", (req, res) => {
  const wasDoctor = req.session && req.session.role === "doctor";
  req.session = null;
  res.redirect(wasDoctor ? "/doctor/login" : "/login");
});

function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.role === role) return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "no autenticado" });
    return res.redirect(role === "doctor" ? "/doctor/login" : "/login");
  };
}
function requireAnyRole(req, res, next) {
  if (req.session && (req.session.role === "patient" || req.session.role === "doctor")) return next();
  return res.status(401).json({ ok: false, error: "no autenticado" });
}

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

// ---- Vistas protegidas ----
app.get("/", requireRole("patient"), (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/doctor", requireRole("doctor"), (req, res) => {
  res.sendFile(path.join(__dirname, "public", "doctor.html"));
});

// ---- API: lecturas ----
app.get("/api/readings", requireAnyRole, async (req, res) => {
  try {
    res.json(await callSheetsApi({ action: "list" }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});
app.post("/api/readings", requireRole("patient"), async (req, res) => {
  try {
    res.json(await callSheetsApi(null, { action: "add", ...req.body }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});
app.put("/api/readings/:id", requireRole("patient"), async (req, res) => {
  try {
    res.json(await callSheetsApi(null, { action: "update", id: req.params.id, ...req.body }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});
app.delete("/api/readings/:id", requireRole("patient"), async (req, res) => {
  try {
    res.json(await callSheetsApi(null, { action: "delete", id: req.params.id }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});

// ---- API: perfil del paciente ----
app.get("/api/profile", requireAnyRole, async (req, res) => {
  try {
    res.json(await callSheetsApi({ action: "get_profile" }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});
app.post("/api/profile", requireRole("patient"), async (req, res) => {
  try {
    res.json(await callSheetsApi(null, { action: "set_profile", ...req.body }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});

// ---- API: comentarios del médico ----
app.get("/api/comments", requireAnyRole, async (req, res) => {
  try {
    res.json(await callSheetsApi({ action: "list_comments" }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});
app.post("/api/comments", requireRole("doctor"), async (req, res) => {
  try {
    res.json(await callSheetsApi(null, { action: "add_comment", author: "Médico", ...req.body }));
  } catch (err) {
    res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Reigning Blood Pressure App escuchando en http://localhost:${PORT}`);
});
