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
  DB_BACKEND = "sheets", // "sheets" (MVP1, Google Sheets vía Apps Script) o "postgres" (MVP2)
  DATABASE_URL,
} = process.env;

if (!SESSION_SECRET) {
  console.error("Falta SESSION_SECRET en las variables de entorno.");
  process.exit(1);
}
if (DB_BACKEND === "postgres") {
  if (!DATABASE_URL) {
    console.error("DB_BACKEND=postgres pero falta DATABASE_URL en las variables de entorno.");
    process.exit(1);
  }
} else if (!SHEETS_WEBAPP_URL || !SHEETS_TOKEN) {
  console.error(
    "Faltan variables de entorno. Revisa .env.example y crea tu propio .env con " +
    "SESSION_SECRET, SHEETS_WEBAPP_URL y SHEETS_TOKEN."
  );
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

// El límite por default de express.json() (100kb) se queda corto para
// restaurar un respaldo con muchos años de lecturas/comentarios/reacciones
// (ver /api/account/restore, v28); 10mb es generoso incluso para varios años
// de historial diario.
app.use(express.json({ limit: "10mb" }));
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
app.use("/shared", express.static(path.join(__dirname, "public", "shared"), {
  setHeaders: res => res.set("Cache-Control", "no-cache, no-store, must-revalidate"),
}));

// Las páginas HTML (con su CSS y JS embebidos) nunca deben quedarse en el
// caché del navegador: cada vez que se despliega una versión nueva, el
// usuario tiene que recibirla en la siguiente visita sin necesidad de
// borrar caché a mano. Por default, sendFile deja que el navegador
// revalide con ETag/Last-Modified, lo cual en la práctica a veces se
// queda sirviendo una copia vieja (sobre todo detrás de algún proxy/CDN
// del dominio propio). Forzamos no-cache explícito para evitarlo.
function sendPage_(res, filename) {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", filename));
}

// ---- Acceso a datos: Google Sheets (MVP1) o Postgres (MVP2) ----
// callSheetsApi(params, body) es el único punto de contacto con la base de
// datos en todo este archivo. El nombre se conserva (en vez de renombrarlo a
// algo genérico) para no tocar ninguna otra línea de este servidor durante
// la migración: todas las rutas de abajo siguen llamando a callSheetsApi
// exactamente igual, sin saber ni importarles cuál de los dos backends
// responde. Cuál se usa se decide una sola vez aquí, con DB_BACKEND.
async function callSheetsApiViaAppsScript_(params, body) {
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
const callSheetsApi = DB_BACKEND === "postgres"
  ? require("./db-postgres").callPostgresApi
  : callSheetsApiViaAppsScript_;
console.log(`Reigning Blood Pressure App: backend de datos = ${DB_BACKEND === "postgres" ? "Postgres (MVP2)" : "Google Sheets (MVP1)"}`);

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => res.status(502).json({ ok: false, error: "no se pudo contactar Google Sheets: " + err.message }));
}

// ---- Migración manual Sheets -> Postgres (solo backend Postgres/MVP2) ----
// Ruta protegida por un secreto para copiar los datos de Sheets a esta
// misma base de datos sin necesitar terminal local ni consola de Render:
// basta con visitar la URL una vez desde el navegador. Solo lee de Sheets,
// nunca escribe ahí; es seguro visitarla más de una vez (reemplaza los
// datos del paciente indicado con la copia más reciente de Sheets).
if (DB_BACKEND === "postgres") {
  app.get("/internal/migrate", asyncRoute(async (req, res) => {
    const { MIGRATION_SECRET, SHEETS_WEBAPP_URL: SRC_URL, SHEETS_TOKEN: SRC_TOKEN } = process.env;
    if (!MIGRATION_SECRET || req.query.secret !== MIGRATION_SECRET) {
      return res.status(403).send("secreto inválido o faltante (usa ?secret=...)");
    }
    if (!SRC_URL || !SRC_TOKEN) {
      return res.status(500).send("faltan SHEETS_WEBAPP_URL/SHEETS_TOKEN como variables de entorno en este servicio");
    }
    const emails = String(req.query.emails || "alejandro@empresso.mx").split(",").map(s => s.trim()).filter(Boolean);
    const { runMigration } = require("./scripts/migrate-sheets-to-postgres");
    const { pool: pgPool } = require("./db-postgres");
    const lines = [];
    const log = (...args) => lines.push(args.join(" "));
    const results = await runMigration({ sheetsWebappUrl: SRC_URL, sheetsToken: SRC_TOKEN, pool: pgPool, emails, log });
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(lines.join("\n") + "\n\n" + JSON.stringify(results, null, 2));
  }));
}

