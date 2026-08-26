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

-- v30.12: catálogo de síntomas con escala propia. "sintoma" sigue siendo el
-- nombre para mostrar (compatible con las filas viejas, capturadas como
-- texto libre); "tipo" es la llave del catálogo (ver SYMPTOM_CATALOG en
-- common.js) para saber qué escala usar al mostrarlo. La mayoría de los
-- síntomas usa intensidad subjetiva 1-10 ("severidad"); Fiebre usa un grado
-- real en la escala Celsius ("temperatura"), porque un número de
-- temperatura es un dato más útil y objetivo para el médico que una
-- intensidad subjetiva.
ALTER TABLE sintomas ADD COLUMN IF NOT EXISTS tipo text;
ALTER TABLE sintomas ADD COLUMN IF NOT EXISTS severidad numeric;
ALTER TABLE sintomas ADD COLUMN IF NOT EXISTS temperatura numeric;

-- v30.12: Consultas médicas — fecha de la consulta, con qué médico, motivo,
-- foto de la receta (opcional) y la próxima cita (fecha o NULL = sin cita
-- programada).
CREATE TABLE IF NOT EXISTS consultas (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  fecha date NOT NULL,
  doctor_name text NOT NULL DEFAULT '',
  motivo text NOT NULL DEFAULT '',
  notas text NOT NULL DEFAULT '',
  next_appointment_date date,
  receta_data bytea,
  receta_mime text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consultas_patient ON consultas(patient_id, fecha DESC);

-- v30.13: Medicamentos eventuales — tomas fuera del plan de recordatorios
-- (aspirina, paracetamol, antiácidos, etc.), registradas sueltas, no
-- ligadas a un medicamento del catálogo ni a un horario. Se muestran junto
-- con las tomas programadas en la Bitácora de medicamentos (ver
-- listMedicationLog en db-postgres.js).
CREATE TABLE IF NOT EXISTS medicamentos_eventuales (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  nombre text NOT NULL,
  dosis text NOT NULL DEFAULT '',
  fecha date NOT NULL,
  hora time,
  notas text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_medicamentos_eventuales_patient ON medicamentos_eventuales(patient_id, fecha DESC);

-- ============================================================
-- v31
-- ============================================================

-- v31: hora de fin (además de la "hora" ya existente, que ahora se lee como
-- hora de INICIO) para calcular la duración total del ejercicio; el usuario
-- puede editarla a mano después de que se calculó sola. Métricas
-- especializadas por tipo de ejercicio (ver EXERCISE_METRIC_FIELDS_ en
-- common.js para saber cuáles aplican a cada tipo): distancia (carrera,
-- caminata, hiking, ciclismo, natación, elíptica), FC promedio durante el
-- ejercicio (la mayoría de las actividades), series/repeticiones/peso
-- levantado (pesas), y escalones (subir escaleras). Todas nullable: un
-- ejercicio se puede guardar sin ninguna métrica especializada.
ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS hora_fin time;
ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS distancia_km numeric;
ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS fc_promedio numeric;
ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS series integer;
ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS repeticiones integer;
ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS peso_levantado_kg numeric;
ALTER TABLE ejercicios ADD COLUMN IF NOT EXISTS escalones integer;

-- v31: lecturas de presión tomadas DURANTE actividad física (sección
-- Ejercicio) — deliberadamente una tabla separada de "lecturas" (reposo),
-- con su propio panel de captura y su propia gráfica, para no mezclar ambos
-- contextos ni alterar la gráfica/tabla principal de Presión Arterial.
CREATE TABLE IF NOT EXISTS lecturas_actividad_fisica (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  date date,
  time time,
  sys integer,
  dia integer,
  hr integer,
  obs text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lecturas_actividad_patient ON lecturas_actividad_fisica(patient_id);

-- v31: sección Wellness — actividades de relajación/ocio en reposo
-- (meditación, vapor, sauna, lectura/audiolibro en reposo, pintura, dibujo,
-- escritura, etc.; ver WELLNESS_CATALOG en common.js). Estructura idéntica a
-- "ejercicios" pero sin calorías (no son actividad física).
CREATE TABLE IF NOT EXISTS wellness_entries (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  duracion_min numeric,
  fecha date NOT NULL,
  hora time,
  notas text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wellness_patient ON wellness_entries(patient_id, fecha DESC);

-- v31: localización gráfica del dolor de cabeza (solo cuando sintomas.tipo =
-- 'dolor_cabeza'). Selección múltiple de zonas de la cabeza (ver
-- HEAD_PAIN_LOCATIONS en common.js) — deliberadamente solo ubicación, nunca
-- un nombre de tipo de dolor de cabeza ni un diagnóstico.
ALTER TABLE sintomas ADD COLUMN IF NOT EXISTS ubicaciones_dolor jsonb;

-- v31: "Relacionar con" — liga una lectura de presión (en reposo) con un
-- registro de otra sección (ejercicio, síntoma o wellness), para poder
-- identificarla en las gráficas con un color distinto. related_label es una
-- copia de texto (no una relación por llave foránea) para que la lectura
-- conserve el contexto aunque el registro relacionado se borre después.
ALTER TABLE lecturas ADD COLUMN IF NOT EXISTS related_type text;
ALTER TABLE lecturas ADD COLUMN IF NOT EXISTS related_id uuid;
ALTER TABLE lecturas ADD COLUMN IF NOT EXISTS related_label text;

-- ============================================================
-- v32
-- ============================================================

-- v32: sección Sueño — hora de inicio y de fin (la mayoría de los registros
-- cruzan la medianoche, ej. 23:00 a 07:00), duración total calculada sola
-- (mismo patrón que hora/hora_fin de ejercicios) pero editable a mano, y
-- calidad de sueño opcional en escala 1-10 (misma escala tipo "intensidad"
-- que ya se usa en Síntomas). fecha se guarda como la fecha en que INICIÓ el
-- sueño (la noche de referencia), no la fecha en que se despertó.
CREATE TABLE IF NOT EXISTS sueno (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  fecha date NOT NULL,
  hora_inicio time,
  hora_fin time,
  duracion_min numeric,
  calidad integer,
  notas text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sueno_patient ON sueno(patient_id, fecha DESC);

-- v32: interpretación con IA — exportación temporal de todas las capturas
-- del paciente (lecturas/PAM, sueño, ejercicio, malos hábitos, síntomas,
-- wellness, medicamentos/apego, historial de laboratorio, consultas) en un
-- solo JSON, expuesta por una liga de un solo uso repetido dentro de su
-- ventana de vigencia (no de un solo GET, para que la propia llamada del
-- servidor a la IA y cualquier verificación manual del paciente puedan
-- usarla mientras siga vigente). El token es opaco (uuid), no lleva datos
-- identificables del paciente en la URL, y expira típicamente 1 hora
-- después de creado — ver createAiExportToken/getAiExportPayload en
-- db-postgres.js.
CREATE TABLE IF NOT EXISTS ai_export_tokens (
  id uuid PRIMARY KEY,
  token text NOT NULL UNIQUE,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  period text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_export_tokens_patient ON ai_export_tokens(patient_id, created_at DESC);
-- v32.3: se guardan audiencia/profundidad junto con el token para que la
-- liga (/api/ai-export/:token) pueda devolver, junto con los datos, también
-- las instrucciones ya adaptadas al tono correcto — así el prompt de
-- copiar/pegar puede ser corto (solo la liga) en vez de traer todo el JSON
-- incrustado, lo cual causaba error 414 (URL demasiado larga) al abrir en
-- ChatGPT.
ALTER TABLE ai_export_tokens ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'paciente';
ALTER TABLE ai_export_tokens ADD COLUMN IF NOT EXISTS profundidad text NOT NULL DEFAULT 'profunda';

-- v32: historial de interpretaciones generadas por IA (texto de respuesta,
-- para no tener que volver a llamar a la IA solo para reabrir la pantalla).
-- export_token queda guardado como referencia/auditoría aunque ya haya
-- expirado.
CREATE TABLE IF NOT EXISTS ai_interpretations (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  period text NOT NULL,
  export_token text,
  response_text text NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_interpretations_patient ON ai_interpretations(patient_id, created_at DESC);

-- v33: Metas — objetivos con fecha límite, opcionalmente ligados a un evento
-- (texto libre, ej. "Boda", "Vacaciones de verano"), que pueden dar
-- seguimiento a uno o varios indicadores a la vez. Cada indicador dentro de
-- una meta vive en su propia fila (meta_indicadores) con su propio modo
-- (reducir/aumentar una cantidad, o un valor manual específico) — así cada
-- uno se configura por separado aunque compartan la misma fecha límite y
-- evento. valor_base es el valor del indicador al momento de crear la meta
-- (el punto de partida) y valor_objetivo es siempre el número final ya
-- resuelto (calculado a partir de valor_base+cantidad si el modo es
-- reducir/aumentar, o copiado directo si es manual) — esto deja el cálculo
-- de progreso simple en cualquier momento: no hay que volver a interpretar
-- "modo" para saber hacia dónde va el número.
CREATE TABLE IF NOT EXISTS metas (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  evento text NOT NULL DEFAULT '',
  fecha_limite date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metas_patient ON metas(patient_id, fecha_limite);
CREATE TABLE IF NOT EXISTS meta_indicadores (
  id uuid PRIMARY KEY,
  meta_id uuid NOT NULL REFERENCES metas(id) ON DELETE CASCADE,
  indicador text NOT NULL,
  modo text NOT NULL DEFAULT 'manual',
  cantidad numeric,
  valor_base numeric,
  valor_objetivo numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meta_indicadores_meta ON meta_indicadores(meta_id);

-- v33.3: nota diaria generada por la IA interna para la caja de "Alertas y
-- notas" de Presión Arterial. Se genera perezosamente (no con un cron) la
-- primera vez que el paciente abre la app cada día — así nunca se gastan
-- tokens de la cuenta de Anthropic en un día que el paciente no entra. Solo
-- se guarda la nota del día actual (no historial): basta con la fecha para
-- saber si sigue vigente o hay que regenerarla.
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS daily_ai_note text;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS daily_ai_note_date date;

-- v33.4: permite forzar la regeneración de la nota diaria a mano, con un
-- límite de 2 veces por ventana de 24 horas (rolling, no por día de
-- calendario) para no disparar el gasto de tokens. daily_ai_note_manual_count
-- cuenta cuántas veces se ha forzado DENTRO de la ventana actual; cuando pasan
-- 24h desde daily_ai_note_manual_window_start, la ventana se reinicia sola.
-- Esto es independiente del contador de la generación automática al abrir la
-- app, que no tiene límite.
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS daily_ai_note_manual_count integer NOT NULL DEFAULT 0;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS daily_ai_note_manual_window_start timestamptz;

-- v35.4: historial de las frases célebres con las que la nota diaria ha
-- cerrado antes (ver AI_DAILY_NOTE_SYSTEM_), para que la IA nunca repita una
-- ya usada con este paciente. Guarda objetos {quote, author} en jsonb, más
-- reciente al final; se topa a un máximo razonable (ver
-- AI_DAILY_NOTE_QUOTE_HISTORY_MAX_ en db-postgres.js) para no inflar el
-- prompt sin necesidad — hay muchísimas más frases genuinas disponibles que
-- ese tope, así que nunca se vuelve el cuello de botella real.
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS daily_ai_note_quote_history jsonb NOT NULL DEFAULT '[]'::jsonb;

-- v34.2: "Situación especial" en una lectura de presión — checkbox + nota
-- libre opcional para marcar que la lectura ocurrió en un contexto fuera de
-- lo cotidiano (ej. "Viaje a la playa", "Boda de mi hermana"), para poder
-- identificarla luego en la gráfica de Tendencia (color distinto, ver
-- SPECIAL_POINT_COLOR_ en common.js) y en el Historial de lecturas. Es un
-- campo independiente de "Relacionar con" (v31): ese liga con otro registro
-- de la app (ejercicio/síntoma/wellness); este es solo una nota de contexto
-- libre que el paciente escribe él mismo.
ALTER TABLE lecturas ADD COLUMN IF NOT EXISTS special_situation boolean NOT NULL DEFAULT false;
ALTER TABLE lecturas ADD COLUMN IF NOT EXISTS special_situation_note text;

-- v34.3: "Interpretación con IA" (Estadísticas) ahora deja elegir una
-- categoría específica en vez de analizar siempre todas las secciones a la
-- vez (ver AI_CATEGORY_LABELS_ en db-postgres.js). category viaja junto con
-- period/audience/profundidad en el mismo token, para que la liga temporal
-- (/api/ai-export/:token) sepa qué payload armar sin tener que volver a
-- preguntar.
ALTER TABLE ai_export_tokens ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general';

-- v34.4: "plan" del paciente, primer paso de un modelo SaaSificado
-- (activar/desactivar funciones por plan) para la nueva sección de
-- "Pregunta libre" con IA en Estadísticas, que en su momento será de paga.
-- Por ahora, mientras no exista un flujo de cobro real, TODOS los pacientes
-- se crean en 'pro' (acceso completo) — ver PLAN_FEATURES_/planHasFeature_
-- en db-postgres.js, que ya valida el entitlement en el servidor (no solo en
-- el cliente) para que baste con cambiar el default aquí y agregar un flujo
-- de cobro más adelante, sin tocar la lógica de la función en sí.
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'pro';

-- v35.0: Métricas personalizadas — el propio paciente diseña hasta 5
-- métricas propias (ej. "Días sin alcohol", "Pasos caminados", "Glucosa"),
-- cada una con sus propios campos de captura (número con unidad, sí/no,
-- escala 1-10 o texto libre), armados en un diseñador de arrastrar y soltar
-- en el cliente. "fields" guarda la lista de campos como jsonb en vez de
-- columnas fijas, porque cada paciente define una forma distinta — el tope
-- de 5 métricas y de campos por métrica se valida en la aplicación (ver
-- MAX_CUSTOM_METRICS_/MAX_CUSTOM_METRIC_FIELDS_ en db-postgres.js), no aquí,
-- para poder ajustarlo sin migrar el esquema. Cada campo dentro de "fields"
-- tiene la forma { key, type, label, unit?, required, order }, con type en
-- "number" | "boolean" | "scale" | "text".
CREATE TABLE IF NOT EXISTS custom_metrics (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  name text NOT NULL,
  icon text NOT NULL DEFAULT '📊',
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_metrics_patient ON custom_metrics(patient_id, order_index);

-- Un registro por fecha (puede haber varios el mismo día, igual que
-- lecturas/sueño/ejercicio) con los valores capturados para esa métrica.
-- field_values es un objeto { <field.key>: valor }, con el tipo de cada
-- valor según el tipo de su campo (number → numeric, boolean → true/false,
-- scale → entero 1-10, text → string). No se usa el nombre "values" a
-- secas porque es palabra reservada en SQL.
CREATE TABLE IF NOT EXISTS custom_metric_entries (
  id uuid PRIMARY KEY,
  metric_id uuid NOT NULL REFERENCES custom_metrics(id) ON DELETE CASCADE,
  date date NOT NULL,
  field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_metric_entries_metric ON custom_metric_entries(metric_id, date);

-- v35.23: Ayuno intermitente — el paciente registra la hora de su última
-- comida (inicia el ayuno) y, cuando vuelve a comer, la hora en que lo
-- rompió y con qué (para poder ver qué tanto se sostiene el patrón y qué
-- tan seguido rompe con algo pesado). fecha_fin/hora_fin quedan NULL
-- mientras el ayuno sigue "abierto" (en curso) — solo puede haber UN ayuno
-- abierto por paciente a la vez, eso se valida en la aplicación, no aquí.
-- A diferencia de sueño/ejercicio (que solo usan "time" porque nunca duran
-- más de ~24h), aquí se guardan fecha Y hora por separado tanto para inicio
-- como para fin, porque un ayuno sí puede cruzar varios días (ayunos
-- prolongados) y la duración se calcula con la fecha+hora completas, no
-- solo con la diferencia de horas (ver computeAyunoDurationHoras_ en
-- db-postgres.js).
CREATE TABLE IF NOT EXISTS ayunos (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES pacientes(id) ON DELETE CASCADE,
  fecha_inicio date NOT NULL,
  hora_inicio time NOT NULL,
  fecha_fin date,
  hora_fin time,
  duracion_horas numeric,
  rompio_con text DEFAULT '',
  notas text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ayunos_patient ON ayunos(patient_id, fecha_inicio DESC);

-- Meta de horas de ayuno (ej. 16 para un esquema 16:8) — un solo valor por
-- paciente, igual de simple que weight/height/waist; se compara contra
-- duracion_horas de cada ayuno cerrado para la racha de "metas cumplidas".
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS ayuno_meta_horas numeric;
