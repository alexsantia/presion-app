// Adaptador Postgres para Reigning Blood Pressure App (MVP2).
// v27
//
// Implementa exactamente las mismas acciones que apps-script/Code.gs
// (doGet/doPost), con la misma forma de entrada/salida, para que server.js
// pueda usar esta función en vez de callSheetsApi sin tocar ninguna ruta.
// Ver server.js: callSheetsApi delega aquí cuando DB_BACKEND=postgres.
//
// Cuidado con las columnas de fecha/hora: node-postgres por default convierte
// las columnas DATE/TIME a objetos Date de JavaScript en UTC, lo cual puede
// recorrer un día completo al formatear en la zona horaria local (la misma
// familia de bug que causó la corrupción de datos de la versión 26, aunque
// esa vez el origen fue un Apps Script desactualizado). Para evitarlo, TODAS
// las columnas date/time se piden ya convertidas a texto con to_char()
// directamente en el SQL, nunca se dejan como tipos nativos de Postgres.

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const webpush = require("web-push");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

// v29: notificaciones push (Web Push) para que lleguen avisos del sistema
// aunque la app esté cerrada, cuando está anclada a la pantalla de inicio
// (PWA). Requiere un par de llaves VAPID — se generan UNA sola vez para
// todo el proyecto (no por usuario) con `npx web-push generate-vapid-keys`
// y se guardan como variables de entorno en Render; si faltan, el envío de
// push simplemente se omite (todo lo demás de la app sigue funcionando
// exactamente igual, como si esta función no existiera).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:alejandro@empresso.mx";
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("[push] VAPID configurado, envío de push activado");
} else {
  console.warn("[push] faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY en el entorno: el envío de push queda desactivado");
}

// v30: correo real para la invitación de médico (Resend). Se usa fetch()
// directo a la API de Resend en vez de instalar su SDK, para no sumar una
// dependencia solo por esto. Si falta RESEND_API_KEY, la invitación se sigue
// generando igual (el enlace también se regresa en la respuesta, como
// siempre) — el correo es un extra, no un requisito para invitar.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Reigning Blood Pressure App <onboarding@resend.dev>";
const resendEnabled = !!RESEND_API_KEY;
if (resendEnabled) {
  console.log("[email] RESEND_API_KEY configurado, envío de correo activado");
} else {
  console.warn("[email] falta RESEND_API_KEY en el entorno: las invitaciones de médico no mandan correo, solo el enlace");
}
async function sendDoctorInviteEmail_(toEmail, patientName, inviteUrl) {
  if (!resendEnabled) return { sent: false, reason: "resend no configurado" };
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [toEmail],
        subject: `${patientName} te invitó a Reigning Blood Pressure App`,
        html: `<p>Hola,</p>
<p><strong>${patientName}</strong> te invitó a ver su presión arterial en modo de solo lectura en Reigning Blood Pressure App.</p>
<p><a href="${inviteUrl}" style="display:inline-block;background:#4F7A6F;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Crear mi cuenta de médico</a></p>
<p>O copia y pega este enlace en tu navegador:<br>${inviteUrl}</p>
<p style="color:#888;font-size:12px;">Este enlace es de un solo uso. Si no esperabas esta invitación, puedes ignorar este correo.</p>`,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[email] Resend respondió con error:", resp.status, errText);
      return { sent: false, reason: "el servicio de correo respondió con error" };
    }
    console.log("[email] invitación de médico enviada a", toEmail);
    return { sent: true };
  } catch (err) {
    console.error("[email] falló el envío de la invitación:", err.message);
    return { sent: false, reason: "no se pudo contactar el servicio de correo" };
  }
}

// v28: avisador de cambios en tiempo real. server.js se suscribe a esto para
// reenviar un aviso (vía Server-Sent Events) a las tres interfaces
// (paciente/médico/familia) sin que nadie tenga que refrescar la pantalla.
// Nunca se emite al quitar una reacción (mismo criterio que las
// notificaciones: quitar algo no avisa a nadie), y nunca lleva datos
// sensibles: solo "algo cambió para este paciente, ve a repreguntar".
const events = new EventEmitter();
function emitChange(patientId, kind) {
  if (!patientId) return;
  events.emit("change", String(patientId), kind);
}

// Aplica db/schema.sql automáticamente al arrancar (CREATE TABLE IF NOT
// EXISTS, seguro de correr una y otra vez), para que crear la instancia de
// Postgres en Render sea el único paso manual: nadie tiene que copiar/pegar
// SQL a mano ni abrir una terminal de psql. Se corre una sola vez por
// arranque del proceso (schemaReady cachea la promesa).
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
      // v29 fix: antes se partía primero por ";\n" y luego se descartaba
      // cualquier trozo que EMPEZARA con "--", pero un trozo con un
      // comentario de varias líneas seguido de un CREATE real (como el de
      // push_subscriptions) empieza con "--" igual, así que el CREATE de
      // adentro se perdía completo y en silencio (el índice que lo usa
      // fallaba después con "relation ... does not exist"). Ahora se quitan
      // las líneas que son solo comentario ANTES de partir en sentencias,
      // para que nunca se descarte SQL real por venir después de un
      // comentario en el mismo trozo.
      const sqlWithoutComments = sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
      const statements = sqlWithoutComments.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        await pool.query(stmt);
      }
      console.log("Postgres: esquema verificado/creado (db/schema.sql)");
    })().catch(err => {
      console.error("Postgres: no se pudo aplicar el esquema automáticamente:", err.message);
      schemaReady = null; // permite reintentar en la siguiente llamada en vez de quedar roto para siempre
      throw err;
    });
  }
  return schemaReady;
}
// Se dispara de inmediato al cargar este módulo (cuando arranca el proceso
// de Node en Render), no solo cuando llega la primera petición. Así, con
// solo desplegar el servicio ya queda lista la base de datos, sin depender
// de que alguien visite la página primero (importante para el script de
// migración, que se corre por separado y espera que las tablas ya existan).
ensureSchema().catch(() => {});

function uuid() {
  return require("crypto").randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}
function hasValue(v) {
  return v != null && v !== "";
}
function num(v) {
  return v === null || v === undefined || v === "" ? null : Number(v);
}

const REACTION_EMOJI = { like: "👍", love: "❤️", haha: "😆", wow: "😮", sad: "😢", angry: "😡" };
const REACTION_TYPES = ["like", "love", "haha", "wow", "sad", "angry"];
const MAX_DOCTORS_PER_PATIENT = 5;
const DEFAULT_DOCTOR_TITLE = "Dr(a).";
const VALID_DOCTOR_TITLES = ["Dr.", "Dra.", "Dr(a)."];
const RESET_TOKEN_TTL_MINUTES = 30;
// v30: foto de perfil. El cliente ya la redimensiona/comprime antes de subir
// (ver wireAvatarUpload en common.js), así que 800 KB es un tope generoso
// pensado para atrapar errores, no el tamaño esperado normal.
const AVATAR_MAX_BYTES = 800 * 1024;
const AVATAR_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
// v30.12: foto de la receta en Consultas. Tope más generoso que el avatar
// (1.5 MB) porque una receta necesita más resolución para leerse bien.
const RECETA_MAX_BYTES = 1.5 * 1024 * 1024;
const RECETA_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

// Lee la foto de perfil (bytes crudos) de un paciente o médico, para que
// server.js la sirva directo por HTTP sin pasar por JSON/base64. Se exporta
// aparte de callPostgresApi porque server.js necesita el Buffer y el mime
// tal cual, no envueltos en la respuesta {ok, data} de siempre.
async function getAvatarData(accountType, id) {
  const table = accountType === "doctor" ? "medicos" : "pacientes";
  const { rows } = await pool.query(`SELECT avatar_data, avatar_mime FROM ${table} WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row || !row.avatar_data) return null;
  return { data: row.avatar_data, mime: row.avatar_mime || "image/jpeg" };
}
const BACKUP_VERSION = 1;

function classifyReading(sys, dia) {
  if (sys >= 180 || dia >= 120) return { label: "Crisis hipertensiva", key: "crisis" };
  if (sys >= 140 || dia >= 90) return { label: "Hipertensión etapa 2", key: "etapa2" };
  if (sys >= 130 || dia >= 80) return { label: "Hipertensión etapa 1", key: "etapa1" };
  if (sys >= 120 && dia < 80) return { label: "Elevada", key: "elevada" };
  return { label: "Normal", key: "normal" };
}

// ---- Lecturas ----
function readingRowToObject(row) {
  return {
    id: row.id,
    patient_id: row.patient_id,
    date: row.date || "",
    time: row.time || "",
    sys: num(row.sys),
    dia: num(row.dia),
    hr: num(row.hr),
    weight: num(row.weight),
    obs: row.obs || "",
    flag: row.flag || "",
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : "",
    medicated: !!row.medicated,
  };
}
async function listReadings(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, to_char(date, 'YYYY-MM-DD') AS date, to_char(time, 'HH24:MI') AS time,
            sys, dia, hr, weight, obs, flag, created_at, updated_at, medicated
     FROM lecturas WHERE patient_id = $1 ORDER BY date, time`,
    [patientId]
  );
  return rows.map(readingRowToObject);
}

