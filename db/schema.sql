-- Esquema Postgres de Reigning Blood Pressure App (MVP2).
-- Traducción directa de las 8 pestañas que hoy administra apps-script/Code.gs.
-- v27 (misma versión de la app; solo cambia dónde vive la base de datos).
--
-- Notas de traducción:
--   - Todas las llaves primarias son UUID generados por la aplicación
--     (crypto.randomUUID() en Node), igual que Utilities.getUuid() en Apps
--     Script, para que el script de migración pueda copiar los ids ya
--     existentes en Sheets sin tener que remapear relaciones (lecturas,
--     comentarios y reacciones que apuntan a otras filas por id).
--   - reactor_id, author_id y related_id se guardan como TEXT (no UUID)
--     porque pueden apuntar a distintos tipos de cuenta o, en el caso de
--     familia/amigos, a un id anónimo por dispositivo (ej. "fam_xxxx") que
--     no es un UUID válido.
--   - La columna "doctor_invite_token" de Pacientes en Sheets ya estaba en
--     desuso (ninguna acción de Code.gs la lee ni la escribe), así que no
--     se migra.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS pacientes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  birthdate date,
  share_token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_lab_date date,
  cholesterol numeric,
  triglycerides numeric,
  med_brand text,
  med_mg numeric,
  gender text,
  weight numeric,
  waist numeric,
  height numeric
);

CREATE TABLE IF NOT EXISTS medicos (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL DEFAULT 'Dr(a).'
);
CREATE INDEX IF NOT EXISTS idx_medicos_patient_id ON medicos(patient_id);