// ---- Middlewares de autenticación ----
// Para el rol de médico, además de revisar la sesión, se vuelve a confirmar
// en cada request que la cuenta de médico siga existiendo en Medicos: así,
// si el paciente le quita el acceso a un médico (ver /api/account/doctors),
// la próxima vez que ese médico cargue una página o llame a la API pierde el
// acceso de inmediato, en vez de seguir entrando con la sesión vieja hasta
// que expire sola.
async function doctorStillLinked_(doctorId) {
  try {
    const result = await callSheetsApi({ action: "get_doctor_by_id", id: doctorId });
    return !!(result.ok && result.data);
  } catch (err) {
    return null; // no se pudo verificar (problema de red) — se trata distinto de "no existe"
  }
}
// v30: además de "¿sigue existiendo/ligado?", ahora también hay que
// verificar "¿lo suspendió el administrador?" en cada request, no solo al
// iniciar sesión — si no, alguien suspendido seguiría entrando con la
// sesión ya abierta hasta que expirara sola (30 días).
async function doctorAccountStatus_(doctorId) {
  try {
    const result = await callSheetsApi({ action: "get_doctor_by_id", id: doctorId });
    if (!(result.ok && result.data)) return { exists: false };
    return { exists: true, suspended: !!result.data.suspended };
  } catch (err) {
    return { exists: null }; // no se pudo verificar (problema de red)
  }
}
async function patientAccountStatus_(patientId) {
  try {
    const result = await callSheetsApi({ action: "get_patient_by_id", id: patientId });
    if (!(result.ok && result.data)) return { exists: false };
    return { exists: true, suspended: !!result.data.suspended };
  } catch (err) {
    return { exists: null };
  }
}
function requireRole(role) {
  return async (req, res, next) => {
    if (!(req.session && req.session.role === role)) {
      if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "no autenticado" });
      return res.redirect(role === "doctor" ? "/doctor/login" : (role === "admin" ? "/admin/login" : "/login"));
    }
    if (role === "doctor") {
      const status = await doctorAccountStatus_(req.session.doctorId);
      if (status.exists === false) {
        req.session = null;
        if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "tu acceso de médico fue revocado" });
        return res.redirect("/doctor/login");
      }
      if (status.exists === null) return res.status(502).json({ ok: false, error: "no se pudo verificar tu acceso, intenta de nuevo" });
      if (status.suspended) {
        req.session = null;
        if (req.path.startsWith("/api/")) return res.status(403).json({ ok: false, error: "tu cuenta fue suspendida, contacta al administrador" });
        return res.redirect("/doctor/login");
      }
    }
    if (role === "patient") {
      const status = await patientAccountStatus_(req.session.patientId);
      if (status.exists === false) {
        req.session = null;
        if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "cuenta no encontrada" });
        return res.redirect("/login");
      }
      if (status.suspended) {
        req.session = null;
        if (req.path.startsWith("/api/")) return res.status(403).json({ ok: false, error: "tu cuenta fue suspendida, contacta al administrador" });
        return res.redirect("/login");
      }
    }
    next();
  };
}
async function requireAnyRole(req, res, next) {
  if (!(req.session && (req.session.role === "patient" || req.session.role === "doctor"))) {
    return res.status(401).json({ ok: false, error: "no autenticado" });
  }
  if (req.session.role === "doctor") {
    const status = await doctorAccountStatus_(req.session.doctorId);
    if (status.exists === false) {
      req.session = null;
      return res.status(401).json({ ok: false, error: "tu acceso de médico fue revocado" });
    }
    if (status.exists === null) return res.status(502).json({ ok: false, error: "no se pudo verificar tu acceso, intenta de nuevo" });
    if (status.suspended) {
      req.session = null;
      return res.status(403).json({ ok: false, error: "tu cuenta fue suspendida, contacta al administrador" });
    }
  }
  if (req.session.role === "patient") {
    const status = await patientAccountStatus_(req.session.patientId);
    if (status.suspended) {
      req.session = null;
      return res.status(403).json({ ok: false, error: "tu cuenta fue suspendida, contacta al administrador" });
    }
  }
  next();
}

// ---- Tiempo real (SSE) — solo disponible con backend Postgres (MVP2) ----
// Server-Sent Events: cada pestaña abierta (paciente, médico o familia)
// mantiene una conexión abierta a esta ruta; cuando algo cambia (lectura,
// comentario o reacción) se le manda un aviso mínimo — nunca el dato en sí,
// para no duplicar aquí la lógica de permisos/roles que ya vive en las
// rutas normales de la API — y la propia página reutiliza sus funciones de
// carga ya existentes (loadAndRender, loadComments, etc.) para refrescarse
// sola, sin que el usuario tenga que recargar la pantalla.
if (DB_BACKEND === "postgres") {
  const { events: dbEvents } = require("./db-postgres");
  const streamClients = new Map(); // patient_id -> Set<res>

  function addStreamClient_(patientId, res) {
    if (!streamClients.has(patientId)) streamClients.set(patientId, new Set());
    streamClients.get(patientId).add(res);
  }
  function removeStreamClient_(patientId, res) {
    const set = streamClients.get(patientId);
    if (!set) return;
    set.delete(res);
    if (!set.size) streamClients.delete(patientId);
  }
  dbEvents.on("change", (patientId, kind) => {
    const set = streamClients.get(patientId);
    if (!set || !set.size) return;
    const payload = `data: ${JSON.stringify({ type: kind })}\n\n`;
    for (const res of set) {
      try { res.write(payload); } catch (err) { /* el cliente ya se desconectó */ }
    }
  });

  function wireStream_(req, res, patientId) {
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": conectado\n\n");
    addStreamClient_(patientId, res);
    // Ping cada 25s para que proxies/navegadores no cierren la conexión por
    // inactividad (varios cortan cerca de los 55-60s sin datos).
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch (err) { clearInterval(ping); }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      removeStreamClient_(patientId, res);
    });
  }

  // Paciente o médico logueado: el patient_id siempre sale de la sesión,
  // nunca de un parámetro que el cliente pudiera manipular.
  app.get("/api/stream", requireAnyRole, (req, res) => {
    wireStream_(req, res, req.session.patientId);
  });

  // Familia/amigos (enlace público, sin cuenta): el patient_id se resuelve
  // a partir del token, igual que en /api/familia/:token.
  app.get("/familia/:token/stream", asyncRoute(async (req, res) => {
    const patientResult = await callSheetsApi({ action: "get_patient_by_share_token", token_value: req.params.token });
    if (!patientResult.ok || !patientResult.data) return res.status(404).end();
    wireStream_(req, res, patientResult.data.id);
  }));

  // ---- Recordatorios de medicamentos (v30.8) ----
  // Escaneo periódico: manda push al paciente cuando toca una dosis y no se
  // ha marcado como tomada, y vuelve a insistir cada 30 minutos (ver
  // scanMedicationReminders en db-postgres.js para el detalle de cuándo para
  // de insistir). Corre cada 5 minutos, más una vez al arrancar el servidor
  // para no esperar los primeros 5 minutos tras cada despliegue — pero
  // esperando primero a que ensureSchema() termine, porque este bloque corre
  // justo al arrancar el proceso y podía ganarle la carrera a la creación de
  // las tablas (visto en pruebas: "relation medicamentos does not exist").
  const { scanMedicationReminders, ensureSchema: ensureSchemaForMeds } = require("./db-postgres");
  const MEDICATION_SCAN_INTERVAL_MS = 5 * 60 * 1000;
  ensureSchemaForMeds()
    .then(() => scanMedicationReminders())
    .catch(err => console.error("[medicamentos] error en el escaneo inicial:", err.message));
  setInterval(() => {
    scanMedicationReminders().catch(err => console.error("[medicamentos] error en el escaneo de recordatorios:", err.message));
  }, MEDICATION_SCAN_INTERVAL_MS);
}

