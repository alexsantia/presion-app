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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

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
      const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(s => s && !s.startsWith("--"));
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
    gender: row.gender || "", weight: num(row.weight), waist: num(row.waist),
  };
}
function patientPublic(row) {
  const p = patientRaw(row);
  if (!p) return null;
  const { password_hash, ...rest } = p;
  return rest;
}
const PATIENT_SELECT = `SELECT id, name, email, password_hash, to_char(birthdate, 'YYYY-MM-DD') AS birthdate,
  share_token, created_at, updated_at, to_char(last_lab_date, 'YYYY-MM-DD') AS last_lab_date,
  cholesterol, triglycerides, med_brand, med_mg, gender, weight, waist FROM pacientes`;

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
  return { id: row.id, name: row.name, email: row.email, patient_id: row.patient_id, title: row.title || DEFAULT_DOCTOR_TITLE };
}
function doctorDisplayName(d) {
  if (!d) return DEFAULT_DOCTOR_TITLE + " " + "(médico)";
  const title = d.title && VALID_DOCTOR_TITLES.indexOf(d.title) !== -1 ? d.title : DEFAULT_DOCTOR_TITLE;
  return title + " " + (d.name || "");
}
async function findDoctorByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM medicos WHERE email = $1`, [String(email || "").toLowerCase()]);
  return rows[0] || null;
}
async function findDoctorById(id) {
  const { rows } = await pool.query(`SELECT * FROM medicos WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function listDoctorsForPatient(patientId) {
  const { rows } = await pool.query(
    `SELECT id, name, email, created_at, title FROM medicos WHERE patient_id = $1 ORDER BY created_at`,
    [patientId]
  );
  return rows.map(r => ({ id: r.id, name: r.name, email: r.email, created_at: new Date(r.created_at).toISOString(), title: r.title || DEFAULT_DOCTOR_TITLE }));
}
async function countDoctorsForPatient(patientId) {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM medicos WHERE patient_id = $1`, [patientId]);
  return rows[0].c;
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
  const { rows } = await pool.query(`SELECT id, token, created_at FROM medico_invites WHERE patient_id = $1 ORDER BY created_at`, [patientId]);
  return rows.map(r => ({ id: r.id, token: r.token, created_at: new Date(r.created_at).toISOString() }));
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
async function createNotification(recipientType, recipientId, type, message, relatedId) {
  if (!recipientId) return;
  await pool.query(
    `INSERT INTO notificaciones (id, recipient_type, recipient_id, type, message, related_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uuid(), recipientType, recipientId, type, message || "", relatedId || "", nowIso()]
  );
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
         updated_at    = $17
       WHERE id = $18`,
      [
        hasValue(body.last_lab_date), body.last_lab_date || null,
        hasValue(body.cholesterol), body.cholesterol ?? null,
        hasValue(body.triglycerides), body.triglycerides ?? null,
        hasValue(body.med_brand), body.med_brand || null,
        hasValue(body.med_mg), body.med_mg ?? null,
        hasValue(body.gender), body.gender || null,
        hasValue(body.weight), body.weight ?? null,
        hasValue(body.waist), body.waist ?? null,
        now, body.id,
      ]
    );
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
    await pool.query(`INSERT INTO medico_invites (id, patient_id, token, created_at) VALUES ($1,$2,$3,$4)`, [uuid(), p.id, inviteToken, now]);
    return { ok: true, invite_token: inviteToken };
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

module.exports = { callPostgresApi, pool, ensureSchema, events };