// ---- Malos hábitos (v30.1) ----
const HABIT_TYPE_KEYS = ["alimentacion", "alcohol", "tabaco", "desvelo", "sal", "sedentarismo", "otro"];
async function listHabits(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha, valor_numero, valor_texto, created_at
     FROM malos_habitos WHERE patient_id = $1 ORDER BY fecha DESC, created_at DESC`,
    [patientId]
  );
  return rows.map(r => ({
    id: r.id, patient_id: r.patient_id, tipo: r.tipo, fecha: r.fecha,
    valor_numero: r.valor_numero != null ? Number(r.valor_numero) : null,
    valor_texto: r.valor_texto || "",
    created_at: new Date(r.created_at).toISOString(),
  }));
}

// ---- Síntomas diarios (v30.4; catálogo con escala propia por síntoma en
// v30.12: "tipo" es la llave del catálogo, "severidad" es la intensidad
// subjetiva 1-10 y "temperatura" es el grado real en °C para Fiebre — ver
// SYMPTOM_CATALOG en common.js). ----
async function listSymptoms(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, sintoma, tipo, severidad, temperatura,
            to_char(fecha, 'YYYY-MM-DD') AS fecha, to_char(hora, 'HH24:MI') AS hora, descripcion, created_at
     FROM sintomas WHERE patient_id = $1 ORDER BY fecha DESC, hora DESC NULLS LAST, created_at DESC`,
    [patientId]
  );
  return rows.map(r => ({
    id: r.id, patient_id: r.patient_id, sintoma: r.sintoma, tipo: r.tipo || null,
    severidad: r.severidad != null ? Number(r.severidad) : null,
    temperatura: r.temperatura != null ? Number(r.temperatura) : null,
    fecha: r.fecha, hora: r.hora || "",
    descripcion: r.descripcion || "", created_at: new Date(r.created_at).toISOString(),
  }));
}
// ---- Historial de cintura/colesterol/triglicéridos (v30.6) ----
async function listLabHistory(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, to_char(fecha, 'YYYY-MM-DD') AS fecha, waist, cholesterol, triglycerides, created_at
     FROM lab_history WHERE patient_id = $1 ORDER BY fecha ASC, created_at ASC`,
    [patientId]
  );
  return rows.map(r => ({
    id: r.id, patient_id: r.patient_id, fecha: r.fecha,
    waist: r.waist != null ? Number(r.waist) : null,
    cholesterol: r.cholesterol != null ? Number(r.cholesterol) : null,
    triglycerides: r.triglycerides != null ? Number(r.triglycerides) : null,
  }));
}

// ---- Medicamentos (v30.8) ----
// El calendario semanal NO se captura a mano: se calcula a partir de la
// frecuencia (cada cuántas horas) y la hora de la primera toma, y se repite
// todos los días. Por ejemplo, cada 8 horas desde las 08:00 da 08:00, 16:00
// y 00:00 — el mismo patrón todos los días de la semana.
function computeDoseTimes_(frequencyHours, firstDoseTime) {
  const freq = Number(frequencyHours);
  if (!freq || freq <= 0) return [];
  const parts = String(firstDoseTime || "00:00").split(":").map(Number);
  const startMin = (parts[0] || 0) * 60 + (parts[1] || 0);
  const count = Math.max(1, Math.min(24, Math.round(24 / freq)));
  const times = [];
  for (let i = 0; i < count; i++) {
    const totalMin = Math.round(startMin + i * freq * 60) % (24 * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    times.push(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
  }
  // Se ordenan por hora del día (00:00 primero), no en el orden en que se
  // generaron a partir de la primera toma: cuando la frecuencia hace que una
  // toma "de vuelta" pase medianoche (ej. cada 8h desde las 08:00 da
  // 08:00, 16:00, 00:00), ese 00:00 es una hora del día como cualquier otra
  // y tiene que quedar ANTES de 08:00 al comparar contra la hora actual;
  // dejarlo al final (como sale de la generación) rompe la comparación
  // secuencial que usa el escaneo de recordatorios para saber cuál es "la
  // siguiente toma".
  times.sort((a, b) => timeStrToMinutes_(a) - timeStrToMinutes_(b));
  return times;
}
function timeStrToMinutes_(t) {
  const parts = String(t).split(":").map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}
// v30.11: bug corregido — computeDoseTimes_ arma un patrón que se repite
// IDÉNTICO todos los días (incluye horas que, vistas desde la primera toma,
// son "de un ciclo anterior" que ya pasó, ej. cada 8h desde las 21:00 da
// 21:00, 05:00 y 13:00 — 05:00 y 13:00 son, en realidad, las últimas dos
// tomas del día ANTERIOR al patrón, que ese mismo día del calendario ya
// pasaron). Aplicado tal cual al día en que se CREA el medicamento, esas
// horas "fantasma" ya pasadas disparaban un recordatorio inmediato aunque el
// medicamento nunca existió a esa hora — el bug exacto que reportó el
// usuario ("puse un medicamento para las 21:00 y ya sonó antes"). Esta
// función arma SOLO las tomas reales del primer día: desde la primera toma
// hacia adelante, sin dar la vuelta a la medianoche.
function computeFirstDayDoseTimes_(frequencyHours, firstDoseTime) {
  const freq = Number(frequencyHours);
  if (!freq || freq <= 0) return [];
  const parts = String(firstDoseTime || "00:00").split(":").map(Number);
  const startMin = (parts[0] || 0) * 60 + (parts[1] || 0);
  const times = [];
  let totalMin = startMin;
  while (totalMin < 24 * 60) {
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    times.push(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
    totalMin += Math.round(freq * 60);
  }
  return times;
}
function addDaysToDateStr_(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetweenDateStrs_(fromStr, toStr) {
  const a = new Date(fromStr + "T00:00:00Z");
  const b = new Date(toStr + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}
// v30.11: ¿toca este medicamento en esta fecha? Respeta start_date/end_date
// (fuera de ese rango, nunca toca) y, para frecuencia por días/semanas, solo
// los días exactos del intervalo contados desde start_date (ej. cada 3 días
// desde el 1: toca el 1, 4, 7, 10...). Frecuencia por horas sigue tocando
// todos los días dentro del rango (varias veces al día).
function isMedicationDueOnDate_(med, dateStr) {
  const startDate = med.start_date || dateStr;
  if (dateStr < startDate) return false;
  if (med.end_date && dateStr > med.end_date) return false;
  const unit = med.frequency_unit || "hours";
  if (unit === "hours") return true;
  const value = Number(med.frequency_value != null ? med.frequency_value : med.frequency_hours);
  const intervalDays = unit === "weeks" ? value * 7 : value;
  if (!intervalDays || intervalDays < 1) return true;
  const diffDays = daysBetweenDateStrs_(startDate, dateStr);
  return diffDays >= 0 && diffDays % intervalDays === 0;
}
// v30.11: horas de toma reales para una fecha concreta — combina el rango de
// vigencia del tratamiento, la frecuencia (horas/días/semanas), y la
// exclusión de tomas "fantasma" del primer día para frecuencia por horas.
function computeDoseTimesForDate_(med, dateStr) {
  if (!isMedicationDueOnDate_(med, dateStr)) return [];
  const unit = med.frequency_unit || "hours";
  if (unit !== "hours") return [String(med.first_dose_time).slice(0, 5)];
  const freqHours = Number(med.frequency_value != null ? med.frequency_value : med.frequency_hours);
  const startDate = med.start_date || dateStr;
  if (dateStr === startDate) return computeFirstDayDoseTimes_(freqHours, med.first_dose_time);
  return computeDoseTimes_(freqHours, med.first_dose_time);
}
// La app no le pide zona horaria a cada paciente (es una app familiar, de un
// solo huso horario); se fija a America/Mexico_City para que "hoy" y "ahora"
// signifiquen lo mismo en el escaneo de recordatorios (que corre en el
// servidor, en UTC) que en la hora de pared del paciente.
const APP_TIMEZONE = "America/Mexico_City";
function nowInAppTz_() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  return { dateStr, minutesOfDay: hour * 60 + Number(map.minute) };
}
function medicationRowToObject_(row) {
  const unit = row.frequency_unit || "hours";
  const value = row.frequency_value != null ? Number(row.frequency_value) : (row.frequency_hours != null ? Number(row.frequency_hours) : null);
  return {
    id: row.id,
    patient_id: row.patient_id,
    name: row.name,
    active_substance: row.active_substance || "",
    mg: row.mg != null ? Number(row.mg) : null,
    dose_text: row.dose_text || "",
    frequency_hours: row.frequency_hours != null ? Number(row.frequency_hours) : null,
    frequency_unit: unit,
    frequency_value: value,
    first_dose_time: row.first_dose_time || "",
    start_date: row.start_date || "",
    end_date: row.end_date || null,
    active: !!row.active,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
    // "times" (patrón repetido diario) solo tiene sentido como vista previa
    // ilustrativa para frecuencia por horas; para días/semanas el calendario
    // semanal no aplica (no es diario), así que se deja vacío a propósito —
    // el frontend muestra ahí un resumen de texto en su lugar.
    times: unit === "hours" ? computeDoseTimes_(value, row.first_dose_time) : [],
  };
}
async function listMedications(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, name, active_substance, mg, dose_text, frequency_hours,
            frequency_unit, frequency_value,
            to_char(first_dose_time, 'HH24:MI') AS first_dose_time,
            to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
            active, created_at
     FROM medicamentos WHERE patient_id = $1 AND active = true ORDER BY created_at ASC`,
    [patientId]
  );
  return rows.map(medicationRowToObject_);
}
// Dosis del día para el panel de "tomas de hoy" en la vista de paciente. Se
// calculan las horas de cada medicamento y se cruzan con lo que ya exista en
// medicamento_dosis para hoy; si aún no hay fila (porque ni el escaneo de
// recordatorios ni el propio paciente la han tocado), se regresa como no
// tomada, sin necesidad de crearla hasta que alguien la marque.
async function listTodayDoses(patientId) {
  const meds = await listMedications(patientId);
  if (!meds.length) return [];
  const { dateStr } = nowInAppTz_();
  const { rows } = await pool.query(
    `SELECT medication_id, to_char(dose_time, 'HH24:MI') AS dose_time, taken, taken_at
     FROM medicamento_dosis WHERE patient_id = $1 AND dose_date = $2`,
    [patientId, dateStr]
  );
  const byKey = new Map(rows.map(r => [`${r.medication_id}_${r.dose_time}`, r]));
  const out = [];
  for (const med of meds) {
    // v30.11: las horas de "hoy" ya no salen del patrón repetido genérico
    // (med.times) — se recalculan para la fecha exacta de hoy, respetando
    // start_date/end_date y excluyendo tomas fantasma si hoy es el primer día.
    const todayTimes = computeDoseTimesForDate_(med, dateStr);
    for (const time of todayTimes) {
      const existing = byKey.get(`${med.id}_${time}`);
      out.push({
        medication_id: med.id, medication_name: med.name, dose_text: med.dose_text, mg: med.mg,
        dose_date: dateStr, dose_time: time,
        taken: existing ? !!existing.taken : false,
        taken_at: existing && existing.taken_at ? new Date(existing.taken_at).toISOString() : "",
      });
    }
  }
  return out;
}
// El paciente puede marcar o desmarcar una toma de hoy; se resuelve la fecha
// del lado del servidor (nunca a partir de lo que mande el cliente) para que
// siempre coincida con lo que el escaneo de recordatorios considera "hoy".
async function setDoseTaken(patientId, medicationId, doseTime, taken) {
  const { dateStr } = nowInAppTz_();
  const id = uuid();
  await pool.query(
    `INSERT INTO medicamento_dosis (id, medication_id, patient_id, dose_date, dose_time, taken, taken_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (medication_id, dose_date, dose_time) DO UPDATE SET taken = $6, taken_at = $7`,
    [id, medicationId, patientId, dateStr, doseTime, !!taken, taken ? nowIso() : null, nowIso()]
  );
}
// Escaneo periódico (ver setInterval en server.js): por cada medicamento
// activo, calcula las horas del día que ya se cumplieron y, si nadie las ha
// marcado como tomadas, manda un recordatorio push — la primera vez en
// cuanto se cumple la hora, y luego cada 30 minutos, pero solo hasta que
// llegue la hora de la siguiente toma programada (después de eso ya no tiene
// caso seguir insistiendo por una que quedó atrás).
const MEDICATION_REMINDER_INTERVAL_MIN = 30;
async function scanMedicationReminders() {
  // v30.11: columnas explícitas con to_char (en vez de SELECT *) para que
  // start_date/end_date lleguen como texto 'YYYY-MM-DD' — igual que en
  // listMedications — y no como objetos Date (que rompería las comparaciones
  // de texto en isMedicationDueOnDate_/computeDoseTimesForDate_).
  const { rows: meds } = await pool.query(
    `SELECT id, patient_id, name, mg, dose_text, frequency_hours, frequency_unit, frequency_value,
            to_char(first_dose_time, 'HH24:MI') AS first_dose_time,
            to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
     FROM medicamentos WHERE active = true`
  );
  if (!meds.length) return;
  const { dateStr, minutesOfDay } = nowInAppTz_();
  for (const med of meds) {
    const times = computeDoseTimesForDate_(med, dateStr);
    if (!times.length) continue;
    // v30.11: el "cutoff" (cuándo se deja de insistir porque ya llegó la
    // siguiente toma) ahora se calcula sumando la frecuencia directamente en
    // minutos, en vez de mirar la SIGUIENTE entrada del arreglo — el arreglo
    // del primer día (computeFirstDayDoseTimes_) puede tener menos tomas que
    // el patrón normal, así que "la siguiente entrada" ya no es un dato
    // confiable de cuándo es la próxima toma real. Para días/semanas solo hay
    // una toma por día que toca, así que el cutoff es simplemente el resto
    // del día (nunca se corta antes de que acabe hoy).
    const unit = med.frequency_unit || "hours";
    const freqMinutes = unit === "hours"
      ? Math.round(Number(med.frequency_value != null ? med.frequency_value : med.frequency_hours) * 60)
      : 24 * 60 + 1;
    for (let i = 0; i < times.length; i++) {
      const doseMin = timeStrToMinutes_(times[i]);
      if (minutesOfDay < doseMin) continue; // todavía no toca
      const cutoffMin = doseMin + (freqMinutes || 24 * 60 + 1);
      if (minutesOfDay >= cutoffMin) continue; // ya se pasó a la siguiente toma
      const newId = uuid();
      await pool.query(
        `INSERT INTO medicamento_dosis (id, medication_id, patient_id, dose_date, dose_time, taken, created_at)
         VALUES ($1,$2,$3,$4,$5,false,$6)
         ON CONFLICT (medication_id, dose_date, dose_time) DO NOTHING`,
        [newId, med.id, med.patient_id, dateStr, times[i], nowIso()]
      );
      const { rows: doseRows } = await pool.query(
        `SELECT id, taken, last_reminder_at FROM medicamento_dosis WHERE medication_id = $1 AND dose_date = $2 AND dose_time = $3`,
        [med.id, dateStr, times[i]]
      );
      const dose = doseRows[0];
      if (!dose || dose.taken) continue;
      const lastReminder = dose.last_reminder_at ? new Date(dose.last_reminder_at).getTime() : null;
      const dueForReminder = !lastReminder || (Date.now() - lastReminder) >= MEDICATION_REMINDER_INTERVAL_MIN * 60 * 1000;
      if (!dueForReminder) continue;
      const label = med.dose_text ? `${med.dose_text} de ${med.name}` : med.name;
      await createNotification("patient", med.patient_id, "medication_reminder",
        `Es hora de tomar ${label}${med.mg ? ` (${med.mg} mg)` : ""}.`, med.id);
      await pool.query(`UPDATE medicamento_dosis SET last_reminder_at = $1 WHERE id = $2`, [nowIso(), dose.id]);
      emitChange(med.patient_id, "medication");
    }
  }
}