app.post("/logout", (req, res) => {
  const wasDoctor = req.session && req.session.role === "doctor";
  req.session = null;
  res.redirect(wasDoctor ? "/doctor/login" : "/login");
});

// El origen (esquema + host) de la request actual, para armar el enlace que
// va dentro del correo de "Olvidé mi contraseña". Como "trust proxy" ya está
// activado, esto respeta el dominio real que el usuario está usando (por
// ejemplo rbp.alexsantia.com), no una URL fija de onrender.com.
function requestOrigin_(req) {
  return `${req.protocol}://${req.get("host")}`;
}

// Verifica si un enlace de "Olvidé mi contraseña" sigue siendo válido, antes
// de mostrarle el formulario de nueva contraseña al usuario. type=patient|doctor.
app.get("/api/reset-token/:token", asyncRoute(async (req, res) => {
  const accountType = req.query.type === "doctor" ? "doctor" : "patient";
  const result = await callSheetsApi({ action: "verify_reset_token", token_value: req.params.token, account_type: accountType });
  res.json(result);
}));

// ================= PACIENTE =================

app.get("/signup", (req, res) => sendPage_(res, "signup.html"));
app.get("/login", (req, res) => sendPage_(res, "login.html"));
app.get("/", requireRole("patient"), (req, res) => sendPage_(res, "index.html"));

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
  if (patient.suspended) {
    return res.status(403).json({ ok: false, error: "tu cuenta fue suspendida, contacta al administrador" });
  }
  req.session = { role: "patient", patientId: patient.id, email: patient.email };
  res.json({ ok: true, redirect: "/" });
}));

app.get("/forgot-password", (req, res) => sendPage_(res, "forgot-password.html"));
app.post("/forgot-password", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const result = await callSheetsApi(null, { action: "request_password_reset", account_type: "patient", email, origin: requestOrigin_(req) });
  // El correo de MailApp no siempre llega (permisos/cuota de Google), así
  // que el enlace también se regresa aquí para poder usarlo directo desde
  // la página, sin depender del correo.
  res.json({ ok: true, reset_url: result.ok ? result.reset_url : undefined });
}));
app.get("/reset-password/:token", (req, res) => sendPage_(res, "reset-password.html"));
app.post("/reset-password/:token", asyncRoute(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ ok: false, error: "la nueva contraseña debe tener al menos 8 caracteres" });
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await callSheetsApi(null, { action: "reset_password_with_token", account_type: "patient", reset_token: req.params.token, password_hash: hash });
  res.json(result);
}));

// ================= MEDICO =================

app.get("/doctor/invite/:token", (req, res) => sendPage_(res, "doctor-invite.html"));
app.get("/doctor/login", (req, res) => sendPage_(res, "doctor-login.html"));
app.get("/doctor", requireRole("doctor"), (req, res) => sendPage_(res, "doctor.html"));

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
  if (doctor.suspended) {
    return res.status(403).json({ ok: false, error: "tu cuenta fue suspendida, contacta al administrador" });
  }
  req.session = { role: "doctor", doctorId: doctor.id, patientId: doctor.patient_id, email: doctor.email };
  res.json({ ok: true, redirect: "/doctor" });
}));

