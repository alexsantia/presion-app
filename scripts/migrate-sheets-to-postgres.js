// Migra los datos de Google Sheets (MVP1) a Postgres (MVP2).
// v27
//
// IMPORTANTE: este script SOLO LEE de Sheets (usa las mismas acciones que ya
// están publicadas y en uso por producción, ninguna nueva). Nunca escribe ni
// borra nada en la hoja de cálculo. MVP1 no se entera de que esto corrió.
//
// Es seguro correrlo varias veces: por cada paciente, primero borra en
// Postgres solo las filas que le pertenecen a ese paciente (y a sus
// médicos), y luego las vuelve a insertar tal como están en Sheets en ese
// momento. Así se puede correr una vez para armar el ambiente de pruebas, y
// otra vez justo antes del cutover final para capturar lo que se haya
// registrado mientras tanto en MVP1.
//
// Uso:
//   SHEETS_WEBAPP_URL=... SHEETS_TOKEN=... DATABASE_URL=... \
//     node scripts/migrate-sheets-to-postgres.js [correo1,correo2,...]
// Si no se pasa ninguna lista de correos, migra PATIENT_EMAILS del entorno,
// o por default solo alejandro@empresso.mx.

const { Pool } = require("pg");

const { SHEETS_WEBAPP_URL, SHEETS_TOKEN, DATABASE_URL, PATIENT_EMAILS } = process.env;

if (!SHEETS_WEBAPP_URL || !SHEETS_TOKEN || !DATABASE_URL) {
  console.error("Faltan SHEETS_WEBAPP_URL, SHEETS_TOKEN o DATABASE_URL en el entorno.");
  process.exit(1);
}

const emailsArg = process.argv[2] || PATIENT_EMAILS || "alejandro@empresso.mx";
const emails = emailsArg.split(",").map(s => s.trim()).filter(Boolean);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

async function sheetsGet(params) {
  const qs = new URLSearchParams({ ...params, token: SHEETS_TOKEN }).toString();
  const resp = await fetch(SHEETS_WEBAPP_URL + (SHEETS_WEBAPP_URL.includes("?") ? "&" : "?") + qs);
  const json = await resp.json();
  if (!json.ok) throw new Error(`acción ${params.action} falló: ${json.error}`);
  return json.data;
}

// Sheets a veces guarda fechas como objeto Date y Apps Script las serializa
// como marca de tiempo completa ("2026-07-18T06:00:00.000Z") en vez de solo
// "2026-07-18". Las acciones que ya normalizan (list, list de lecturas) no
// tienen este problema, pero get_patient_by_email SÍ regresa la fila cruda
// (necesaria aquí porque es la única que trae password_hash). Por eso
// cualquier campo de fecha se recorta defensivamente a los primeros 10
// caracteres antes de guardarlo en una columna DATE de Postgres.
function toDateOnly(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}
function toNumOrNull(v) {
  return v === null || v === undefined || v === "" ? null : Number(v);
}

