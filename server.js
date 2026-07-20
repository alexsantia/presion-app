// Backend de Reigning Blood Pressure App (multipaciente).
// Cada paciente tiene su propia cuenta; cada médico está ligado a un solo
// paciente vía un enlace de invitación de un solo uso. Este servidor nunca
// guarda contraseñas en texto plano (usa bcrypt) y es el único que conoce el
// token de Sheets (nunca llega al navegador).

require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");

const {
  PORT = 3000,
  SESSION_SECRET,
  SHEETS_WEBAPP_URL,
  SHEETS_TOKEN,
} = process.env;

if (!SESSION_SECRET || !SHEETS_WEBAPP_URL || !SHEETS_TOKEN) {
  console.error(
    "Faltan variables de entorno. Revisa .env.example y crea tu propio .env con " +
    "SESSION_SECRET, SHEETS_WEBAPP_URL y SHEETS_TOKEN."
  );
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  cookieSession({
    name: "bp_session",
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  })
);
// Solo se expone estáticamente la carpeta "shared" (JS común, sin datos ni
// lógica de sesión). Las páginas HTML se sirven una por una más abajo con
// sendFile, cada una detrás de su propio control de acceso, para que nadie
// pueda pedir /index.html o /doctor.html directo sin pasar por ahí.
app.use("/shared", express.static(path.join(__dirname, "public", "shared")));

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

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message }));
}

// ---- Middlewares de autenticación ----
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

app.post("/logout", (req, res) => {
  const wasDoctor = req.session && req.session.role === "doctor";
  req.session = null;
  res.redirect(wasDoctor ? "/doctor/login" : "/login");
});

// ================= PACIENTE =================

app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, "public", "signup.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/", requireRole("patient"), (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.post("/signup", asyncRoute(async (req, res) => {
  const { name, email, password, birthdate } = req.body;
  if (!name || !email || !password || !birthdate) return res.status(400).json({ ok: false, error: "faltan datos" });
  if (password.length < 8) return res.status(400).json({ ok: false, error: "la contraseña debe tener al menos 8 caracteres" });
  const hash = await bcrypt.hash(password, 10);
  const result = await callSheetsApi(null, { action: "signup_patient", name, email, password_hash: hash, birthdate: birthdate || "" });
  if (!result.ok) return res.status(400).json(result);
  req.session = { role: "patient", patientId: result.id, email: String(email).toLowerCase() };
  res.json({ ok: true, redirect: "/" });
}));

app.post("/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  const result = await callSheetsApi({ action: "get_patient_by_email", email: String(email || "").toLowerCase() });
  const patient = result.ok ? result.data : null;
  if (!patient || !(await bcrypt.compare(password || "", patient.password_hash || ""))) {
    return res.status(401).json({ ok: false, error: "correo o contraseña incorrectos" });
  }
  req.session = { role: "patient", patientId: patient.id, email: patient.email };
  res.json({ ok: true, redirect: "/" });
}));

// ================= MEDICO =================

app.get("/doctor/invite/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "doctor-invite.html")));
app.get("/doctor/login", (req, res) => res.sendFile(path.join(__dirname, "public", "doctor-login.html")));
app.get("/doctor", requireRole("doctor"), (req, res) => res.sendFile(path.join(__dirname, "public", "doctor.html")));

app.get("/api/invite/:token", asyncRoute(async (req, res) => {
  const result = await callSheetsApi({ action: "get_patient_by_invite_token", token_value: req.params.token });
  res.json(result);
}));

app.post("/doctor/signup", asyncRoute(async (req, res) => {
  const { invite_token, name, email, password } = req.body;
  if (!invite_token || !name || !email || !password) return res.status(400).json({ ok: false, error: "faltan datos" });
  if (password.length < 8) return res.status(400).json({ ok: false, error: "la contraseña debe tener al menos 8 caracteres" });
  const hash = await bcrypt.hash(password, 10);
  const result = await callSheetsApi(null, { action: "signup_doctor", invite_token, name, email, password_hash: hash });
  if (!result.ok) return res.status(400).json(result);
  req.session = { role: "doctor", doctorId: result.id, patientId: result.patient_id, email: String(email).toLowerCase() };
  res.json({ ok: true, redirect: "/doctor" });
}));

app.post("/doctor/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  const result = await callSheetsApi({ action: "get_doctor_by_email", email: String(email || "").toLowerCase() });
  const doctor = result.ok ? result.data : null;
  if (!doctor || !(await bcrypt.compare(password || "", doctor.password_hash || ""))) {
    return res.status(401).json({ ok: false, error: "correo o contraseña incorrectos" });
  }
  req.session = { role: "doctor", doctorId: doctor.id, patientId: doctor.patient_id, email: doctor.email };
  res.json({ ok: true, redirect: "/doctor" });
}));

// ================= FAMILIA (público, solo lectura) =================