app.get("/doctor/forgot-password", (req, res) => sendPage_(res, "doctor-forgot-password.html"));
app.post("/doctor/forgot-password", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const result = await callSheetsApi(null, { action: "request_password_reset", account_type: "doctor", email, origin: requestOrigin_(req) });
  res.json({ ok: true, reset_url: result.ok ? result.reset_url : undefined });
}));
app.get("/doctor/reset-password/:token", (req, res) => sendPage_(res, "doctor-reset-password.html"));
app.post("/doctor/reset-password/:token", asyncRoute(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ ok: false, error: "la nueva contraseña debe tener al menos 8 caracteres" });
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await callSheetsApi(null, { action: "reset_password_with_token", account_type: "doctor", reset_token: req.params.token, password_hash: hash });
  res.json(result);
}));

// ================= FAMILIA (público, solo lectura) =================

app.get("/familia/:token", (req, res) => sendPage_(res, "familia.html"));

app.get("/api/familia/:token", asyncRoute(async (req, res) => {
  const patientResult = await callSheetsApi({ action: "get_patient_by_share_token", token_value: req.params.token });
  if (!patientResult.ok || !patientResult.data) return res.status(404).json({ ok: false, error: "enlace no válido" });
  const patient = patientResult.data;
  const readingsResult = await callSheetsApi({ action: "list", patient_id: patient.id });
  const reactionsResult = await callSheetsApi({ action: "list_reactions", patient_id: patient.id });
  const broadcastsResult = await callSheetsApi({ action: "get_active_broadcasts", audience: "family" });
  const labHistoryResult = await callSheetsApi({ action: "list_lab_history", patient_id: patient.id });
  const medicationsResult = await callSheetsApi({ action: "list_medications", patient_id: patient.id });
  const exercisesResult = await callSheetsApi({ action: "list_exercises", patient_id: patient.id });
  const medAdherenceResult = await callSheetsApi({ action: "list_medication_adherence", patient_id: patient.id });
  const consultationsResult = await callSheetsApi({ action: "list_consultations", patient_id: patient.id });
  res.json({
    ok: true,
    data: {
      patient: { id: patient.id, name: patient.name, birthdate: patient.birthdate, med_brand: patient.med_brand, med_mg: patient.med_mg },
      readings: readingsResult.ok ? readingsResult.data : [],
      reactions: reactionsResult.ok ? reactionsResult.data : [],
      broadcasts: broadcastsResult.ok ? broadcastsResult.data : [],
      labHistory: labHistoryResult.ok ? labHistoryResult.data : [],
      medications: medicationsResult.ok ? medicationsResult.data : [],
      exercises: exercisesResult.ok ? exercisesResult.data : [],
      medAdherence: medAdherenceResult.ok ? medAdherenceResult.data : [],
      consultations: consultationsResult.ok ? consultationsResult.data : [],
    },
  });
}));
// Foto de receta para el enlace de familia (sin sesión): el patient_id se
// resuelve del token, igual que el resto de esta ruta, y getConsultationReceta
// filtra por ese patient_id, así que un token de un paciente nunca puede
// destapar la receta de otro con solo adivinar el id de la consulta. Solo
// existe con backend Postgres (igual que /api/consultations/:id/photo),
// porque el backend Sheets nunca implementó almacenamiento binario.
if (DB_BACKEND === "postgres") {
  app.get("/familia/:token/consultations/:id/photo", asyncRoute(async (req, res) => {
    const patientResult = await callSheetsApi({ action: "get_patient_by_share_token", token_value: req.params.token });
    if (!patientResult.ok || !patientResult.data) return res.status(404).end();
    const { getConsultationReceta } = require("./db-postgres");
    const photo = await getConsultationReceta(patientResult.data.id, req.params.id);
    if (!photo) return res.status(404).end();
    res.set("Content-Type", photo.mime);
    res.set("Cache-Control", "private, max-age=300");
    res.send(photo.data);
  }));
}

// Reacción de familia/amigos (sin cuenta): el patient_id nunca se toma del
// body, siempre se resuelve aquí a partir del token del enlace, para que
// nadie pueda mandar reacciones a un paciente que no le corresponde a ese
// enlace. reactor_id es un id anónimo generado y guardado por el propio
// navegador de esa persona (ver wireReactionBars en common.js).
app.post("/api/familia/:token/react", asyncRoute(async (req, res) => {
  const patientResult = await callSheetsApi({ action: "get_patient_by_share_token", token_value: req.params.token });
  if (!patientResult.ok || !patientResult.data) return res.status(404).json({ ok: false, error: "enlace no válido" });
  const patient = patientResult.data;
  const { target_type, target_id, reaction, reactor_id } = req.body;
  if (!reactor_id) return res.status(400).json({ ok: false, error: "faltan datos" });
  const result = await callSheetsApi(null, {
    action: "toggle_reaction", patient_id: patient.id, target_type, target_id, reaction,
    reactor_role: "family", reactor_id,
  });
  res.json(result);
}));

// ================= ADMIN (v30) =================
// Panel maestro de administrador: cuentas del propio equipo de Reigning
// Blood Pressure App, no de pacientes/médicos. No hay registro público —
// la única cuenta de administrador se crea/actualiza sola al arrancar el
// servidor a partir de ADMIN_EMAIL/ADMIN_PASSWORD (ver más abajo, junto al
// resto de lo que solo existe con backend Postgres).

app.get("/admin/login", (req, res) => sendPage_(res, "admin-login.html"));
app.get("/admin", requireRole("admin"), (req, res) => sendPage_(res, "admin.html"));