// ---- Ejercicio (v30.10): captura manual, calorías calculadas al guardar ----
// El usuario pidió "tomar las actividades de Apple Watch", pero una PWA web
// no tiene ninguna API para leer HealthKit/Apple Watch — eso solo lo puede
// hacer una app nativa con ese permiso. Se optó (decisión del usuario) por
// captura manual: el paciente elige el tipo de ejercicio y cuánto duró, y la
// app calcula las calorías.
// MET = "equivalente metabólico" de cada actividad (tabla estándar del
// Compendium of Physical Activities). Valores aproximados y moderados.
const EXERCISE_MET_TABLE = {
  caminata_ligera: { label: "Caminata ligera", met: 3.0 },
  caminata_rapida: { label: "Caminata rápida", met: 4.3 },
  trote: { label: "Trote / correr suave", met: 7.0 },
  correr_rapido: { label: "Correr rápido", met: 11.0 },
  ciclismo: { label: "Ciclismo", met: 6.8 },
  natacion: { label: "Natación", met: 6.0 },
  yoga: { label: "Yoga", met: 3.0 },
  pesas: { label: "Pesas / musculación", met: 5.0 },
  baile: { label: "Baile", met: 4.8 },
  futbol: { label: "Fútbol", met: 7.0 },
  basquetbol: { label: "Básquetbol", met: 6.5 },
  eliptica: { label: "Elíptica", met: 5.0 },
  escaleras: { label: "Subir escaleras", met: 8.0 },
  otro: { label: "Otro", met: 4.0 },
};
function ageFromBirthdate_(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate);
  if (isNaN(b.getTime())) return null;
  const { dateStr } = nowInAppTz_();
  const today = new Date(dateStr);
  let age = today.getFullYear() - b.getFullYear();
  const hasHadBirthdayThisYear = (today.getMonth() > b.getMonth())
    || (today.getMonth() === b.getMonth() && today.getDate() >= b.getDate());
  if (!hasHadBirthdayThisYear) age--;
  return age >= 0 ? age : null;
}
// Calorías = MET × (BMR/24) × horas de duración. Se usa la tasa metabólica
// basal (Mifflin-St Jeor, que sí toma en cuenta peso Y estatura, además de
// edad y género) en vez del atajo más simple de "MET × peso" que ignoran la
// estatura — así el campo de estatura en Parámetros de verdad se usa aquí.
// Si falta peso, estatura o edad no se puede calcular nada preciso y se
// regresa null (se guarda el ejercicio de todas formas, solo sin calorías).
function calcExerciseCalories_(metKey, durationMin, weightKg, heightCm, birthdate, gender) {
  const met = (EXERCISE_MET_TABLE[metKey] || EXERCISE_MET_TABLE.otro).met;
  const age = ageFromBirthdate_(birthdate);
  if (!weightKg || !heightCm || age == null) return null;
  const genderOffset = gender === "masculino" ? 5 : gender === "femenino" ? -161 : -78; // -78: punto medio, género sin especificar
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + genderOffset;
  if (bmr <= 0) return null;
  const hours = durationMin / 60;
  return Math.round(met * (bmr / 24) * hours);
}
function exerciseRowToObject_(row) {
  return {
    id: row.id,
    patient_id: row.patient_id,
    tipo: row.tipo,
    tipo_label: (EXERCISE_MET_TABLE[row.tipo] || EXERCISE_MET_TABLE.otro).label,
    duracion_min: row.duracion_min != null ? Number(row.duracion_min) : null,
    fecha: row.fecha || "",
    hora: row.hora || "",
    calorias: row.calorias != null ? Number(row.calorias) : null,
    notas: row.notas || "",
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
  };
}
async function listExercises(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, tipo, duracion_min, to_char(fecha, 'YYYY-MM-DD') AS fecha,
            to_char(hora, 'HH24:MI') AS hora, calorias, notas, created_at
     FROM ejercicios WHERE patient_id = $1 ORDER BY fecha DESC, created_at DESC`,
    [patientId]
  );
  return rows.map(exerciseRowToObject_);
}

// ---- Consultas médicas (v30.12) ----
// receta_data (bytea) deliberadamente fuera de este SELECT, igual que
// avatar_data: es pesado y casi nunca hace falta junto con el resto de la
// fila. "has_receta" le basta a la lista/tarjeta para saber si mostrar la
// miniatura o el botón de subir foto; la foto real se sirve aparte por HTTP
// (ver getConsultationReceta) para no ir envuelta en JSON/base64.
function consultationRowToObject_(row) {
  return {
    id: row.id,
    patient_id: row.patient_id,
    fecha: row.fecha || "",
    doctor_name: row.doctor_name || "",
    motivo: row.motivo || "",
    notas: row.notas || "",
    next_appointment_date: row.next_appointment_date || null,
    has_receta: !!row.receta_mime,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
  };
}
async function listConsultations(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, to_char(fecha, 'YYYY-MM-DD') AS fecha, doctor_name, motivo, notas,
            to_char(next_appointment_date, 'YYYY-MM-DD') AS next_appointment_date, receta_mime, created_at
     FROM consultas WHERE patient_id = $1 ORDER BY fecha DESC, created_at DESC`,
    [patientId]
  );
  return rows.map(consultationRowToObject_);
}
// Igual que getAvatarData: exportada aparte de callPostgresApi porque
// server.js necesita el Buffer y el mime tal cual para mandarlos por HTTP,
// no envueltos en {ok, data}. Se filtra también por patient_id aquí (no
// solo en la ruta) para que, aunque cambie la ruta, nunca se pueda leer la
// receta de un paciente ajeno con solo adivinar el id de la consulta.
async function getConsultationReceta(patientId, id) {
  const { rows } = await pool.query(
    `SELECT receta_data, receta_mime FROM consultas WHERE id = $1 AND patient_id = $2`,
    [id, patientId]
  );
  const row = rows[0];
  if (!row || !row.receta_data) return null;
  return { data: row.receta_data, mime: row.receta_mime || "image/jpeg" };
}

// ---- Apego a medicamentos (v30.11), para la gráfica en Estadísticas ----
// Por cada día desde el start_date más antiguo entre los medicamentos hasta
// hoy, cuenta cuántas tomas tocaban (computeDoseTimesForDate_, respeta
// start_date/end_date y frecuencia por horas/días/semanas) contra cuántas de
// esas se marcaron como tomadas en medicamento_dosis. Se limita a un año
// hacia atrás como máximo para no barrer un rango enorme si el paciente
// lleva mucho tiempo con medicamentos activos.
async function listMedicationAdherence(patientId) {
  const { rows: meds } = await pool.query(
    `SELECT id, frequency_hours, frequency_unit, frequency_value,
            to_char(first_dose_time, 'HH24:MI') AS first_dose_time,
            to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
     FROM medicamentos WHERE patient_id = $1 AND active = true`,
    [patientId]
  );
  if (!meds.length) return [];
  const { dateStr: today } = nowInAppTz_();
  let minStart = today;
  for (const m of meds) { if (m.start_date && m.start_date < minStart) minStart = m.start_date; }
  const oneYearAgo = addDaysToDateStr_(today, -365);
  if (minStart < oneYearAgo) minStart = oneYearAgo;

  const { rows: doseRows } = await pool.query(
    `SELECT medication_id, to_char(dose_date, 'YYYY-MM-DD') AS dose_date, to_char(dose_time, 'HH24:MI') AS dose_time, taken
     FROM medicamento_dosis WHERE patient_id = $1 AND taken = true`,
    [patientId]
  );
  const takenSet = new Set(doseRows.map(r => `${r.medication_id}_${r.dose_date}_${r.dose_time}`));

  const results = [];
  const totalDays = daysBetweenDateStrs_(minStart, today);
  for (let i = 0; i <= totalDays; i++) {
    const d = addDaysToDateStr_(minStart, i);
    let scheduled = 0, taken = 0;
    for (const m of meds) {
      const times = computeDoseTimesForDate_(m, d);
      scheduled += times.length;
      for (const t of times) if (takenSet.has(`${m.id}_${d}_${t}`)) taken++;
    }
    if (scheduled > 0) {
      results.push({ fecha: d, scheduled, taken, pct: Math.round((taken / scheduled) * 100) });
    }
  }
  return results;
}

// ---- Pacientes ----
function patientRaw(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, email: row.email, password_hash: row.password_hash,
    birthdate: row.birthdate || "", share_token: row.share_token,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : "",
    last_lab_date: row.last_lab_date || "",
    cholesterol: num(row.cholesterol), triglycerides: num(row.triglycerides),
    med_brand: row.med_brand || "", med_mg: num(row.med_mg),
    gender: row.gender || "", weight: num(row.weight), waist: num(row.waist), height: num(row.height),
    avatar_mime: row.avatar_mime || null, suspended: !!row.suspended,
  };
}
function patientPublic(row) {
  const p = patientRaw(row);
  if (!p) return null;
  const { password_hash, ...rest } = p;
  return rest;
}
// avatar_data (bytea) deliberadamente NO se incluye aquí: es pesado y casi
// ninguna acción lo necesita. Se sirve aparte por /api/avatar/:type/:id.
const PATIENT_SELECT = `SELECT id, name, email, password_hash, to_char(birthdate, 'YYYY-MM-DD') AS birthdate,
  share_token, created_at, updated_at, to_char(last_lab_date, 'YYYY-MM-DD') AS last_lab_date,
  cholesterol, triglycerides, med_brand, med_mg, gender, weight, waist, height, avatar_mime, suspended FROM pacientes`;