async function migratePatient(email) {
  console.log(`\n=== Migrando paciente: ${email} ===`);
  const patient = await sheetsGet({ action: "get_patient_by_email", email });
  if (!patient) {
    console.log(`  (no existe un paciente con ese correo en Sheets, se omite)`);
    return;
  }
  const patientId = patient.id;

  const [readings, comments, doctorsPublic, invites, reactions, patientNotifications] = await Promise.all([
    sheetsGet({ action: "list", patient_id: patientId }),
    sheetsGet({ action: "list_comments", patient_id: patientId }),
    sheetsGet({ action: "list_doctors", patient_id: patientId }),
    sheetsGet({ action: "list_doctor_invites", patient_id: patientId }),
    sheetsGet({ action: "list_reactions", patient_id: patientId }),
    sheetsGet({ action: "list_notifications", recipient_type: "patient", recipient_id: patientId }),
  ]);

  // get_doctor_by_email es la única acción que trae password_hash; hay que
  // pedirla una vez por cada médico (list_doctors ya no la incluye).
  const doctors = [];
  const doctorNotificationsByDoctor = {};
  for (const dPublic of doctorsPublic) {
    const dRaw = await sheetsGet({ action: "get_doctor_by_email", email: dPublic.email });
    if (!dRaw) { console.log(`  aviso: no se pudo releer al médico ${dPublic.email}, se omite`); continue; }
    doctors.push(dRaw);
    doctorNotificationsByDoctor[dRaw.id] = await sheetsGet({ action: "list_notifications", recipient_type: "doctor", recipient_id: dRaw.id });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- Borrar lo que ya existiera de este paciente/médicos, para dejar
    // una copia exacta de cómo está Sheets ahora mismo (re-ejecutable). ----
    for (const d of doctors) {
      await client.query(`DELETE FROM notificaciones WHERE recipient_type = 'doctor' AND recipient_id = $1`, [d.id]);
    }
    await client.query(`DELETE FROM notificaciones WHERE recipient_type = 'patient' AND recipient_id = $1`, [patientId]);
    await client.query(`DELETE FROM reacciones WHERE patient_id = $1`, [patientId]);
    await client.query(`DELETE FROM comentarios WHERE patient_id = $1`, [patientId]);
    await client.query(`DELETE FROM lecturas WHERE patient_id = $1`, [patientId]);
    await client.query(`DELETE FROM medico_invites WHERE patient_id = $1`, [patientId]);
    await client.query(`DELETE FROM medicos WHERE patient_id = $1`, [patientId]);
    await client.query(`DELETE FROM pacientes WHERE id = $1`, [patientId]);

    // ---- Insertar la copia fresca ----
    await client.query(
      `INSERT INTO pacientes (id, name, email, password_hash, birthdate, share_token, created_at, updated_at,
         last_lab_date, cholesterol, triglycerides, med_brand, med_mg, gender, weight, waist)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        patient.id, patient.name, String(patient.email || "").toLowerCase(), patient.password_hash,
        toDateOnly(patient.birthdate), patient.share_token,
        patient.created_at || new Date().toISOString(), patient.updated_at || new Date().toISOString(),
        toDateOnly(patient.last_lab_date), toNumOrNull(patient.cholesterol), toNumOrNull(patient.triglycerides),
        patient.med_brand || null, toNumOrNull(patient.med_mg), patient.gender || null,
        toNumOrNull(patient.weight), toNumOrNull(patient.waist),
      ]
    );
    console.log(`  paciente ✔`);

    for (const d of doctors) {
      await client.query(
        `INSERT INTO medicos (id, patient_id, name, email, password_hash, created_at, title) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [d.id, d.patient_id, d.name, String(d.email || "").toLowerCase(), d.password_hash, d.created_at || new Date().toISOString(), d.title || "Dr(a)."]
      );
    }
    console.log(`  médicos: ${doctors.length} ✔`);

    for (const inv of invites) {
      await client.query(
        `INSERT INTO medico_invites (id, patient_id, token, created_at) VALUES ($1,$2,$3,$4)`,
        [inv.id, patientId, inv.token, inv.created_at || new Date().toISOString()]
      );
    }
    console.log(`  invitaciones pendientes: ${invites.length} ✔`);

    for (const r of readings) {
      await client.query(
        `INSERT INTO lecturas (id, patient_id, date, time, sys, dia, hr, weight, obs, flag, created_at, updated_at, medicated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [r.id, patientId, r.date || null, r.time || null, toNumOrNull(r.sys), toNumOrNull(r.dia), toNumOrNull(r.hr),
          toNumOrNull(r.weight), r.obs || "", r.flag || "", r.created_at, r.updated_at, !!r.medicated]
      );
    }
    console.log(`  lecturas: ${readings.length} ✔`);

    for (const c of comments) {
      await client.query(
        `INSERT INTO comentarios (id, patient_id, reading_id, author, author_role, author_id, parent_id, text, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [c.id, patientId, c.reading_id || null, c.author || "", c.author_role || "doctor", c.author_id || "", c.parent_id || null, c.text || "", c.created_at]
      );
    }
    console.log(`  comentarios: ${comments.length} ✔`);

    for (const r of reactions) {
      await client.query(
        `INSERT INTO reacciones (id, patient_id, target_type, target_id, reactor_role, reactor_id, reaction, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.id, patientId, r.target_type, r.target_id, r.reactor_role, r.reactor_id, r.reaction, r.created_at]
      );
    }
    console.log(`  reacciones: ${reactions.length} ✔`);

    let notifCount = 0;
    for (const n of patientNotifications) {
      await client.query(
        `INSERT INTO notificaciones (id, recipient_type, recipient_id, type, message, related_id, created_at, read_at)
         VALUES ($1,'patient',$2,$3,$4,$5,$6,$7)`,
        [n.id, patientId, n.type, n.message || "", n.related_id || "", n.created_at, n.read_at || null]
      );
      notifCount++;
    }
    for (const d of doctors) {
      for (const n of (doctorNotificationsByDoctor[d.id] || [])) {
        await client.query(
          `INSERT INTO notificaciones (id, recipient_type, recipient_id, type, message, related_id, created_at, read_at)
           VALUES ($1,'doctor',$2,$3,$4,$5,$6,$7)`,
          [n.id, d.id, n.type, n.message || "", n.related_id || "", n.created_at, n.read_at || null]
        );
        notifCount++;
      }
    }
    console.log(`  notificaciones: ${notifCount} ✔`);

    // Nota: PasswordResets no se migra a propósito. Son enlaces de un solo
    // uso con 30 minutos de vigencia; para cuando se corre este script ya
    // casi seguro están vencidos, y si alguien los necesita, simplemente
    // vuelve a pedir "olvidé mi contraseña" ya en el ambiente nuevo.

    await client.query("COMMIT");
    console.log(`  === listo, todo dentro de una sola transacción ===`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`  ERROR migrando a ${email}, se revirtió todo para este paciente:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

(async () => {
  console.log(`Migrando ${emails.length} paciente(s): ${emails.join(", ")}`);
  for (const email of emails) {
    await migratePatient(email);
  }
  await pool.end();
  console.log("\nMigración completa.");
})().catch(err => {
  console.error("Migración abortada:", err);
  process.exit(1);
});