app.post("/admin/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  const result = await callSheetsApi({ action: "get_admin_by_email", email: String(email || "").toLowerCase() });
  const admin = result.ok ? result.data : null;
  if (!admin || !(await bcrypt.compare(password || "", admin.password_hash || ""))) {
    return res.status(401).json({ ok: false, error: "correo o contraseña incorrectos" });
  }
  req.session = { role: "admin", adminId: admin.id, email: admin.email };
  res.json({ ok: true, redirect: "/admin" });
}));

app.get("/api/admin/accounts", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_all_accounts" }));
}));
app.post("/api/admin/accounts/:type/:id/suspend", requireRole("admin"), asyncRoute(async (req, res) => {
  const accountType = req.params.type === "doctor" ? "doctor" : "patient";
  const result = await callSheetsApi(null, { action: "toggle_account_suspended", account_type: accountType, id: req.params.id, suspended: !!req.body.suspended });
  res.json(result);
}));
app.get("/api/admin/stats", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "usage_stats" }));
}));
app.get("/api/admin/broadcasts", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_broadcasts" }));
}));
app.post("/api/admin/broadcasts", requireRole("admin"), asyncRoute(async (req, res) => {
  if (!req.body.title || !String(req.body.title).trim()) return res.status(400).json({ ok: false, error: "escribe un título" });
  res.json(await callSheetsApi(null, { action: "create_broadcast", title: req.body.title, body: req.body.body || "", audience: req.body.audience || "all" }));
}));
app.post("/api/admin/broadcasts/:id/deactivate", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "deactivate_broadcast", id: req.params.id }));
}));
app.get("/api/admin/tickets", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_all_tickets" }));
}));
app.get("/api/admin/tickets/:id/messages", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "get_ticket_messages", ticket_id: req.params.id }));
}));
app.post("/api/admin/tickets/:id/messages", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "add_ticket_message", ticket_id: req.params.id, author_role: "admin", text: req.body.text }));
}));
app.post("/api/admin/tickets/:id/status", requireRole("admin"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "set_ticket_status", id: req.params.id, status: req.body.status }));
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

app.get("/api/symptoms", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_symptoms", patient_id: req.session.patientId }));
}));
app.post("/api/symptoms", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "add_symptom", patient_id: req.session.patientId, ...req.body }));
}));
app.delete("/api/symptoms/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "delete_symptom", patient_id: req.session.patientId, id: req.params.id }));
}));

app.get("/api/lab-history", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_lab_history", patient_id: req.session.patientId }));
}));

// ---- Medicamentos (v30.8) ----
// El calendario semanal se calcula solo (a partir de la frecuencia y la
// primera toma), así que médico y familia lo ven en solo lectura vía este
// mismo GET; solo el paciente puede crear/editar/eliminar medicamentos y
// marcar sus propias dosis del día como tomadas.
app.get("/api/medications", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_medications", patient_id: req.session.patientId }));
}));
app.post("/api/medications", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "add_medication", patient_id: req.session.patientId, ...req.body }));
}));
app.put("/api/medications/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "update_medication", patient_id: req.session.patientId, id: req.params.id, ...req.body }));
}));
app.delete("/api/medications/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "delete_medication", patient_id: req.session.patientId, id: req.params.id }));
}));
app.get("/api/medication-doses/today", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_today_doses", patient_id: req.session.patientId }));
}));
app.post("/api/medication-doses/mark", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, {
    action: "set_dose_taken", patient_id: req.session.patientId,
    medication_id: req.body.medication_id, dose_time: req.body.dose_time, taken: req.body.taken,
  }));
}));

// ---- Ejercicio (v30.10): captura manual, calorías calculadas en el servidor ----
app.get("/api/exercise-types", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_exercise_types" }));
}));
app.get("/api/medication-adherence", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_medication_adherence", patient_id: req.session.patientId }));
}));
app.get("/api/exercises", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_exercises", patient_id: req.session.patientId }));
}));
app.post("/api/exercises", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "add_exercise", patient_id: req.session.patientId, ...req.body }));
}));
app.put("/api/exercises/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "update_exercise", patient_id: req.session.patientId, id: req.params.id, ...req.body }));
}));
app.delete("/api/exercises/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "delete_exercise", patient_id: req.session.patientId, id: req.params.id }));
}));

// ---- Consultas médicas (v30.12) ----
app.get("/api/consultations", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_consultations", patient_id: req.session.patientId }));
}));
app.post("/api/consultations", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "add_consultation", patient_id: req.session.patientId, ...req.body }));
}));
app.put("/api/consultations/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "update_consultation", patient_id: req.session.patientId, id: req.params.id, ...req.body }));
}));
app.delete("/api/consultations/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "delete_consultation", patient_id: req.session.patientId, id: req.params.id }));
}));
// La foto de la receta se sirve por HTTP directo (Buffer, no JSON/base64),
// igual que el avatar — por eso su ruta vive más abajo, junto con
// /api/avatar/:type/:id, dentro del bloque exclusivo de backend Postgres
// (con backend Sheets nunca existió almacenamiento binario).

app.get("/api/habits", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_habits", patient_id: req.session.patientId }));
}));
app.post("/api/habits", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "add_habit", patient_id: req.session.patientId, ...req.body }));
}));
app.delete("/api/habits/:id", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "delete_habit", patient_id: req.session.patientId, id: req.params.id }));
}));