CREATE TABLE IF NOT EXISTS medico_invites (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_medico_invites_patient_id ON medico_invites(patient_id);

CREATE TABLE IF NOT EXISTS lecturas (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  date date,
  time time,
  sys integer,
  dia integer,
  hr integer,
  weight numeric,
  obs text DEFAULT '',
  flag text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  medicated boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_lecturas_patient_id ON lecturas(patient_id);

CREATE TABLE IF NOT EXISTS comentarios (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  reading_id uuid REFERENCES lecturas(id) ON DELETE SET NULL,
  author text DEFAULT '',
  author_role text NOT NULL CHECK (author_role IN ('doctor', 'patient')),
  author_id text DEFAULT '',
  parent_id uuid REFERENCES comentarios(id) ON DELETE CASCADE,
  text text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comentarios_patient_id ON comentarios(patient_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY,
  account_type text NOT NULL CHECK (account_type IN ('patient', 'doctor')),
  account_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notificaciones (
  id uuid PRIMARY KEY,
  recipient_type text NOT NULL CHECK (recipient_type IN ('patient', 'doctor')),
  recipient_id uuid NOT NULL,
  type text NOT NULL,
  message text DEFAULT '',
  related_id text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_notificaciones_recipient ON notificaciones(recipient_type, recipient_id);

-- v29: suscripciones a notificaciones push (Web Push). Igual que
-- notificaciones, recipient_type/recipient_id identifican a quién pertenece
-- (paciente o médico) sin llave foránea directa, porque un mismo id puede
-- vivir en pacientes o en medicos según el tipo. endpoint es único porque el
-- navegador puede volver a mandar la misma suscripción (por ejemplo, tras
-- reinstalar la PWA); en ese caso solo se actualizan las llaves.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY,
  recipient_type text NOT NULL CHECK (recipient_type IN ('patient', 'doctor')),
  recipient_id uuid NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_recipient ON push_subscriptions(recipient_type, recipient_id);

CREATE TABLE IF NOT EXISTS reacciones (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('comment', 'reading')),
  target_id text NOT NULL,
  reactor_role text NOT NULL CHECK (reactor_role IN ('patient', 'doctor', 'family')),
  reactor_id text NOT NULL,
  reaction text NOT NULL CHECK (reaction IN ('like', 'love', 'haha', 'wow', 'sad', 'angry')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, target_type, target_id, reactor_role, reactor_id)
);
CREATE INDEX IF NOT EXISTS idx_reacciones_patient_id ON reacciones(patient_id);

-- v30: correo opcional en la invitación de médico, para poder mandar el
-- enlace por correo (ver RESEND_API_KEY) además de copiarlo a mano.
ALTER TABLE medico_invites ADD COLUMN IF NOT EXISTS email text;

-- v30: foto de perfil. Se guarda directo en Postgres (bytea) porque Render
-- no tiene disco persistente entre despliegues; para fotos de este tamaño
-- (se comprimen/redimensionan del lado del cliente antes de subirlas) esto
-- es más simple que depender de un bucket externo.
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS avatar_data bytea;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS avatar_mime text;
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS avatar_data bytea;
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS avatar_mime text;

-- v30: panel maestro de administrador — suspensión de cuentas, cuentas de
-- administrador, mensajes generales y tickets de soporte.
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS admins (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcast_messages (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- v30.5: elegir a quién va dirigido cada mensaje general (todas las
-- interfaces, o solo pacientes / médicos / familia y amigos).
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'all';

-- v30.6: historial de cintura/colesterol/triglicéridos, para poder graficar
-- su tendencia (antes solo se guardaba el valor actual en pacientes, sin
-- fecha de cuándo cambió). Se agrega un punto nuevo cada vez que se guardan
-- Parámetros con alguno de estos tres campos.
CREATE TABLE IF NOT EXISTS lab_history (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  fecha date NOT NULL,
  waist numeric,
  cholesterol numeric,
  triglycerides numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lab_history_patient ON lab_history(patient_id, fecha);

CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY,
  account_type text NOT NULL CHECK (account_type IN ('patient', 'doctor')),
  account_id uuid NOT NULL,
  account_name text NOT NULL DEFAULT '',
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_account ON support_tickets(account_type, account_id);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_role text NOT NULL CHECK (author_role IN ('patient', 'doctor', 'admin')),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket ON support_ticket_messages(ticket_id);

-- v30.1: Malos hábitos. valor_numero cubre lo que se cuenta (copas, horas de
-- sueño continuo, cigarrillos, etc.) y valor_texto lo que se describe (tipo
-- de bebida, qué se comió); ninguno de los dos es obligatorio porque no
-- todos los tipos de hábito usan ambos campos.
CREATE TABLE IF NOT EXISTS malos_habitos (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  fecha date NOT NULL,
  valor_numero numeric,
  valor_texto text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_malos_habitos_patient ON malos_habitos(patient_id, fecha DESC);

-- v30.3: Catálogo de médicos por especialidad (monetización). Un médico que
-- se enrola decide, por su cuenta, si publica estos datos en un catálogo
-- visible para cualquiera (paciente, otro médico, o un visitante del enlace
-- de familia). OJO: en este esquema cada cuenta de médico está ligada a un
-- solo paciente (medicos.patient_id NOT NULL), así que un médico real con
-- varios pacientes en la app tendría una cuenta por cada uno; si activa el
-- catálogo en más de una, se deduplica por correo al listar (ver
-- listDoctorCatalog en db-postgres.js) para no mostrarlo repetido.
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS catalog_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS specialty text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS catalog_bio text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS catalog_contact text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS catalog_city text NOT NULL DEFAULT '';

-- v30.4: Síntomas diarios. Registro simple de un síntoma puntual (no ligado
-- a una lectura de presión), con su fecha, hora y una descripción libre.
CREATE TABLE IF NOT EXISTS sintomas (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  sintoma text NOT NULL,
  fecha date NOT NULL,
  hora time,
  descripcion text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sintomas_patient ON sintomas(patient_id, fecha DESC);

-- v30.8: Medicamentos con recordatorio automático. El calendario semanal NO
-- se captura a mano (el paciente no elige horas sueltas): se calcula solo, a
-- partir de la frecuencia (frequency_hours, cada cuántas horas debe tomarse)
-- y la hora de la primera toma (first_dose_time), repitiéndose todos los
-- días de la semana (ver computeDoseTimes_ en db-postgres.js). medicamento_dosis
-- guarda cada ocurrencia real de una toma (una fila por medicamento + fecha +
-- hora), para saber si ya se marcó como tomada y cuándo se mandó el último
-- recordatorio push; se crea solo cuando hace falta (al marcarla, o cuando el
-- escaneo de recordatorios la ve por primera vez), no de antemano para todo
-- el mes.
CREATE TABLE IF NOT EXISTS medicamentos (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  name text NOT NULL,
  active_substance text NOT NULL DEFAULT '',
  mg numeric,
  dose_text text NOT NULL DEFAULT '',
  frequency_hours numeric NOT NULL,
  first_dose_time time NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_medicamentos_patient ON medicamentos(patient_id);

-- v30.11: frecuencia por horas/días/semanas (antes solo horas, máx 24 — no
-- alcanzaba para "cada 3 días" o "cada semana"), más duración del tratamiento
-- (fecha de inicio/fin, o indefinido si end_date es NULL). frequency_hours se
-- deja de exigir NOT NULL porque para unit='days'/'weeks' ya no aplica
-- directamente (se respalda igual con un equivalente en horas por si algún
-- código viejo lo lee, pero la fuente de verdad ahora es frequency_unit +
-- frequency_value). start_date default CURRENT_DATE para que los
-- medicamentos ya existentes (creados antes de esta versión) sigan activos
-- desde ya, sin fecha de inicio futura que los desactive por accidente.
ALTER TABLE medicamentos ALTER COLUMN frequency_hours DROP NOT NULL;
ALTER TABLE medicamentos ADD COLUMN IF NOT EXISTS frequency_unit text NOT NULL DEFAULT 'hours';
ALTER TABLE medicamentos ADD COLUMN IF NOT EXISTS frequency_value numeric;
ALTER TABLE medicamentos ADD COLUMN IF NOT EXISTS start_date date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE medicamentos ADD COLUMN IF NOT EXISTS end_date date;
UPDATE medicamentos SET frequency_value = frequency_hours WHERE frequency_value IS NULL;

-- v30.9: perfil ampliado del médico en el catálogo ("carta de presentación").
-- Mínimo obligatorio para publicarse (validado en update_doctor_catalog_profile):
-- especialidad, modalidad de atención y contacto. Todo lo demás es opcional,
-- para quien quiera promocionarse más — inspirado en perfiles de médicos de
-- hospitales grandes (formación, actividades profesionales, distinciones,
-- asociaciones), pero como texto libre de una línea por punto en vez de
-- tablas separadas, para no complicar el esquema.
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS consultation_mode text NOT NULL DEFAULT 'presencial';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS subspecialty text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS years_experience integer;
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS education text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS professional_activities text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS distinctions text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS associations text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS languages text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS insurances text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS website text NOT NULL DEFAULT '';
ALTER TABLE medicos ADD COLUMN IF NOT EXISTS schedule_note text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS medicamento_dosis (
  id uuid PRIMARY KEY,
  medication_id uuid NOT NULL REFERENCES medicamentos(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  dose_date date NOT NULL,
  dose_time time NOT NULL,
  taken boolean NOT NULL DEFAULT false,
  taken_at timestamptz,
  last_reminder_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (medication_id, dose_date, dose_time)
);
CREATE INDEX IF NOT EXISTS idx_medicamento_dosis_patient ON medicamento_dosis(patient_id, dose_date);

-- v30.10: estatura del paciente (para calcular calorías quemadas en Ejercicio).
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS height numeric;

-- v30.10: pestaña de Ejercicio — captura manual (tipo, duración, fecha); las
-- calorías se calculan y guardan al momento de capturar, con el MET del tipo
-- de ejercicio y el peso del paciente en ese momento (no se recalculan
-- después si el paciente cambia de peso, para no alterar el historial).
CREATE TABLE IF NOT EXISTS ejercicios (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  duracion_min numeric NOT NULL,
  fecha date NOT NULL,
  hora time,
  calorias numeric,
  notas text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ejercicios_patient_id ON ejercicios(patient_id);