async function findPatientByEmail(email) {
  const { rows } = await pool.query(`${PATIENT_SELECT} WHERE email = $1`, [String(email || "").toLowerCase()]);
  return rows[0] || null;
}
async function findPatientById(id) {
  const { rows } = await pool.query(`${PATIENT_SELECT} WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function findPatientByShareToken(token) {
  const { rows } = await pool.query(`${PATIENT_SELECT} WHERE share_token = $1`, [token]);
  return rows[0] || null;
}

// ---- Medicos ----
function doctorPublic(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, email: row.email, patient_id: row.patient_id,
    title: row.title || DEFAULT_DOCTOR_TITLE, avatar_mime: row.avatar_mime || null, suspended: !!row.suspended,
    catalog_opt_in: !!row.catalog_opt_in, specialty: row.specialty || "",
    catalog_bio: row.catalog_bio || "", catalog_contact: row.catalog_contact || "", catalog_city: row.catalog_city || "",
    consultation_mode: row.consultation_mode || "presencial", subspecialty: row.subspecialty || "",
    years_experience: row.years_experience != null ? Number(row.years_experience) : null,
    education: row.education || "", professional_activities: row.professional_activities || "",
    distinctions: row.distinctions || "", associations: row.associations || "",
    languages: row.languages || "", insurances: row.insurances || "",
    website: row.website || "", schedule_note: row.schedule_note || "",
  };
}
function doctorDisplayName(d) {
  if (!d) return DEFAULT_DOCTOR_TITLE + " " + "(médico)";
  const title = d.title && VALID_DOCTOR_TITLES.indexOf(d.title) !== -1 ? d.title : DEFAULT_DOCTOR_TITLE;
  return title + " " + (d.name || "");
}
// avatar_data (bytea) deliberadamente fuera de este SELECT por lo mismo que
// en pacientes: pesado y casi nunca hace falta junto con el resto de la fila.
const DOCTOR_SELECT = `SELECT id, patient_id, name, email, password_hash, created_at, title, avatar_mime, suspended,
  catalog_opt_in, specialty, catalog_bio, catalog_contact, catalog_city,
  consultation_mode, subspecialty, years_experience, education, professional_activities,
  distinctions, associations, languages, insurances, website, schedule_note FROM medicos`;
async function findDoctorByEmail(email) {
  const { rows } = await pool.query(`${DOCTOR_SELECT} WHERE email = $1`, [String(email || "").toLowerCase()]);
  return rows[0] || null;
}
async function findDoctorById(id) {
  const { rows } = await pool.query(`${DOCTOR_SELECT} WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function listDoctorsForPatient(patientId) {
  const { rows } = await pool.query(
    `SELECT id, name, email, created_at, title, avatar_mime, suspended FROM medicos WHERE patient_id = $1 ORDER BY created_at`,
    [patientId]
  );
  return rows.map(r => ({ id: r.id, name: r.name, email: r.email, created_at: new Date(r.created_at).toISOString(), title: r.title || DEFAULT_DOCTOR_TITLE }));
}
async function countDoctorsForPatient(patientId) {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM medicos WHERE patient_id = $1`, [patientId]);
  return rows[0].c;
}
// Catálogo público de médicos (v30.3). Como cada cuenta de médico está
// ligada a un solo paciente, un médico real con varios pacientes en la app
// tendría una cuenta por cada uno; si publica el catálogo en más de una
// (mismo correo), aquí se deduplica dejando solo la más reciente, para que
// no aparezca repetido.
async function listDoctorCatalog() {
  const { rows } = await pool.query(
    `SELECT id, name, email, title, specialty, catalog_bio, catalog_contact, catalog_city, avatar_mime, created_at,
            consultation_mode, subspecialty, years_experience, education, professional_activities,
            distinctions, associations, languages, insurances, website, schedule_note
     FROM medicos WHERE catalog_opt_in = true ORDER BY created_at DESC`
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = String(r.email).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id, name: r.name, title: r.title || DEFAULT_DOCTOR_TITLE,
      specialty: r.specialty || "Otro", catalog_bio: r.catalog_bio || "",
      catalog_contact: r.catalog_contact || "", catalog_city: r.catalog_city || "",
      avatar_mime: r.avatar_mime || null,
      consultation_mode: r.consultation_mode || "presencial", subspecialty: r.subspecialty || "",
      years_experience: r.years_experience != null ? Number(r.years_experience) : null,
      education: r.education || "", professional_activities: r.professional_activities || "",
      distinctions: r.distinctions || "", associations: r.associations || "",
      languages: r.languages || "", insurances: r.insurances || "",
      website: r.website || "", schedule_note: r.schedule_note || "",
    });
  }
  out.sort((a, b) => a.specialty.localeCompare(b.specialty) || a.name.localeCompare(b.name));
  return out;
}

// ---- MedicoInvites ----
async function findInviteByToken(token) {
  const { rows } = await pool.query(`SELECT * FROM medico_invites WHERE token = $1`, [token]);
  return rows[0] || null;
}
async function findInviteById(id) {
  const { rows } = await pool.query(`SELECT * FROM medico_invites WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function listInvitesForPatient(patientId) {
  const { rows } = await pool.query(`SELECT id, token, email, created_at FROM medico_invites WHERE patient_id = $1 ORDER BY created_at`, [patientId]);
  return rows.map(r => ({ id: r.id, token: r.token, email: r.email || null, created_at: new Date(r.created_at).toISOString() }));
}
async function countPendingInvitesForPatient(patientId) {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM medico_invites WHERE patient_id = $1`, [patientId]);
  return rows[0].c;
}

// ---- Comentarios ----
async function listComments(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, reading_id, author, author_role, author_id, parent_id, text, created_at
     FROM comentarios WHERE patient_id = $1 ORDER BY created_at`,
    [patientId]
  );
  return rows.map(r => ({
    id: r.id, patient_id: r.patient_id, reading_id: r.reading_id || null,
    author: r.author || "", author_role: r.author_role || "doctor", author_id: r.author_id || "",
    parent_id: r.parent_id || null, text: r.text || "", created_at: new Date(r.created_at).toISOString(),
  }));
}
async function findCommentById(id) {
  const { rows } = await pool.query(`SELECT * FROM comentarios WHERE id = $1`, [id]);
  return rows[0] || null;
}

// ---- Notificaciones ----
async function countUnreadNotifications(recipientType, recipientId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS c FROM notificaciones WHERE recipient_type = $1 AND recipient_id = $2 AND read_at IS NULL`,
    [recipientType, recipientId]
  );
  return rows[0].c;
}

// ---- Push (Web Push, v29) ----
async function listPushSubscriptions(recipientType, recipientId) {
  const { rows } = await pool.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE recipient_type = $1 AND recipient_id = $2`,
    [recipientType, recipientId]
  );
  return rows;
}
async function savePushSubscription(recipientType, recipientId, sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return;
  await pool.query(
    `INSERT INTO push_subscriptions (id, recipient_type, recipient_id, endpoint, p256dh, auth, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (endpoint) DO UPDATE SET recipient_type = $2, recipient_id = $3, p256dh = $5, auth = $6`,
    [uuid(), recipientType, recipientId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, nowIso()]
  );
}
async function deletePushSubscription(endpoint) {
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}
// Manda un push a todas las suscripciones de este destinatario. Nunca
// truena si algo falla (una notificación in-app fallida por culpa del push
// sería peor que el push mismo fallando en silencio); las suscripciones que
// el navegador ya dio de baja (404/410, típico tras desinstalar la PWA o
// borrar datos del sitio) se limpian solas de la tabla.
async function sendPushToRecipient_(recipientType, recipientId, payload) {
  if (!pushEnabled) { console.warn("[push] pushEnabled=false (faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY), no se manda push"); return; }
  let subs;
  try { subs = await listPushSubscriptions(recipientType, recipientId); } catch (err) { console.error("[push] no se pudieron leer las suscripciones:", err.message); return; }
  console.log(`[push] enviando a ${recipientType}/${recipientId}: ${subs.length} suscripción(es)`);
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      console.log(`[push] enviado OK a endpoint ...${s.endpoint.slice(-20)}`);
    } catch (err) {
      console.error(`[push] falló el envío a endpoint ...${s.endpoint.slice(-20)}: statusCode=${err && err.statusCode} ${err && err.body ? err.body : err.message}`);
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await deletePushSubscription(s.endpoint).catch(() => {});
      }
      // cualquier otro error (red, payload, etc.) no truena la operación: el
      // push es un extra, la notificación in-app ya quedó guardada de
      // cualquier forma. Pero sí queda en el log del servidor para poder
      // diagnosticarlo.
    }
  }
}
// Diagnóstico bajo demanda (v30.1): a diferencia de sendPushToRecipient_
// (que nunca truena y no reporta detalle porque se dispara solo, en medio
// de otra acción), esta función SÍ regresa el resultado exacto de cada
// intento de envío, para poder ver desde la app (sin tocar los logs de
// Render) si: (a) VAPID está configurado en el servidor, (b) hay alguna
// suscripción guardada para esta cuenta, y (c) si el envío en sí falla, con
// qué código/mensaje exacto del servicio de push (por ejemplo 410 si la
// suscripción ya expiró, o un error de credenciales VAPID).
async function testPushForRecipient(recipientType, recipientId) {
  if (!pushEnabled) {
    return { push_enabled: false, subscriptions_count: 0, results: [] };
  }
  const subs = await listPushSubscriptions(recipientType, recipientId);
  const count = await countUnreadNotifications(recipientType, recipientId).catch(() => 0);
  const payload = JSON.stringify({
    title: "Reigning Blood Pressure App",
    body: "Notificación de prueba: si la ves, el push funciona correctamente.",
    count,
  });
  const results = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      results.push({ endpoint_tail: s.endpoint.slice(-24), success: true });
    } catch (err) {
      results.push({
        endpoint_tail: s.endpoint.slice(-24),
        success: false,
        status: err && err.statusCode != null ? err.statusCode : null,
        error: err && err.body ? String(err.body) : (err && err.message ? err.message : String(err)),
      });
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await deletePushSubscription(s.endpoint).catch(() => {});
      }
    }
  }
  return { push_enabled: true, subscriptions_count: subs.length, results };
}
async function createNotification(recipientType, recipientId, type, message, relatedId) {
  if (!recipientId) return;
  await pool.query(
    `INSERT INTO notificaciones (id, recipient_type, recipient_id, type, message, related_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uuid(), recipientType, recipientId, type, message || "", relatedId || "", nowIso()]
  );
  if (pushEnabled) {
    countUnreadNotifications(recipientType, recipientId)
      .then(count => sendPushToRecipient_(recipientType, recipientId, {
        title: "Reigning Blood Pressure App",
        body: message || "Tienes una notificación nueva.",
        count,
      }))
      .catch(err => console.error("[push] error inesperado preparando el envío:", err.message));
  }
}
async function listNotifications(recipientType, recipientId) {
  const { rows } = await pool.query(
    `SELECT id, recipient_type, recipient_id, type, message, related_id, created_at, read_at
     FROM notificaciones WHERE recipient_type = $1 AND recipient_id = $2
     ORDER BY created_at DESC LIMIT 50`,
    [recipientType, recipientId]
  );
  return rows.map(r => ({ ...r, created_at: new Date(r.created_at).toISOString(), read_at: r.read_at ? new Date(r.read_at).toISOString() : "" }));
}

// Solo se dispara al agregar o cambiar una reacción (nunca al quitarla).
async function notifyReaction(patientId, targetType, targetId, reactorRole, reactorName, reaction) {
  const emoji = REACTION_EMOJI[reaction] || "";
  const targetLabel = targetType === "comment" ? "un comentario" : "una lectura";
  const name = reactorName && String(reactorName).trim()
    ? String(reactorName).trim()
    : (reactorRole === "doctor" ? "Tu médico" : reactorRole === "family" ? "Alguien de tu familia o amigos" : "El paciente");
  const message = `${name} reaccionó ${emoji} a ${targetLabel}.`;
  if (reactorRole === "doctor") {
    await createNotification("patient", patientId, "new_reaction", message, targetId);
  } else {
    const doctors = await listDoctorsForPatient(patientId);
    for (const d of doctors) await createNotification("doctor", d.id, "new_reaction", message, targetId);
    if (reactorRole === "family") {
      await createNotification("patient", patientId, "new_reaction", message, targetId);
    }
  }
}

// ---- Reacciones ----
async function listReactions(patientId) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, target_type, target_id, reactor_role, reactor_id, reaction, created_at
     FROM reacciones WHERE patient_id = $1`,
    [patientId]
  );
  return rows.map(r => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}
async function findReactionRow(patientId, targetType, targetId, reactorRole, reactorId) {
  const { rows } = await pool.query(
    `SELECT * FROM reacciones WHERE patient_id = $1 AND target_type = $2 AND target_id = $3 AND reactor_role = $4 AND reactor_id = $5`,
    [patientId, targetType, targetId, reactorRole, reactorId]
  );
  return rows[0] || null;
}

// ---- PasswordResets ----
async function findResetByToken(token) {
  const { rows } = await pool.query(`SELECT * FROM password_resets WHERE token = $1`, [token]);
  return rows[0] || null;
}
async function clearPendingResetsForAccount(accountType, accountId) {
  await pool.query(`DELETE FROM password_resets WHERE account_type = $1 AND account_id = $2`, [accountType, accountId]);
}

// ---- v30: administración ----
async function findAdminByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM admins WHERE email = $1`, [String(email || "").toLowerCase()]);
  return rows[0] || null;
}
// Vista combinada de todas las cuentas (pacientes y médicos) para el panel
// de administrador: solo lo necesario para la lista (nada de contraseñas ni
// datos clínicos), con el nombre del paciente al que cada médico está
// ligado para que la tabla tenga contexto sin una segunda consulta por fila.
async function listAllAccounts() {
  const [{ rows: patients }, { rows: doctors }] = await Promise.all([
    pool.query(`SELECT id, name, email, created_at, suspended FROM pacientes ORDER BY created_at DESC`),
    pool.query(`SELECT m.id, m.name, m.email, m.created_at, m.suspended, m.patient_id, p.name AS patient_name
                FROM medicos m LEFT JOIN pacientes p ON p.id = m.patient_id ORDER BY m.created_at DESC`),
  ]);
  return {
    patients: patients.map(r => ({ id: r.id, name: r.name, email: r.email, created_at: new Date(r.created_at).toISOString(), suspended: !!r.suspended })),
    doctors: doctors.map(r => ({ id: r.id, name: r.name, email: r.email, created_at: new Date(r.created_at).toISOString(), suspended: !!r.suspended, patient_id: r.patient_id, patient_name: r.patient_name || "" })),
  };
}
// Estadísticas de uso muy simples (conteos), a propósito sin analítica
// pesada: esta app es de un solo consultorio/familia, no un SaaS con miles
// de cuentas, así que un vistazo rápido de totales es lo que de verdad hace
// falta en el panel, no un dashboard de BI.
async function usageStats() {
  const q = (sql, params) => pool.query(sql, params).then(r => r.rows[0].c);
  const [patients, doctors, readings, comments, reactions, openTickets, newPatients7d, newPatients30d, pushSubs] = await Promise.all([
    q(`SELECT count(*)::int AS c FROM pacientes`),
    q(`SELECT count(*)::int AS c FROM medicos`),
    q(`SELECT count(*)::int AS c FROM lecturas`),
    q(`SELECT count(*)::int AS c FROM comentarios`),
    q(`SELECT count(*)::int AS c FROM reacciones`),
    q(`SELECT count(*)::int AS c FROM support_tickets WHERE status = 'open'`),
    q(`SELECT count(*)::int AS c FROM pacientes WHERE created_at >= now() - interval '7 days'`),
    q(`SELECT count(*)::int AS c FROM pacientes WHERE created_at >= now() - interval '30 days'`),
    q(`SELECT count(*)::int AS c FROM push_subscriptions`),
  ]);
  return { patients, doctors, readings, comments, reactions, openTickets, newPatients7d, newPatients30d, pushSubs };
}
const BROADCAST_AUDIENCES = ["all", "patient", "doctor", "family"];
async function listBroadcasts() {
  const { rows } = await pool.query(`SELECT * FROM broadcast_messages ORDER BY created_at DESC`);
  return rows.map(r => ({ id: r.id, title: r.title, body: r.body, active: !!r.active, audience: r.audience || "all", created_at: new Date(r.created_at).toISOString() }));
}
// audience: para quién se está pidiendo la lista ("patient", "doctor" o
// "family"). Un mensaje se ve si es para "all" o coincide exactamente con
// quien pregunta; así un mismo mensaje puede dirigirse solo a una interfaz.
async function listActiveBroadcasts(audience) {
  const { rows } = await pool.query(
    `SELECT * FROM broadcast_messages WHERE active = true AND (audience = 'all' OR audience = $1) ORDER BY created_at DESC`,
    [audience || "all"]
  );
  return rows.map(r => ({ id: r.id, title: r.title, body: r.body, created_at: new Date(r.created_at).toISOString() }));
}
async function findTicketById(id) {
  const { rows } = await pool.query(`SELECT * FROM support_tickets WHERE id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, account_type: r.account_type, account_id: r.account_id, account_name: r.account_name, subject: r.subject, status: r.status, created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString() };
}
async function listTicketsForAccount(accountType, accountId) {
  const { rows } = await pool.query(
    `SELECT * FROM support_tickets WHERE account_type = $1 AND account_id = $2 ORDER BY updated_at DESC`,
    [accountType === "doctor" ? "doctor" : "patient", accountId]
  );
  return rows.map(r => ({ id: r.id, subject: r.subject, status: r.status, created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString() }));
}
async function listAllTickets() {
  const { rows } = await pool.query(`SELECT * FROM support_tickets ORDER BY (status = 'open') DESC, updated_at DESC`);
  return rows.map(r => ({ id: r.id, account_type: r.account_type, account_id: r.account_id, account_name: r.account_name, subject: r.subject, status: r.status, created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString() }));
}
async function listTicketMessages(ticketId) {
  const { rows } = await pool.query(`SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at`, [ticketId]);
  return rows.map(r => ({ id: r.id, author_role: r.author_role, text: r.text, created_at: new Date(r.created_at).toISOString() }));
}