app.get("/api/comments", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_comments", patient_id: req.session.patientId }));
}));
// El médico puede dejar comentarios nuevos o responder a cualquiera. El
// paciente solo puede responder a un comentario existente (necesita
// parent_id) — nunca abrir uno nuevo por su cuenta.
app.post("/api/comments", requireAnyRole, asyncRoute(async (req, res) => {
  const { reading_id, parent_id, text } = req.body;
  if (req.session.role === "doctor") {
    res.json(await callSheetsApi(null, {
      action: "add_comment", patient_id: req.session.patientId, reading_id, parent_id, text,
      author_role: "doctor", author_id: req.session.doctorId,
    }));
    return;
  }
  if (!parent_id) {
    return res.status(400).json({ ok: false, error: "solo puedes responder a un comentario existente" });
  }
  res.json(await callSheetsApi(null, {
    action: "add_comment", patient_id: req.session.patientId, reading_id, parent_id, text,
    author_role: "patient", author_id: req.session.patientId,
  }));
}));

app.get("/api/reactions", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_reactions", patient_id: req.session.patientId }));
}));
// Nombre para el mensaje de la notificación de reacción (v27). Se resuelve
// aquí, en el servidor, a partir de la sesión — nunca se confía en un
// nombre mandado por el cliente.
async function resolveReactorName_(req) {
  try {
    if (req.session.role === "doctor") {
      const result = await callSheetsApi({ action: "get_doctor_by_id", id: req.session.doctorId });
      const d = result.ok ? result.data : null;
      if (!d) return "";
      return `${d.title || "Dr(a)."} ${d.name || ""}`.trim();
    }
    const result = await callSheetsApi({ action: "get_patient_by_id", id: req.session.patientId });
    return result.ok && result.data ? (result.data.name || "") : "";
  } catch (err) {
    return ""; // si falla, Code.gs cae a un nombre genérico — no debe tumbar la reacción
  }
}
// Un click togglea: misma reacción la quita, otra la cambia, ninguna la
// agrega. reactor_role/reactor_id se toman siempre de la sesión, nunca del
// body, para que nadie pueda reaccionar a nombre de alguien más.
app.post("/api/reactions/toggle", requireAnyRole, asyncRoute(async (req, res) => {
  const { target_type, target_id, reaction } = req.body;
  const reactorRole = req.session.role; // "patient" o "doctor"
  const reactorId = req.session.role === "patient" ? req.session.patientId : req.session.doctorId;
  const reactorName = await resolveReactorName_(req);
  res.json(await callSheetsApi(null, {
    action: "toggle_reaction", patient_id: req.session.patientId, target_type, target_id, reaction,
    reactor_role: reactorRole, reactor_id: reactorId, reactor_name: reactorName,
  }));
}));

app.get("/api/notifications", requireAnyRole, asyncRoute(async (req, res) => {
  const recipientType = req.session.role;
  const recipientId = req.session.role === "patient" ? req.session.patientId : req.session.doctorId;
  res.json(await callSheetsApi({ action: "list_notifications", recipient_type: recipientType, recipient_id: recipientId }));
}));
app.post("/api/notifications/read", requireAnyRole, asyncRoute(async (req, res) => {
  const recipientType = req.session.role;
  const recipientId = req.session.role === "patient" ? req.session.patientId : req.session.doctorId;
  res.json(await callSheetsApi(null, { action: "mark_notifications_read", recipient_type: recipientType, recipient_id: recipientId, ids: req.body.ids }));
}));

app.post("/api/account/doctor-title", requireRole("doctor"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "update_doctor_title", id: req.session.doctorId, title: req.body.title }));
}));

// ---- Catálogo de médicos (v30.3) ----
// El médico actualiza su propia ficha del catálogo. La lista en sí es
// pública a propósito (sin requireAnyRole/requireRole): tiene que verse
// igual en index.html, doctor.html y también en familia.html, que no tiene
// sesión de ningún tipo.
app.post("/api/account/doctor-catalog", requireRole("doctor"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, {
    action: "update_doctor_catalog_profile", id: req.session.doctorId,
    catalog_opt_in: req.body.catalog_opt_in, specialty: req.body.specialty,
    catalog_bio: req.body.catalog_bio, catalog_contact: req.body.catalog_contact, catalog_city: req.body.catalog_city,
    // v30.9: perfil ampliado ("carta de presentación") — consultation_mode es
    // obligatorio para publicarse, el resto es opcional (ver validación en
    // update_doctor_catalog_profile).
    consultation_mode: req.body.consultation_mode, subspecialty: req.body.subspecialty,
    years_experience: req.body.years_experience, education: req.body.education,
    professional_activities: req.body.professional_activities, distinctions: req.body.distinctions,
    associations: req.body.associations, languages: req.body.languages, insurances: req.body.insurances,
    website: req.body.website, schedule_note: req.body.schedule_note,
  }));
}));
app.get("/api/doctor-catalog", asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_doctor_catalog" }));
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
  const { last_lab_date, cholesterol, triglycerides, med_brand, med_mg, gender, weight, waist, height } = req.body;
  res.json(await callSheetsApi(null, {
    action: "update_patient_params",
    id: req.session.patientId,
    last_lab_date, cholesterol, triglycerides, med_brand, med_mg, gender, weight, waist, height,
  }));
}));

