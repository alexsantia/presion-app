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
  waist numeric
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