// ============================================================
// doGet equivalente
// ============================================================
async function handleGet(params) {
  const action = params.action || "list";

  if (action === "list") {
    return { ok: true, data: await listReadings(params.patient_id) };
  }
  if (action === "list_comments") {
    return { ok: true, data: await listComments(params.patient_id) };
  }
  if (action === "get_patient_by_email") {
    const p = await findPatientByEmail(params.email);
    return { ok: true, data: patientRaw(p) };
  }
  if (action === "get_patient_by_id") {
    const p = await findPatientById(params.id);
    return { ok: true, data: p ? patientPublic(p) : null };
  }
  if (action === "get_patient_by_share_token") {
    const p = await findPatientByShareToken(params.token_value);
    return { ok: true, data: p ? patientPublic(p) : null };
  }
  if (action === "get_patient_by_invite_token") {
    const inv = await findInviteByToken(params.token_value);
    if (!inv) return { ok: true, data: null };
    const p = await findPatientById(inv.patient_id);
    return { ok: true, data: p ? { id: p.id, name: p.name } : null };
  }
  if (action === "get_doctor_by_email") {
    const d = await findDoctorByEmail(params.email);
    return { ok: true, data: d || null };
  }
  if (action === "get_doctor_by_id") {
    const d = await findDoctorById(params.id);
    return { ok: true, data: doctorPublic(d) };
  }
  if (action === "list_doctors") {
    return { ok: true, data: await listDoctorsForPatient(params.patient_id) };
  }
  if (action === "list_doctor_invites") {
    return { ok: true, data: await listInvitesForPatient(params.patient_id) };
  }
  if (action === "verify_reset_token") {
    const r = await findResetByToken(params.token_value);
    const valid = !!(r && r.account_type === params.account_type && new Date(r.expires_at).getTime() > Date.now());
    return { ok: true, data: { valid } };
  }
  if (action === "list_notifications") {
    return { ok: true, data: await listNotifications(params.recipient_type, params.recipient_id) };
  }
  if (action === "list_reactions") {
    return { ok: true, data: await listReactions(params.patient_id) };
  }
  if (action === "list_habits") {
    return { ok: true, data: await listHabits(params.patient_id) };
  }
  if (action === "list_doctor_catalog") {
    return { ok: true, data: await listDoctorCatalog() };
  }
  if (action === "list_symptoms") {
    return { ok: true, data: await listSymptoms(params.patient_id) };
  }
  if (action === "list_lab_history") {
    return { ok: true, data: await listLabHistory(params.patient_id) };
  }
  if (action === "list_medications") {
    return { ok: true, data: await listMedications(params.patient_id) };
  }
  if (action === "list_today_doses") {
    return { ok: true, data: await listTodayDoses(params.patient_id) };
  }
  if (action === "list_exercises") {
    return { ok: true, data: await listExercises(params.patient_id) };
  }
  if (action === "list_exercise_types") {
    return { ok: true, data: Object.entries(EXERCISE_MET_TABLE).map(([key, v]) => ({ key, label: v.label })) };
  }
  if (action === "list_medication_adherence") {
    return { ok: true, data: await listMedicationAdherence(params.patient_id) };
  }
  if (action === "list_consultations") {
    return { ok: true, data: await listConsultations(params.patient_id) };
  }
  // v28: respaldo descargable (JSON) con todo lo que el propio paciente
  // controla — lecturas, comentarios, reacciones y sus parámetros físicos/de
  // laboratorio. Deliberadamente NO incluye médicos vinculados, invitaciones,
  // notificaciones, correo ni contraseña: eso es administración de la cuenta,
  // no "tu historial", y restaurarlo de un respaldo viejo podría reabrir el
  // acceso de un médico que ya quitaste o pisar tu correo/contraseña actual.
  if (action === "export_backup") {
    const p = await findPatientById(params.patient_id);
    if (!p) return { ok: false, error: "no encontrado" };
    const patientRow = patientRaw(p);
    const [readings, comments, reactions] = await Promise.all([
      listReadings(params.patient_id),
      listComments(params.patient_id),
      listReactions(params.patient_id),
    ]);
    return {
      ok: true,
      data: {
        backup_version: BACKUP_VERSION,
        exported_at: nowIso(),
        app: "Reigning Blood Pressure App",
        patient: {
          name: patientRow.name,
          last_lab_date: patientRow.last_lab_date,
          cholesterol: patientRow.cholesterol,
          triglycerides: patientRow.triglycerides,
          med_brand: patientRow.med_brand,
          med_mg: patientRow.med_mg,
          gender: patientRow.gender,
          weight: patientRow.weight,
          waist: patientRow.waist,
        },
        readings, comments, reactions,
      },
    };
  }

  // ---- v30: panel de administrador ----
  if (action === "get_admin_by_email") {
    const a = await findAdminByEmail(params.email);
    return { ok: true, data: a || null };
  }
  if (action === "list_all_accounts") {
    return { ok: true, data: await listAllAccounts() };
  }
  if (action === "usage_stats") {
    return { ok: true, data: await usageStats() };
  }
  if (action === "list_broadcasts") {
    return { ok: true, data: await listBroadcasts() };
  }
  if (action === "get_active_broadcasts") {
    return { ok: true, data: await listActiveBroadcasts(params.audience) };
  }
  if (action === "list_my_tickets") {
    return { ok: true, data: await listTicketsForAccount(params.account_type, params.account_id) };
  }
  if (action === "list_all_tickets") {
    return { ok: true, data: await listAllTickets() };
  }
  if (action === "get_ticket_messages") {
    const ticket = await findTicketById(params.ticket_id);
    if (!ticket) return { ok: false, error: "no encontrado" };
    return { ok: true, data: { ticket, messages: await listTicketMessages(params.ticket_id) } };
  }
  return { ok: false, error: "acción no soportada" };
}