app.post("/api/account/invite", requireRole("patient"), asyncRoute(async (req, res) => {
  const result = await callSheetsApi(null, {
    action: "generate_doctor_invite", patient_id: req.session.patientId,
    email: req.body && req.body.email ? req.body.email : undefined,
    origin: requestOrigin_(req),
  });
  res.json(result);
}));

app.get("/api/account/doctors", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_doctors", patient_id: req.session.patientId }));
}));
app.get("/api/account/invites", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "list_doctor_invites", patient_id: req.session.patientId }));
}));
app.post("/api/account/invites/:id/cancel", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "cancel_doctor_invite", id: req.params.id, patient_id: req.session.patientId }));
}));
app.post("/api/account/doctors/:id/remove", requireRole("patient"), asyncRoute(async (req, res) => {
  res.json(await callSheetsApi(null, { action: "remove_doctor", id: req.params.id, patient_id: req.session.patientId }));
}));

app.post("/api/account/share-token/regenerate", requireRole("patient"), asyncRoute(async (req, res) => {
  const result = await callSheetsApi(null, { action: "regenerate_share_token", patient_id: req.session.patientId });
  res.json(result);
}));

// ---- Respaldo/restauración (v28) ----
// Descarga un archivo .json con tus lecturas, comentarios, reacciones y
// parámetros físicos/de laboratorio, para poder restaurarlo tú mismo ante
// cualquier imprevisto. Nunca incluye tu correo/contraseña ni tus médicos
// vinculados (ver comentario en export_backup, db-postgres.js).
app.get("/api/account/backup", requireRole("patient"), asyncRoute(async (req, res) => {
  const result = await callSheetsApi({ action: "export_backup", patient_id: req.session.patientId });
  if (!result.ok) return res.status(400).json(result);
  const stamp = new Date().toISOString().slice(0, 10);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="respaldo-presion-${stamp}.json"`);
  res.send(JSON.stringify(result.data, null, 2));
}));

app.post("/api/account/restore", requireRole("patient"), asyncRoute(async (req, res) => {
  const result = await callSheetsApi(null, { action: "restore_backup", patient_id: req.session.patientId, backup: req.body });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
}));

// ---- Mensajes generales del administrador (v30) ----
// Cualquier paciente o médico con sesión puede ver los mensajes activos;
// no hay nada sensible aquí, es lo mismo para todos.
app.get("/api/broadcasts", requireAnyRole, asyncRoute(async (req, res) => {
  res.json(await callSheetsApi({ action: "get_active_broadcasts", audience: req.session.role }));
}));

// ---- Tickets de soporte (v30) ----
// Cada quien solo ve/escribe en sus propios tickets: account_type/account_id
// siempre salen de la sesión, nunca del cuerpo de la petición, y las rutas
// de un ticket puntual verifican que ese ticket sea suyo antes de dejar
// leer o escribir en él (el panel de administrador tiene sus propias rutas
// separadas para ver cualquier ticket).
function myAccountIdentity_(req) {
  return req.session.role === "doctor"
    ? { type: "doctor", id: req.session.doctorId }
    : { type: "patient", id: req.session.patientId };
}
app.get("/api/support/tickets", requireAnyRole, asyncRoute(async (req, res) => {
  const me = myAccountIdentity_(req);
  res.json(await callSheetsApi({ action: "list_my_tickets", account_type: me.type, account_id: me.id }));
}));
app.post("/api/support/tickets", requireAnyRole, asyncRoute(async (req, res) => {
  const me = myAccountIdentity_(req);
  const accountName = req.session.email || "";
  const result = await callSheetsApi(null, {
    action: "create_support_ticket", account_type: me.type, account_id: me.id, account_name: accountName,
    subject: req.body.subject, message: req.body.message,
  });
  res.json(result);
}));
app.get("/api/support/tickets/:id/messages", requireAnyRole, asyncRoute(async (req, res) => {
  const me = myAccountIdentity_(req);
  const result = await callSheetsApi({ action: "get_ticket_messages", ticket_id: req.params.id });
  if (!result.ok) return res.status(404).json(result);
  const ticket = result.data.ticket;
  if (ticket.account_type !== me.type || String(ticket.account_id) !== String(me.id)) {
    return res.status(404).json({ ok: false, error: "no encontrado" });
  }
  res.json(result);
}));
app.post("/api/support/tickets/:id/messages", requireAnyRole, asyncRoute(async (req, res) => {
  const me = myAccountIdentity_(req);
  const ticketResult = await callSheetsApi({ action: "get_ticket_messages", ticket_id: req.params.id });
  if (!ticketResult.ok) return res.status(404).json(ticketResult);
  const ticket = ticketResult.data.ticket;
  if (ticket.account_type !== me.type || String(ticket.account_id) !== String(me.id)) {
    return res.status(404).json({ ok: false, error: "no encontrado" });
  }
  const result = await callSheetsApi(null, { action: "add_ticket_message", ticket_id: req.params.id, author_role: me.type, text: req.body.text });
  res.json(result);
}));

// ---- Notificaciones push (Web Push, v29) — solo con backend Postgres ----
// El service worker se sirve desde la raíz (no desde /shared/) para que su
// alcance ("scope") cubra toda la app y no solo /shared/; así puede
// interceptar push/notificationclick sin importar en qué página estaba
// abierta cuando el usuario activó las notificaciones.
app.get("/sw.js", (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.sendFile(path.join(__dirname, "public", "shared", "sw.js"));
});
if (DB_BACKEND === "postgres") {
  const { pushEnabled, VAPID_PUBLIC_KEY } = require("./db-postgres");
  app.get("/api/push/vapid-public-key", requireAnyRole, (req, res) => {
    res.json({ ok: true, enabled: pushEnabled, publicKey: VAPID_PUBLIC_KEY });
  });
  app.post("/api/push/subscribe", requireAnyRole, asyncRoute(async (req, res) => {
    const recipientType = req.session.role;
    const recipientId = req.session.role === "patient" ? req.session.patientId : req.session.doctorId;
    const result = await callSheetsApi(null, { action: "save_push_subscription", recipient_type: recipientType, recipient_id: recipientId, subscription: req.body.subscription });
    res.json(result);
  }));
  app.post("/api/push/unsubscribe", requireAnyRole, asyncRoute(async (req, res) => {
    const result = await callSheetsApi(null, { action: "delete_push_subscription", endpoint: req.body.endpoint });
    res.json(result);
  }));
  // v30.1: diagnóstico bajo demanda. Manda un push de prueba a esta cuenta y
  // regresa el resultado exacto (si VAPID está configurado, cuántas
  // suscripciones hay guardadas, y si el envío falló, con qué código),
  // para no depender de revisar los logs de Render a ciegas.
  app.post("/api/push/test", requireAnyRole, asyncRoute(async (req, res) => {
    const recipientType = req.session.role;
    const recipientId = req.session.role === "patient" ? req.session.patientId : req.session.doctorId;
    const result = await callSheetsApi(null, { action: "test_push", recipient_type: recipientType, recipient_id: recipientId });
    res.json(result);
  }));

  // ---- Foto de perfil (v30) — solo con backend Postgres ----
  // Subir/borrar siempre usa la cuenta de la sesión (nunca un id que mande
  // el cliente), para que nadie pueda tocar la foto de otra cuenta. Servir
  // la imagen SÍ es una ruta pública (sin sesión): la ven el médico, la
  // familia y quien tenga el enlace de solo lectura, igual que ya pasa con
  // los demás datos de "solo lectura" de esta app.
  app.post("/api/account/avatar", requireAnyRole, asyncRoute(async (req, res) => {
    const accountType = req.session.role;
    const accountId = accountType === "patient" ? req.session.patientId : req.session.doctorId;
    const result = await callSheetsApi(null, { action: "upload_avatar", account_type: accountType, account_id: accountId, data_base64: req.body.data_base64, mime: req.body.mime });
    res.json(result);
  }));
  app.post("/api/account/avatar/remove", requireAnyRole, asyncRoute(async (req, res) => {
    const accountType = req.session.role;
    const accountId = accountType === "patient" ? req.session.patientId : req.session.doctorId;
    const result = await callSheetsApi(null, { action: "remove_avatar", account_type: accountType, account_id: accountId });
    res.json(result);
  }));
  app.get("/api/avatar/:type/:id", asyncRoute(async (req, res) => {
    const accountType = req.params.type === "doctor" ? "doctor" : "patient";
    const { getAvatarData } = require("./db-postgres");
    const avatar = await getAvatarData(accountType, req.params.id);
    if (!avatar) return res.status(404).end();
    res.set("Content-Type", avatar.mime);
    res.set("Cache-Control", "private, max-age=300");
    res.send(avatar.data);
  }));

  // ---- Foto de receta en Consultas (v30.12) — a diferencia del avatar, SÍ
  // exige sesión y filtra por patient_id, porque una receta médica es un
  // documento más sensible que una foto de perfil (ver /api/consultations
  // más arriba y /familia/:token/consultations/:id/photo más abajo, para el
  // enlace de solo lectura sin sesión). ----
  app.get("/api/consultations/:id/photo", requireAnyRole, asyncRoute(async (req, res) => {
    const { getConsultationReceta } = require("./db-postgres");
    const photo = await getConsultationReceta(req.session.patientId, req.params.id);
    if (!photo) return res.status(404).end();
    res.set("Content-Type", photo.mime);
    res.set("Cache-Control", "private, max-age=300");
    res.send(photo.data);
  }));

  // ---- Cuenta de administrador (v30) — se crea/actualiza sola al arrancar ----
  // No hay pantalla de registro para administradores: la única cuenta sale
  // de ADMIN_EMAIL/ADMIN_PASSWORD en las variables de entorno de Render. Si
  // faltan, el panel de administrador simplemente no tiene con qué iniciar
  // sesión (el resto de la app sigue funcionando igual). Cambiar
  // ADMIN_PASSWORD y reiniciar el servicio rota la contraseña sola.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    (async () => {
      try {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        await callSheetsApi(null, {
          action: "bootstrap_admin",
          name: process.env.ADMIN_NAME || "Alex",
          email: String(process.env.ADMIN_EMAIL).toLowerCase(),
          password_hash: hash,
        });
        console.log("[admin] cuenta de administrador lista (" + process.env.ADMIN_EMAIL + ")");
      } catch (err) {
        console.error("[admin] no se pudo preparar la cuenta de administrador:", err.message);
      }
    })();
  } else {
    console.warn("[admin] faltan ADMIN_EMAIL/ADMIN_PASSWORD en el entorno: el panel de administrador no tiene con qué iniciar sesión");
  }
}

app.listen(PORT, () => {
  console.log(`Reigning Blood Pressure App escuchando en http://localhost:${PORT}`);
});