app.get("/familia/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "familia.html")));

app.get("/api/familia/:token", asyncRoute(async (req, res) => {
  const patientResult = await callSheetsApi({ action: "get_patient_by_share_token", token_value: req.params.token });
  if (!patientResult.ok || !patientResult.data) return res.status(404).json({ ok: false, error: "enlace no válido" });
  const patient = patientResult.data;
  const readingsResult = await callSheetsApi({ action: "list", patient_id: patient.id });
  res.json({ ok: true, data: { patient: { name: patient.name, birthdate: patient.birthdate }, readings: readingsResult.ok ? readingsResult.data : [] } });
}));

// ================= API con sesión (paciente y/o médico) =================

app.get("/api/readings", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list", patient_id: req.session.patientId }));
}));
app.post("/api/readings", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "add", patient_id: req.session.patientId, ...req.body }));
}));
app.put("/api/readings/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "update", patient_id: req.session.patientId, id: req.params.id, ...req.body }));
}));
app.delete("/api/readings/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "delete", patient_id: req.session.patientId, id: req.params.id }));
}));

app.get("/api/comments", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_comments", patient_id: req.session.patientId }));
}));
app.post("/api/comments", requireRole("doctor"), asyncRoute(async (req, res) => {
  const doctorResult = await callSheetsApi({ action: "get_doctor_by_id", id: req.session.doctorId });
  const authorName = (doctorResult.ok && doctorResult.data && doctorResult.data.name) || "Médico";
  res.json(await callSheetsApi(null, { action: "add_comment", patient_id: req.session.patientId, author: authorName, ...req.body }));
}));

// Perfil público del paciente ligado a la sesión (paciente viendo el suyo, o
// médico viendo el de su paciente asignado).
app.get("/api/patient", requireAnyRole, asyncRoute(async (req, res) => {
  const result = await callSheetsApi({ action: "get_patient_by_id", id: req.session.patientId });
  res.json(result);
}));

app.get("/api/account", requireAnyRole, asyncRoute(async (req, res) => {
  if (req.session.role === "patient") {
    const result = await callSheetsApi({ action: "get_patient_by_id", id: req.session.patientId });
    return res.json(result);
  }
  const result = await callSheetsApi({ action: "get_doctor_by_id", id: req.session.doctorId });
  res.json(result);
}));

app.post("/api/account/profile", requireRole("patient"), asyncRoute(async (req, res) => {
  const { name, birthdate } = req.body;
  res.json(await callSheetsApi(null, { action: "update_patient_profile", id: req.session.patientId, name, birthdate }));
}));

app.post("/api/account/password", requireAnyRole, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ ok: false, error: "la nueva contraseña debe tener al menos 8 caracteres" });

  if (req.session.role === "patient") {
    const result = await callSheetsApi({ action: "get_patient_by_email", email: req.session.email });
    const patient = result.ok ? result.data : null;
    if (!patient || !(await bcrypt.compare(currentPassword || "", patient.password_hash || ""))) {
      return res.status(401).json({ ok: false, error: "contraseña actual incorrecta" });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    return res.json(await callSheetsApi(null, { action: "update_patient_password", id: req.session.patientId, password_hash: hash }));
  }

  const result = await callSheetsApi({ action: "get_doctor_by_email", email: req.session.email });
  const doctor = result.ok ? result.data : null;
  if (!doctor || !(await bcrypt.compare(currentPassword || "", doctor.password_hash || ""))) {
    return res.status(401).json({ ok: false, error: "contraseña actual incorrecta" });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  res.json(await callSheetsApi(null, { action: "update_doctor_password", id: req.session.doctorId, password_hash: hash }));
}));

app.post("/api/account/email", requireRole("patient"), asyncRoute(async (req, res) => {
  const { currentPassword, newEmail } = req.body;
  const email = String(newEmail || "").toLowerCase().trim();
  if (!email) return res.status(400).json({ ok: false, error: "correo inválido" });
  const result = await callSheetsApi({ action: "get_patient_by_email", email: req.session.email });
  const patient = result.ok ? result.data : null;
  if (!patient || !(await bcrypt.compare(currentPassword || "", patient.password_hash || ""))) {
    return res.status(401).json({ ok: false, error: "contraseña actual incorrecta" });
  }
  const updateResult = await callSheetsApi(null, { action: "update_patient_email", id: req.session.patientId, email });
  if (!updateResult.ok) return res.status(400).json(updateResult);
  req.session.email = email;
  res.json({ ok: true, email });
}));

app.post("/api/account/params", requireRole("patient"), asyncRoute(async (req, res) => {
  const { last_lab_date, cholesterol, triglycerides, med_brand, med_mg } = req.body;
  res.json(await callSheetsApi(null, {
    action: "update_patient_params",
    id: req.session.patientId,
    last_lab_date, cholesterol, triglycerides, med_brand, med_mg,
  }));
}));

app.post("/api/account/invite", requireRole("patient"), asyncRoute(async (req, res) => {
  const result = await callSheetsApi(null, { action: "generate_doctor_invite", patient_id: req.session.patientId });
  res.json(result);
}));

app.post("/api/account/share-token/regenerate", requireRole("patient"), asyncRoute(async (req, res) => {
  const result = await callSheetsApi(null, { action: "regenerate_share_token", patient_id: req.session.patientId });
  res.json(result);
}));

app.listen(PORT, () => {
  console.log(`Reigning Blood Pressure App escuchando en http://localhost:${PORT}`);
});