// ============================================================
// doPost equivalente
// ============================================================
async function handlePost(body) {
  const now = nowIso();

  // ---- Lecturas ----
  if (body.action === "add") {
    const id = uuid();
    await pool.query(
      `INSERT INTO lecturas (id, patient_id, date, time, sys, dia, hr, weight, obs, flag, created_at, updated_at, medicated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)`,
      [id, body.patient_id, body.date || null, body.time || null, num(body.sys), num(body.dia), num(body.hr), num(body.weight), body.obs || "", body.flag || "", now, !!body.medicated]
    );
    if (body.sys != null && body.dia != null) {
      const cat = classifyReading(Number(body.sys), Number(body.dia));
      if (cat.key === "etapa2" || cat.key === "crisis") {
        const p = await findPatientById(body.patient_id);
        const patientName = p ? p.name : "un paciente";
        const doctors = await listDoctorsForPatient(body.patient_id);
        for (const d of doctors) {
          await createNotification("doctor", d.id, "stage_alert",
            `${patientName} registró una lectura de ${body.sys}/${body.dia} mmHg (${cat.label}).`, id);
        }
      }
    }
    emitChange(body.patient_id, "reading");
    return { ok: true, id };
  }
  if (body.action === "update") {
    const { rowCount } = await pool.query(
      `UPDATE lecturas SET date=$1, time=$2, sys=$3, dia=$4, hr=$5, weight=$6, obs=$7, flag=$8, updated_at=$9, medicated=$10
       WHERE id = $11 AND patient_id = $12`,
      [body.date || null, body.time || null, num(body.sys), num(body.dia), num(body.hr), num(body.weight), body.obs || "", body.flag || "", now, !!body.medicated, body.id, body.patient_id]
    );
    if (!rowCount) return { ok: false, error: "no encontrado" };
    emitChange(body.patient_id, "reading");
    return { ok: true };
  }
  if (body.action === "delete") {
    const { rowCount } = await pool.query(`DELETE FROM lecturas WHERE id = $1 AND patient_id = $2`, [body.id, body.patient_id]);
    if (!rowCount) return { ok: false, error: "no encontrado" };
    emitChange(body.patient_id, "reading");
    return { ok: true };
  }

  // ---- Diagnóstico de push (v30.1) ----
  if (body.action === "test_push") {
    return { ok: true, data: await testPushForRecipient(body.recipient_type, body.recipient_id) };
  }

  // ---- Síntomas diarios (v30.4; escala por síntoma en v30.12) ----
  if (body.action === "add_symptom") {
    if (!body.fecha || !body.sintoma) return { ok: false, error: "faltan datos" };
    let severidad = null, temperatura = null;
    if (hasValue(body.severidad)) {
      severidad = num(body.severidad);
      if (severidad == null || severidad < 1 || severidad > 10) return { ok: false, error: "la intensidad debe ser un número entre 1 y 10" };
    }
    if (hasValue(body.temperatura)) {
      temperatura = num(body.temperatura);
      if (temperatura == null || temperatura < 30 || temperatura > 45) return { ok: false, error: "la temperatura debe ser un número entre 30 y 45 °C" };
    }
    const id = uuid();
    await pool.query(
      `INSERT INTO sintomas (id, patient_id, sintoma, tipo, severidad, temperatura, fecha, hora, descripcion, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, body.patient_id, body.sintoma, body.tipo || null, severidad, temperatura, body.fecha, body.hora || null, body.descripcion || "", now]
    );
    emitChange(body.patient_id, "symptom");
    return { ok: true, id };
  }
  if (body.action === "delete_symptom") {
    const { rowCount } = await pool.query(`DELETE FROM sintomas WHERE id = $1 AND patient_id = $2`, [body.id, body.patient_id]);
    if (!rowCount) return { ok: false, error: "no encontrado" };
    emitChange(body.patient_id, "symptom");
    return { ok: true };
  }

  // ---- Medicamentos (v30.8) ----
  if (body.action === "add_medication" || body.action === "update_medication") {
    // v30.11: frecuencia por horas/días/semanas + duración del tratamiento
    // (fecha de inicio obligatoria, fecha de fin opcional = indefinido).
    const unit = ["hours", "days", "weeks"].includes(body.frequency_unit) ? body.frequency_unit : "hours";
    const value = num(body.frequency_value != null ? body.frequency_value : body.frequency_hours);
    const startDate = body.start_date || nowInAppTz_().dateStr;
    const endDate = hasValue(body.end_date) ? body.end_date : null;
    if (!body.name || !hasValue(value) || !body.first_dose_time) {
      return { ok: false, error: "faltan datos (nombre, frecuencia y hora de la primera toma son obligatorios)" };
    }
    if (value <= 0) return { ok: false, error: "la frecuencia debe ser mayor a 0" };
    if (unit === "hours" && (value < 1 || value > 24)) {
      return { ok: false, error: "para frecuencia por horas, el valor debe estar entre 1 y 24" };
    }
    if (unit === "days" && (value < 1 || value > 90)) {
      return { ok: false, error: "para frecuencia por días, el valor debe estar entre 1 y 90" };
    }
    if (unit === "weeks" && (value < 1 || value > 52)) {
      return { ok: false, error: "para frecuencia por semanas, el valor debe estar entre 1 y 52" };
    }
    if (endDate && endDate < startDate) {
      return { ok: false, error: "la fecha de fin no puede ser anterior a la fecha de inicio" };
    }
    // frequency_hours (columna vieja) se respalda con un equivalente en horas
    // por si algún reporte/consulta vieja todavía la lee directo.
    const frequencyHoursEquivalent = unit === "hours" ? value : unit === "days" ? value * 24 : value * 24 * 7;
    if (body.action === "add_medication") {
      const id = uuid();
      await pool.query(
        `INSERT INTO medicamentos (id, patient_id, name, active_substance, mg, dose_text,
                frequency_hours, frequency_unit, frequency_value, first_dose_time,
                start_date, end_date, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$13)`,
        [id, body.patient_id, body.name, body.active_substance || "", num(body.mg), body.dose_text || "",
          frequencyHoursEquivalent, unit, value, body.first_dose_time, startDate, endDate, now]
      );
      emitChange(body.patient_id, "medication");
      return { ok: true, id };
    } else {
      const { rowCount } = await pool.query(
        `UPDATE medicamentos SET name = $1, active_substance = $2, mg = $3, dose_text = $4,
                frequency_hours = $5, frequency_unit = $6, frequency_value = $7, first_dose_time = $8,
                start_date = $9, end_date = $10, updated_at = $11
         WHERE id = $12 AND patient_id = $13`,
        [body.name, body.active_substance || "", num(body.mg), body.dose_text || "",
          frequencyHoursEquivalent, unit, value, body.first_dose_time, startDate, endDate, now, body.id, body.patient_id]
      );
      if (!rowCount) return { ok: false, error: "no encontrado" };
      emitChange(body.patient_id, "medication");
      return { ok: true };
    }
  }
  if (body.action === "delete_medication") {
    const { rowCount } = await pool.query(`DELETE FROM medicamentos WHERE id = $1 AND patient_id = $2`, [body.id, body.patient_id]);
    if (!rowCount) return { ok: false, error: "no encontrado" };
    emitChange(body.patient_id, "medication");
    return { ok: true };
  }
  if (body.action === "set_dose_taken") {
    if (!body.medication_id || !body.dose_time) return { ok: false, error: "faltan datos" };
    await setDoseTaken(body.patient_id, body.medication_id, body.dose_time, !!body.taken);
    emitChange(body.patient_id, "medication");
    return { ok: true };
  }

  // ---- Ejercicio (v30.10) ----
  if (body.action === "add_exercise" || body.action === "update_exercise") {
    if (!body.tipo || !hasValue(body.duracion_min) || !body.fecha) {
      return { ok: false, error: "faltan datos (tipo, duración y fecha son obligatorios)" };
    }
    const p = await findPatientById(body.patient_id);
    if (!p) return { ok: false, error: "no encontrado" };
    const calorias = calcExerciseCalories_(body.tipo, num(body.duracion_min), num(p.weight), num(p.height), p.birthdate, p.gender);
    if (body.action === "add_exercise") {
      const id = uuid();
      await pool.query(
        `INSERT INTO ejercicios (id, patient_id, tipo, duracion_min, fecha, hora, calorias, notas, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [id, body.patient_id, body.tipo, num(body.duracion_min), body.fecha, body.hora || null, calorias, body.notas || "", now]
      );
      emitChange(body.patient_id, "exercise");
      return { ok: true, id, calorias };
    } else {
      const { rowCount } = await pool.query(
        `UPDATE ejercicios SET tipo = $1, duracion_min = $2, fecha = $3, hora = $4, calorias = $5, notas = $6, updated_at = $7
         WHERE id = $8 AND patient_id = $9`,
        [body.tipo, num(body.duracion_min), body.fecha, body.hora || null, calorias, body.notas || "", now, body.id, body.patient_id]
      );
      if (!rowCount) return { ok: false, error: "no encontrado" };
      emitChange(body.patient_id, "exercise");
      return { ok: true, calorias };
    }
  }
  if (body.action === "delete_exercise") {
    const { rowCount } = await pool.query(`DELETE FROM ejercicios WHERE id = $1 AND patient_id = $2`, [body.id, body.patient_id]);
    if (!rowCount) return { ok: false, error: "no encontrado" };
    emitChange(body.patient_id, "exercise");
    return { ok: true };
  }

  // ---- Consultas médicas (v30.12) ----
  // La foto de receta viaja en la misma llamada (receta_base64/receta_mime),
  // a diferencia del avatar, para que capturar una consulta sea un solo
  // paso: fecha, médico, motivo, notas, foto y próxima cita juntos. Si no se
  // manda receta_base64 en un update, la foto existente se deja como está;
  // remove_receta:true la quita explícitamente.
  if (body.action === "add_consultation" || body.action === "update_consultation") {
    if (!body.fecha || !String(body.doctor_name || "").trim()) {
      return { ok: false, error: "faltan datos (fecha y médico son obligatorios)" };
    }
    let recetaBuf = null, recetaMime = null;
    if (hasValue(body.receta_base64)) {
      recetaBuf = Buffer.from(body.receta_base64, "base64");
      if (recetaBuf.length > RECETA_MAX_BYTES) {
        return { ok: false, error: "la foto es muy pesada (máximo " + Math.round(RECETA_MAX_BYTES / 1024) + " KB), intenta con una más chica" };
      }
      if (RECETA_ALLOWED_MIME.indexOf(body.receta_mime) === -1) {
        return { ok: false, error: "formato de imagen no soportado (usa JPG, PNG o WEBP)" };
      }
      recetaMime = body.receta_mime;
    }
    const nextAppt = body.next_appointment_date || null;
    if (body.action === "add_consultation") {
      const id = uuid();
      await pool.query(
        `INSERT INTO consultas (id, patient_id, fecha, doctor_name, motivo, notas, next_appointment_date, receta_data, receta_mime, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [id, body.patient_id, body.fecha, String(body.doctor_name).trim(), body.motivo || "", body.notas || "", nextAppt, recetaBuf, recetaMime, now]
      );
      emitChange(body.patient_id, "consultation");
      return { ok: true, id };
    } else {
      if (body.remove_receta) {
        const { rowCount } = await pool.query(
          `UPDATE consultas SET fecha = $1, doctor_name = $2, motivo = $3, notas = $4, next_appointment_date = $5,
                                 receta_data = NULL, receta_mime = NULL, updated_at = $6
           WHERE id = $7 AND patient_id = $8`,
          [body.fecha, String(body.doctor_name).trim(), body.motivo || "", body.notas || "", nextAppt, now, body.id, body.patient_id]
        );
        if (!rowCount) return { ok: false, error: "no encontrado" };
      } else if (recetaBuf) {
        const { rowCount } = await pool.query(
          `UPDATE consultas SET fecha = $1, doctor_name = $2, motivo = $3, notas = $4, next_appointment_date = $5,
                                 receta_data = $6, receta_mime = $7, updated_at = $8
           WHERE id = $9 AND patient_id = $10`,
          [body.fecha, String(body.doctor_name).trim(), body.motivo || "", body.notas || "", nextAppt, recetaBuf, recetaMime, now, body.id, body.patient_id]
        );
        if (!rowCount) return { ok: false, error: "no encontrado" };
      } else {
        const { rowCount } = await pool.query(
          `UPDATE consultas SET fecha = $1, doctor_name = $2, motivo = $3, notas = $4, next_appointment_date = $5, updated_at = $6
           WHERE id = $7 AND patient_id = $8`,
          [body.fecha, String(body.doctor_name).trim(), body.motivo || "", body.notas || "", nextAppt, now, body.id, body.patient_id]
        );
        if (!rowCount) return { ok: false, error: "no encontrado" };
      }
      emitChange(body.patient_id, "consultation");
      return { ok: true };
    }
  }
  if (body.action === "delete_consultation") {
    const { rowCount } = await pool.query(`DELETE FROM consultas WHERE id = $1 AND patient_id = $2`, [body.id, body.patient_id]);
    if (!rowCount) return { ok: false, error: "no encontrado" };
    emitChange(body.patient_id, "consultation");
    return { ok: true };
  }

  // ---- Malos hábitos (v30.1) ----
  if (body.action === "add_habit") {
    const tipo = HABIT_TYPE_KEYS.includes(body.tipo) ? body.tipo : "otro";
    if (!body.fecha) return { ok: false, error: "falta la fecha" };
    const id = uuid();
    await pool.query(
      `INSERT INTO malos_habitos (id, patient_id, tipo, fecha, valor_numero, valor_texto, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, body.patient_id, tipo, body.fecha, num(body.valor_numero), body.valor_texto || "", now]
    );
    emitChange(body.patient_id, "habit");
    return { ok: true, id };
  }
  if (body.action === "delete_habit") {
    const { rowCount } = await pool.query(`DELETE FROM malos_habitos WHERE id = $1 AND patient_id = $2`, [body.id, body.patient_id]);
    if (!rowCount) return { ok: false, error: "no encontrado" };
    emitChange(body.patient_id, "habit");
    return { ok: true };
  }

  // ---- Pacientes ----
  if (body.action === "signup_patient") {
    const email = String(body.email || "").toLowerCase().trim();
    if (!email || !body.password_hash || !body.name) return { ok: false, error: "faltan datos" };
    if (await findPatientByEmail(email)) return { ok: false, error: "ese correo ya tiene una cuenta" };
    const id = uuid();
    const shareToken = uuid().replace(/-/g, "");
    await pool.query(
      `INSERT INTO pacientes (id, name, email, password_hash, birthdate, share_token, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, body.name, email, body.password_hash, body.birthdate || null, shareToken, now]
    );
    return { ok: true, id, share_token: shareToken };
  }
  if (body.action === "update_patient_profile") {
    const p = await findPatientById(body.id);
    if (!p) return { ok: false, error: "no encontrado" };
    await pool.query(
      `UPDATE pacientes SET name = COALESCE($1, name), birthdate = COALESCE($2, birthdate), updated_at = $3 WHERE id = $4`,
      [body.name != null ? body.name : null, body.birthdate != null ? body.birthdate : null, now, body.id]
    );
    return { ok: true };
  }
  if (body.action === "update_patient_password") {
    const p = await findPatientById(body.id);
    if (!p) return { ok: false, error: "no encontrado" };
    await pool.query(`UPDATE pacientes SET password_hash = $1, updated_at = $2 WHERE id = $3`, [body.password_hash, now, body.id]);
    return { ok: true };
  }
  if (body.action === "update_patient_email") {
    const p = await findPatientById(body.id);
    if (!p) return { ok: false, error: "no encontrado" };
    const newEmail = String(body.email || "").toLowerCase().trim();
    if (!newEmail) return { ok: false, error: "correo inválido" };
    const existing = await findPatientByEmail(newEmail);
    if (existing && String(existing.id) !== String(p.id)) return { ok: false, error: "ese correo ya tiene una cuenta" };
    await pool.query(`UPDATE pacientes SET email = $1, updated_at = $2 WHERE id = $3`, [newEmail, now, body.id]);
    return { ok: true, email: newEmail };
  }
  if (body.action === "update_patient_params") {
    const p = await findPatientById(body.id);
    if (!p) return { ok: false, error: "no encontrado" };
    // Mismo criterio que Code.gs: solo se sobrescribe el campo que sí llega
    // con valor, para no borrar lo ya guardado si el formulario lo manda vacío.
    await pool.query(
      `UPDATE pacientes SET
         last_lab_date = CASE WHEN $1 THEN $2::date ELSE last_lab_date END,
         cholesterol   = CASE WHEN $3 THEN $4::numeric ELSE cholesterol END,
         triglycerides = CASE WHEN $5 THEN $6::numeric ELSE triglycerides END,
         med_brand     = CASE WHEN $7 THEN $8 ELSE med_brand END,
         med_mg        = CASE WHEN $9 THEN $10::numeric ELSE med_mg END,
         gender        = CASE WHEN $11 THEN $12 ELSE gender END,
         weight        = CASE WHEN $13 THEN $14::numeric ELSE weight END,
         waist         = CASE WHEN $15 THEN $16::numeric ELSE waist END,
         height        = CASE WHEN $17 THEN $18::numeric ELSE height END,
         updated_at    = $19
       WHERE id = $20`,
      [
        hasValue(body.last_lab_date), body.last_lab_date || null,
        hasValue(body.cholesterol), body.cholesterol ?? null,
        hasValue(body.triglycerides), body.triglycerides ?? null,
        hasValue(body.med_brand), body.med_brand || null,
        hasValue(body.med_mg), body.med_mg ?? null,
        hasValue(body.gender), body.gender || null,
        hasValue(body.weight), body.weight ?? null,
        hasValue(body.waist), body.waist ?? null,
        hasValue(body.height), body.height ?? null,
        now, body.id,
      ]
    );
    // v30.6: cada vez que se guarda cintura, colesterol o triglicéridos se
    // agrega un punto nuevo al historial (con la fecha de laboratorio si se
    // dio, si no la de hoy), para poder graficar su tendencia en el tiempo.
    // Antes solo existía "el valor actual", sin manera de ver cómo cambió.
    if (hasValue(body.waist) || hasValue(body.cholesterol) || hasValue(body.triglycerides)) {
      const waist = hasValue(body.waist) ? body.waist : p.waist;
      const cholesterol = hasValue(body.cholesterol) ? body.cholesterol : p.cholesterol;
      const triglycerides = hasValue(body.triglycerides) ? body.triglycerides : p.triglycerides;
      const fecha = hasValue(body.last_lab_date) ? body.last_lab_date : (p.last_lab_date || nowIso().slice(0, 10));
      await pool.query(
        `INSERT INTO lab_history (id, patient_id, fecha, waist, cholesterol, triglycerides, created_at)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7)`,
        [uuid(), body.id, fecha, waist ?? null, cholesterol ?? null, triglycerides ?? null, now]
      );
      emitChange(body.id, "lab_history");
    }
    return { ok: true };
  }
  if (body.action === "generate_doctor_invite") {
    const p = await findPatientById(body.patient_id);
    if (!p) return { ok: false, error: "no encontrado" };
    const used = (await countDoctorsForPatient(p.id)) + (await countPendingInvitesForPatient(p.id));
    if (used >= MAX_DOCTORS_PER_PATIENT) {
      return { ok: false, error: "Ya llegaste al máximo de " + MAX_DOCTORS_PER_PATIENT + " médicos vinculados. Quita el acceso de alguno o cancela una invitación pendiente para generar uno nuevo." };
    }
    const inviteToken = uuid().replace(/-/g, "");
    const email = body.email ? String(body.email).toLowerCase().trim() : null;
    await pool.query(`INSERT INTO medico_invites (id, patient_id, token, email, created_at) VALUES ($1,$2,$3,$4,$5)`, [uuid(), p.id, inviteToken, email, now]);
    let emailResult = null;
    if (email) {
      const origin = String(body.origin || "").replace(/\/+$/, "");
      const inviteUrl = origin + "/doctor/invite/" + inviteToken;
      emailResult = await sendDoctorInviteEmail_(email, p.name, inviteUrl);
    }
    return { ok: true, invite_token: inviteToken, email_sent: emailResult ? emailResult.sent : null, email_error: emailResult && !emailResult.sent ? emailResult.reason : null };
  }
  if (body.action === "cancel_doctor_invite") {
    const inv = await findInviteById(body.id);
    if (!inv || String(inv.patient_id) !== String(body.patient_id)) return { ok: false, error: "no encontrado" };
    await pool.query(`DELETE FROM medico_invites WHERE id = $1`, [inv.id]);
    return { ok: true };
  }
  if (body.action === "remove_doctor") {
    const d = await findDoctorById(body.id);
    if (!d || String(d.patient_id) !== String(body.patient_id)) return { ok: false, error: "no encontrado" };
    await pool.query(`DELETE FROM medicos WHERE id = $1`, [d.id]);
    return { ok: true };
  }
  if (body.action === "regenerate_share_token") {
    const p = await findPatientById(body.patient_id);
    if (!p) return { ok: false, error: "no encontrado" };
    const shareToken = uuid().replace(/-/g, "");
    await pool.query(`UPDATE pacientes SET share_token = $1 WHERE id = $2`, [shareToken, p.id]);
    return { ok: true, share_token: shareToken };
  }
  // ---- v30: foto de perfil ----
  // account_type/account_id siempre los decide el servidor (de la sesión),
  // nunca el cliente, para que nadie pueda subir/borrar la foto de otra
  // cuenta con solo cambiar el id en la petición.
  if (body.action === "upload_avatar") {
    const table = body.account_type === "doctor" ? "medicos" : "pacientes";
    const buf = Buffer.from(body.data_base64, "base64");
    if (buf.length > AVATAR_MAX_BYTES) {
      return { ok: false, error: "la imagen es muy pesada (máximo " + Math.round(AVATAR_MAX_BYTES / 1024) + " KB), intenta con una más chica" };
    }
    if (AVATAR_ALLOWED_MIME.indexOf(body.mime) === -1) {
      return { ok: false, error: "formato de imagen no soportado (usa JPG, PNG o WEBP)" };
    }
    await pool.query(`UPDATE ${table} SET avatar_data = $1, avatar_mime = $2 WHERE id = $3`, [buf, body.mime, body.account_id]);
    return { ok: true };
  }
  if (body.action === "remove_avatar") {
    const table = body.account_type === "doctor" ? "medicos" : "pacientes";
    await pool.query(`UPDATE ${table} SET avatar_data = NULL, avatar_mime = NULL WHERE id = $1`, [body.account_id]);
    return { ok: true };
  }

  // ---- Medicos ----
  if (body.action === "signup_doctor") {
    const inv = body.invite_token ? await findInviteByToken(body.invite_token) : null;
    if (!inv) return { ok: false, error: "invitación inválida o vencida" };
    const p = await findPatientById(inv.patient_id);
    if (!p) return { ok: false, error: "invitación inválida o vencida" };
    const email = String(body.email || "").toLowerCase().trim();
    if (!email || !body.password_hash || !body.name) return { ok: false, error: "faltan datos" };
    if (await findDoctorByEmail(email)) return { ok: false, error: "ese correo ya tiene una cuenta de médico" };
    if ((await countDoctorsForPatient(p.id)) >= MAX_DOCTORS_PER_PATIENT) {
      await pool.query(`DELETE FROM medico_invites WHERE id = $1`, [inv.id]);
      return { ok: false, error: "este paciente ya alcanzó el máximo de médicos vinculados" };
    }
    const id = uuid();
    const title = VALID_DOCTOR_TITLES.indexOf(body.title) !== -1 ? body.title : DEFAULT_DOCTOR_TITLE;
    await pool.query(
      `INSERT INTO medicos (id, patient_id, name, email, password_hash, created_at, title) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, p.id, body.name, email, body.password_hash, now, title]
    );
    await pool.query(`DELETE FROM medico_invites WHERE id = $1`, [inv.id]);
    return { ok: true, id, patient_id: p.id };
  }
  if (body.action === "update_doctor_password") {
    const d = await findDoctorById(body.id);
    if (!d) return { ok: false, error: "no encontrado" };
    await pool.query(`UPDATE medicos SET password_hash = $1 WHERE id = $2`, [body.password_hash, body.id]);
    return { ok: true };
  }
  if (body.action === "update_doctor_title") {
    const d = await findDoctorById(body.id);
    if (!d) return { ok: false, error: "no encontrado" };
    const title = VALID_DOCTOR_TITLES.indexOf(body.title) !== -1 ? body.title : DEFAULT_DOCTOR_TITLE;
    await pool.query(`UPDATE medicos SET title = $1 WHERE id = $2`, [title, body.id]);
    return { ok: true, title };
  }
  // v30.3: el médico decide, por su cuenta, si se publica en el catálogo.
  // v30.9: perfil ampliado ("carta de presentación") — lo mínimo obligatorio
  // para publicarse es especialidad, modalidad de atención y contacto;
  // todo lo demás (subespecialidad, años de experiencia, formación,
  // actividades, distinciones, asociaciones, idiomas, aseguradoras, sitio
  // web, horario) es opcional, para quien quiera promocionarse más.
  const VALID_CONSULTATION_MODES = ["presencial", "virtual", "ambos"];
  if (body.action === "update_doctor_catalog_profile") {
    const d = await findDoctorById(body.id);
    if (!d) return { ok: false, error: "no encontrado" };
    const optIn = !!body.catalog_opt_in;
    if (optIn) {
      if (!body.specialty) return { ok: false, error: "elige una especialidad para publicarte en el catálogo" };
      if (!VALID_CONSULTATION_MODES.includes(body.consultation_mode)) {
        return { ok: false, error: "elige la modalidad de atención (presencial, virtual o ambas)" };
      }
      if (!String(body.catalog_contact || "").trim()) {
        return { ok: false, error: "agrega un contacto para que te puedan localizar" };
      }
    }
    await pool.query(
      `UPDATE medicos SET catalog_opt_in = $1, specialty = $2, catalog_bio = $3, catalog_contact = $4, catalog_city = $5,
              consultation_mode = $6, subspecialty = $7, years_experience = $8, education = $9,
              professional_activities = $10, distinctions = $11, associations = $12, languages = $13,
              insurances = $14, website = $15, schedule_note = $16
       WHERE id = $17`,
      [optIn, body.specialty || "", body.catalog_bio || "", body.catalog_contact || "", body.catalog_city || "",
        VALID_CONSULTATION_MODES.includes(body.consultation_mode) ? body.consultation_mode : "presencial",
        body.subspecialty || "", num(body.years_experience), body.education || "",
        body.professional_activities || "", body.distinctions || "", body.associations || "",
        body.languages || "", body.insurances || "", body.website || "", body.schedule_note || "",
        body.id]
    );
    return { ok: true };
  }

  // ---- PasswordResets ----
  if (body.action === "request_password_reset") {
    const accountType = body.account_type === "doctor" ? "doctor" : "patient";
    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return { ok: true };
    const account = accountType === "doctor" ? await findDoctorByEmail(email) : await findPatientByEmail(email);
    if (!account) return { ok: true };
    await clearPendingResetsForAccount(accountType, account.id);
    const token = uuid().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO password_resets (id, account_type, account_id, token, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), accountType, account.id, token, expiresAt, now]
    );
    const origin = String(body.origin || "").replace(/\/+$/, "");
    const path = accountType === "doctor" ? "/doctor/reset-password/" : "/reset-password/";
    const resetUrl = origin + path + token;
    // Igual que en Code.gs: el enlace se regresa siempre en la respuesta, no
    // depende de que el envío de correo funcione. Aquí no se intenta enviar
    // correo (no hay MailApp fuera de Apps Script); si más adelante se quiere
    // correo real, se conecta un proveedor SMTP/API aquí sin cambiar la forma
    // de la respuesta.
    return { ok: true, reset_url: resetUrl };
  }
  if (body.action === "reset_password_with_token") {
    const accountType = body.account_type === "doctor" ? "doctor" : "patient";
    const r = await findResetByToken(body.reset_token);
    const valid = !!(r && r.account_type === accountType && new Date(r.expires_at).getTime() > Date.now());
    if (!valid) return { ok: false, error: "este enlace ya no es válido, pide uno nuevo" };
    if (accountType === "doctor") {
      const d = await findDoctorById(r.account_id);
      if (!d) return { ok: false, error: "no encontrado" };
      await pool.query(`UPDATE medicos SET password_hash = $1 WHERE id = $2`, [body.password_hash, d.id]);
    } else {
      const p = await findPatientById(r.account_id);
      if (!p) return { ok: false, error: "no encontrado" };
      await pool.query(`UPDATE pacientes SET password_hash = $1, updated_at = $2 WHERE id = $3`, [body.password_hash, now, p.id]);
    }
    await pool.query(`DELETE FROM password_resets WHERE id = $1`, [r.id]);
    return { ok: true };
  }

  // ---- Comentarios ----
  if (body.action === "add_comment") {
    const authorRole = body.author_role === "patient" ? "patient" : "doctor";
    const parentId = body.parent_id || null;
    if (authorRole === "patient" && !parentId) {
      return { ok: false, error: "el paciente solo puede responder a un comentario existente" };
    }
    let authorName;
    if (authorRole === "doctor") {
      const doctorRow = await findDoctorById(body.author_id);
      authorName = doctorDisplayName(doctorRow || { name: body.author, title: "" });
    } else {
      const p = await findPatientById(body.patient_id);
      authorName = p ? p.name : (body.author || "Paciente");
    }
    const id = uuid();
    await pool.query(
      `INSERT INTO comentarios (id, patient_id, reading_id, author, author_role, author_id, parent_id, text, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, body.patient_id, body.reading_id || null, authorName, authorRole, body.author_id || "", parentId, body.text || "", now]
    );
    if (authorRole === "doctor") {
      await createNotification("patient", body.patient_id, "new_comment", `${authorName} dejó un comentario nuevo.`, id);
    } else if (parentId) {
      const parent = await findCommentById(parentId);
      if (parent && parent.author_role === "doctor" && parent.author_id) {
        await createNotification("doctor", parent.author_id, "new_reply", `${authorName} respondió a tu comentario.`, id);
      }
    }
    emitChange(body.patient_id, "comment");
    return { ok: true, id };
  }
  if (body.action === "mark_notifications_read") {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
    if (ids) {
      await pool.query(
        `UPDATE notificaciones SET read_at = $1 WHERE recipient_type = $2 AND recipient_id = $3 AND id = ANY($4::uuid[]) AND read_at IS NULL`,
        [now, body.recipient_type, body.recipient_id, ids]
      );
    } else {
      await pool.query(
        `UPDATE notificaciones SET read_at = $1 WHERE recipient_type = $2 AND recipient_id = $3 AND read_at IS NULL`,
        [now, body.recipient_type, body.recipient_id]
      );
    }
    return { ok: true };
  }

  // ---- Reacciones ----
  if (body.action === "toggle_reaction") {
    const reactorRole = ["patient", "doctor", "family"].indexOf(body.reactor_role) !== -1 ? body.reactor_role : null;
    const targetType = body.target_type === "reading" ? "reading" : (body.target_type === "comment" ? "comment" : null);
    if (!reactorRole || !targetType || !body.reactor_id || !body.target_id || !body.patient_id) {
      return { ok: false, error: "faltan datos" };
    }
    if (REACTION_TYPES.indexOf(body.reaction) === -1) {
      return { ok: false, error: "reacción inválida" };
    }
    const existing = await findReactionRow(body.patient_id, targetType, body.target_id, reactorRole, body.reactor_id);
    if (existing && existing.reaction === body.reaction) {
      await pool.query(`DELETE FROM reacciones WHERE id = $1`, [existing.id]);
      // No dispara notifyReaction (igual que antes), pero sí avisa por SSE:
      // esto no es una notificación (no queda registro ni le llega a nadie
      // una alerta), solo un "algo cambió, vuelve a pedir los datos" para que
      // el conteo se actualice en vivo en las demás pantallas abiertas.
      emitChange(body.patient_id, "reaction");
      return { ok: true, action: "removed", reaction: null };
    }
    if (existing) {
      await pool.query(`UPDATE reacciones SET reaction = $1, created_at = $2 WHERE id = $3`, [body.reaction, now, existing.id]);
      await notifyReaction(body.patient_id, targetType, body.target_id, reactorRole, body.reactor_name, body.reaction);
      emitChange(body.patient_id, "reaction");
      return { ok: true, action: "changed", reaction: body.reaction };
    }
    const id = uuid();
    await pool.query(
      `INSERT INTO reacciones (id, patient_id, target_type, target_id, reactor_role, reactor_id, reaction, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, body.patient_id, targetType, body.target_id, reactorRole, body.reactor_id, body.reaction, now]
    );
    await notifyReaction(body.patient_id, targetType, body.target_id, reactorRole, body.reactor_name, body.reaction);
    emitChange(body.patient_id, "reaction");
    return { ok: true, action: "added", reaction: body.reaction, id };
  }

  // ---- Respaldo/restauración (v28) ----
  // Reemplaza lecturas/comentarios/reacciones del paciente por lo que venga
  // en el respaldo (mismo criterio "borra y vuelve a insertar" del script de
  // migración: re-ejecutable y sin dejar residuos de antes de la
  // restauración), y actualiza sus parámetros físicos/de laboratorio al
  // valor exacto que tenían al momento del respaldo. Nunca toca médicos
  // vinculados, invitaciones, correo ni contraseña — ver comentario en
  // export_backup.
  if (body.action === "restore_backup") {
    const p = await findPatientById(body.patient_id);
    if (!p) return { ok: false, error: "no encontrado" };
    const backup = body.backup;
    if (!backup || backup.backup_version !== BACKUP_VERSION || !Array.isArray(backup.readings) ||
        !Array.isArray(backup.comments) || !Array.isArray(backup.reactions)) {
      return { ok: false, error: "el archivo de respaldo no es válido o es de una versión incompatible" };
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM reacciones WHERE patient_id = $1`, [body.patient_id]);
      await client.query(`DELETE FROM comentarios WHERE patient_id = $1`, [body.patient_id]);
      await client.query(`DELETE FROM lecturas WHERE patient_id = $1`, [body.patient_id]);

      for (const r of backup.readings) {
        await client.query(
          `INSERT INTO lecturas (id, patient_id, date, time, sys, dia, hr, weight, obs, flag, created_at, updated_at, medicated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [r.id || uuid(), body.patient_id, r.date || null, r.time || null, num(r.sys), num(r.dia), num(r.hr),
            num(r.weight), r.obs || "", r.flag || "", r.created_at || now, r.updated_at || now, !!r.medicated]
        );
      }
      // Primero los comentarios sin padre, luego las respuestas: así la
      // llave foránea parent_id siempre encuentra ya insertado el comentario
      // al que responde, sin depender de que created_at venga en orden.
      const withoutParent = backup.comments.filter(c => !c.parent_id);
      const withParent = backup.comments.filter(c => c.parent_id);
      for (const c of [...withoutParent, ...withParent]) {
        await client.query(
          `INSERT INTO comentarios (id, patient_id, reading_id, author, author_role, author_id, parent_id, text, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [c.id || uuid(), body.patient_id, c.reading_id || null, c.author || "", c.author_role || "doctor", c.author_id || "", c.parent_id || null, c.text || "", c.created_at || now]
        );
      }
      for (const r of backup.reactions) {
        await client.query(
          `INSERT INTO reacciones (id, patient_id, target_type, target_id, reactor_role, reactor_id, reaction, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r.id || uuid(), body.patient_id, r.target_type, r.target_id, r.reactor_role, r.reactor_id, r.reaction, r.created_at || now]
        );
      }
      const bp = backup.patient || {};
      await client.query(
        `UPDATE pacientes SET
           last_lab_date = $1::date, cholesterol = $2::numeric, triglycerides = $3::numeric,
           med_brand = $4, med_mg = $5::numeric, gender = $6, weight = $7::numeric, waist = $8::numeric,
           updated_at = $9
         WHERE id = $10`,
        [bp.last_lab_date || null, bp.cholesterol ?? null, bp.triglycerides ?? null, bp.med_brand || null,
          bp.med_mg ?? null, bp.gender || null, bp.weight ?? null, bp.waist ?? null, now, body.patient_id]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    emitChange(body.patient_id, "reading");
    emitChange(body.patient_id, "comment");
    emitChange(body.patient_id, "reaction");
    return {
      ok: true,
      counts: { readings: backup.readings.length, comments: backup.comments.length, reactions: backup.reactions.length },
    };
  }

  // ---- Push (Web Push, v29) ----
  if (body.action === "save_push_subscription") {
    const recipientType = body.recipient_type === "doctor" ? "doctor" : "patient";
    if (!body.recipient_id || !body.subscription) return { ok: false, error: "faltan datos" };
    await savePushSubscription(recipientType, body.recipient_id, body.subscription);
    return { ok: true };
  }
  if (body.action === "delete_push_subscription") {
    if (!body.endpoint) return { ok: false, error: "faltan datos" };
    await deletePushSubscription(body.endpoint);
    return { ok: true };
  }

  // ---- v30: panel de administrador ----
  // bootstrap_admin: crea o actualiza la cuenta de administrador a partir de
  // ADMIN_EMAIL/ADMIN_PASSWORD (server.js ya hashea la contraseña antes de
  // llamar esto). Se corre una vez al arrancar el servidor; si ya existe un
  // admin con ese correo, solo actualiza el nombre/contraseña — así cambiar
  // ADMIN_PASSWORD en Render y reiniciar el servicio también rota la
  // contraseña sin tener que tocar la base de datos a mano.
  if (body.action === "bootstrap_admin") {
    const existing = await findAdminByEmail(body.email);
    if (existing) {
      await pool.query(`UPDATE admins SET name = $1, password_hash = $2 WHERE id = $3`, [body.name, body.password_hash, existing.id]);
      return { ok: true, id: existing.id, created: false };
    }
    const id = uuid();
    await pool.query(`INSERT INTO admins (id, name, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)`, [id, body.name, body.email, body.password_hash, now]);
    return { ok: true, id, created: true };
  }
  if (body.action === "toggle_account_suspended") {
    const table = body.account_type === "doctor" ? "medicos" : "pacientes";
    await pool.query(`UPDATE ${table} SET suspended = $1 WHERE id = $2`, [!!body.suspended, body.id]);
    return { ok: true };
  }
  if (body.action === "create_broadcast") {
    const audience = BROADCAST_AUDIENCES.includes(body.audience) ? body.audience : "all";
    const id = uuid();
    await pool.query(`INSERT INTO broadcast_messages (id, title, body, active, audience, created_at) VALUES ($1,$2,$3,true,$4,$5)`, [id, body.title, body.body || "", audience, now]);
    return { ok: true, id };
  }
  if (body.action === "deactivate_broadcast") {
    await pool.query(`UPDATE broadcast_messages SET active = false WHERE id = $1`, [body.id]);
    return { ok: true };
  }
  if (body.action === "create_support_ticket") {
    const accountType = body.account_type === "doctor" ? "doctor" : "patient";
    if (!body.subject || !String(body.subject).trim()) return { ok: false, error: "escribe un asunto" };
    if (!body.message || !String(body.message).trim()) return { ok: false, error: "escribe tu mensaje" };
    const id = uuid();
    await pool.query(
      `INSERT INTO support_tickets (id, account_type, account_id, account_name, subject, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'open',$6,$6)`,
      [id, accountType, body.account_id, body.account_name || "", body.subject, now]
    );
    await pool.query(`INSERT INTO support_ticket_messages (id, ticket_id, author_role, text, created_at) VALUES ($1,$2,$3,$4,$5)`, [uuid(), id, accountType, body.message, now]);
    return { ok: true, id };
  }
  if (body.action === "add_ticket_message") {
    const ticket = await findTicketById(body.ticket_id);
    if (!ticket) return { ok: false, error: "no encontrado" };
    if (!body.text || !String(body.text).trim()) return { ok: false, error: "escribe un mensaje" };
    await pool.query(`INSERT INTO support_ticket_messages (id, ticket_id, author_role, text, created_at) VALUES ($1,$2,$3,$4,$5)`, [uuid(), body.ticket_id, body.author_role, body.text, now]);
    // Un admin que responde reabre el ticket si estaba cerrado (para que no
    // se le "pierda" al paciente/médico una respuesta a un ticket cerrado);
    // un paciente/médico que escribe en un ticket cerrado también lo reabre.
    await pool.query(`UPDATE support_tickets SET updated_at = $1, status = 'open' WHERE id = $2`, [now, body.ticket_id]);
    return { ok: true };
  }
  if (body.action === "set_ticket_status") {
    const status = body.status === "closed" ? "closed" : "open";
    await pool.query(`UPDATE support_tickets SET status = $1, updated_at = $2 WHERE id = $3`, [status, now, body.id]);
    return { ok: true };
  }

  return { ok: false, error: "acción no soportada" };
}

// Misma forma que callSheetsApi(params, body) en server.js: si no hay body,
// es una lectura (antes GET a Apps Script); si hay body, es una escritura
// (antes POST a Apps Script). El token ya se validó en server.js (nunca
// llega a esta capa), así que aquí no hace falta revisarlo de nuevo.
async function callPostgresApi(params, body) {
  try {
    await ensureSchema();
    if (body) return await handlePost(body);
    return await handleGet(params || {});
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

module.exports = { callPostgresApi, pool, ensureSchema, events, pushEnabled, VAPID_PUBLIC_KEY, getAvatarData, scanMedicationReminders, getConsultationReceta };
