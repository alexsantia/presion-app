// Utilidades compartidas entre las vistas de paciente, médico y familia de
// Reigning Blood Pressure App. Sin dependencias, solo funciones puras y
// constantes, para que cada página las use como necesite.

// ---- Categorías de presión (AHA 2017) ----
function classify(sys, dia) {
  if (sys >= 180 || dia >= 120) return { label: "Crisis hipertensiva", key: "crisis" };
  if (sys >= 140 || dia >= 90) return { label: "Hipertensión etapa 2", key: "etapa2" };
  if (sys >= 130 || dia >= 80) return { label: "Hipertensión etapa 1", key: "etapa1" };
  if (sys >= 120 && dia < 80) return { label: "Elevada", key: "elevada" };
  return { label: "Normal", key: "normal" };
}
const categoryColors = { normal: "#6FA98C", elevada: "#D8AE5C", etapa1: "#D98E5F", etapa2: "#C97064", crisis: "#A6534B" };

// ---- Nombre del antihipertensivo (marca + mg capturados en Parámetros),
// usado en el checkbox, la tabla y la leyenda de la gráfica. Si el paciente
// no ha capturado marca/mg todavía, cae a un nombre genérico. ----
function medicationName(account) {
  const brand = account && account.med_brand ? String(account.med_brand).trim() : "";
  const mg = account && account.med_mg != null && account.med_mg !== "" ? account.med_mg : null;
  if (!brand) return "medicamento";
  return mg != null ? `${brand} ${mg}mg` : brand;
}

function fmtDate(d) {
  const [y, m, day] = d.split("-");
  return `${day}/${m}`;
}

// Fecha en formato YYYY-MM-DD según la hora LOCAL del dispositivo (no UTC).
// Usar toISOString() aquí sería un error: en husos horarios negativos (como
// México, UTC-6) puede adelantar o atrasar la fecha un día según la hora,
// lo que hacía que el filtro "Día" no siempre mostrara el día correcto. No
// hace falta geolocalizar por IP para esto — el navegador ya conoce el huso
// horario local del dispositivo, que es más simple, privado y confiable que
// una consulta de geolocalización por IP (que además falla con VPNs).
function localDateStr_(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr() { return localDateStr_(new Date()); }

function calcAge(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate + (String(birthdate).length === 10 ? "T00:00:00" : ""));
  if (isNaN(b.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - b.getFullYear();
  const m = today.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < b.getDate())) age--;
  return age;
}

// ---- Agregación de lecturas para la gráfica (hora / día / semana / mes / año) ----
const MONTH_ABBR_ES_ = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function periodKeyAndLabel_(dateStr, granularity, timeStr) {
  if (granularity === "hour") {
    const hh = String((timeStr || "00:00").split(":")[0]).padStart(2, "0");
    const key = `${dateStr} ${hh}`;
    return { key, label: `${hh}:00` };
  }
  if (granularity === "week") {
    const d = new Date(dateStr + "T00:00:00");
    const dow = (d.getDay() + 6) % 7; // lunes = 0
    d.setDate(d.getDate() - dow);
    const key = localDateStr_(d);
    return { key, label: fmtDate(key) };
  }
  if (granularity === "month") {
    const key = dateStr.slice(0, 7);
    const [y, m] = key.split("-");
    return { key, label: `${MONTH_ABBR_ES_[Number(m) - 1]} ${y}` };
  }
  if (granularity === "year") {
    const key = dateStr.slice(0, 4);
    return { key, label: key };
  }
  return { key: dateStr, label: fmtDate(dateStr) }; // "day" (por defecto)
}
// Agrupa lecturas por periodo y promedia sys/dia/hr/weight dentro de cada
// grupo (ignorando valores nulos). Devuelve los grupos ordenados
// cronológicamente. granularity: "hour" | "day" | "week" | "month" | "year".
function aggregateReadings(data, granularity) {
  const groups = new Map();
  (data || []).forEach(r => {
    const { key, label } = periodKeyAndLabel_(r.date, granularity || "day", r.time);
    if (!groups.has(key)) groups.set(key, { key, label, sys: [], dia: [], hr: [], weight: [], medicated: [], obs: [] });
    const g = groups.get(key);
    if (r.sys != null) g.sys.push(r.sys);
    if (r.dia != null) g.dia.push(r.dia);
    if (r.hr != null) g.hr.push(r.hr);
    if (r.weight != null) g.weight.push(r.weight);
    g.medicated.push(r.medicated ? 1 : 0);
    if (r.obs && String(r.obs).trim()) g.obs.push(String(r.obs).trim());
  });
  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return Array.from(groups.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(g => ({ key: g.key, label: g.label, sys: avg(g.sys), dia: avg(g.dia), hr: avg(g.hr), weight: avg(g.weight), medicated: avg(g.medicated), obs: g.obs.join(" · "), count: Math.max(g.sys.length, g.dia.length) }));
}
// Convierte cada lectura en un punto individual para la gráfica (sin
// agrupar ni promediar), ordenado cronológicamente y con el eje X mostrando
// fecha + hora exacta de cada medición.
function rawSeriesForChart(data) {
  return [...(data || [])]
    .sort((a, b) => (a.date + "T" + a.time).localeCompare(b.date + "T" + b.time))
    .map(r => ({
      key: r.date + "T" + r.time,
      label: `${fmtDate(r.date)} ${r.time}`,
      sys: r.sys ?? null, dia: r.dia ?? null, hr: r.hr ?? null, weight: r.weight ?? null,
      medicated: r.medicated ? 1 : 0,
      obs: r.obs ? String(r.obs).trim() : "",
      count: 1,
    }));
}
// Vista por horario del día, independiente del filtro de periodo: acota las
// lecturas a la franja de horas elegida antes de agregarlas/graficarlas.
// "noche" cruza la medianoche (19:01 a 01:00), por eso usa OR en vez de AND.
function filterByTimeView(data, timeView) {
  const list = data || [];
  if (!timeView || timeView === "regular") return list.slice();
  return list.filter(r => {
    const t = r.time || "00:00";
    if (timeView === "manana") return t >= "05:00" && t <= "12:00";
    if (timeView === "tarde") return t > "12:00" && t <= "19:00";
    if (timeView === "noche") return t > "19:00" || t <= "01:00";
    if (timeView === "madrugada") return t > "01:00" && t <= "04:59";
    return true;
  });
}
// Para la gráfica de Tendencia:
// - "día": pide una fecha concreta (por defecto hoy), se acota a esas 24
//   horas y el eje X agrupa por hora.
// - "semana"/"mes"/"año": se acota a los últimos 7/30/365 días desde hoy,
//   pero el eje X muestra cada medición individual con su fecha y hora
//   (sin agrupar ni promediar).
// timeView (opcional): "regular" | "manana" | "tarde" | "noche" | "madrugada"
// — filtra además por franja horaria, combinable con cualquier chartPeriod.
function chartDataForFilter(data, chartPeriod, selectedDay, timeView) {
  if (chartPeriod === "day") {
    const day = selectedDay || todayStr();
    let filtered = (data || []).filter(r => r.date === day);
    filtered = filterByTimeView(filtered, timeView);
    return aggregateReadings(filtered, "hour");
  }
  let filtered = filterByPeriod(data, chartPeriod);
  filtered = filterByTimeView(filtered, timeView);
  return rawSeriesForChart(filtered);
}

// Callbacks del tooltip de Chart.js para la gráfica de Tendencia, compartidos
// por las 3 vistas. Dos ajustes sobre el tooltip por default: (1) la línea
// de "Medicado" muestra Sí/No (o el % de adherencia si el punto es un
// promedio de varias lecturas agrupadas) en vez del 1/0 crudo que Chart.js
// mostraría por default; (2) se agregan las observaciones de esa fecha/hora
// al pie del tooltip, para poder contextualizar la medición de un vistazo
// sin tener que ir a buscarla en la tabla.
function chartTooltipCallbacks(grouped) {
  return {
    label(context) {
      const dsLabel = context.dataset.label || "";
      const v = context.parsed.y;
      if (context.dataset.yAxisID === "y3") {
        if (v == null) return `${dsLabel}: sin dato`;
        if (v >= 0.995) return `${dsLabel}: Sí`;
        if (v <= 0.005) return `${dsLabel}: No`;
        return `${dsLabel}: ${Math.round(v * 100)}% de las lecturas`;
      }
      return `${dsLabel}: ${v == null ? "sin dato" : v}`;
    },
    footer(tooltipItems) {
      if (!tooltipItems || !tooltipItems.length) return [];
      const point = grouped[tooltipItems[0].dataIndex];
      return point && point.obs ? ["📝 " + point.obs] : [];
    },
  };
}

// ---- Paginación genérica ----
function paginateData(data, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil((data || []).length / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return { pageData: (data || []).slice(start, start + pageSize), page: p, totalPages };
}

// ---- Análisis con IA: filtrar por periodo y armar el prompt a copiar ----
const AI_PERIOD_LABELS = {
  day: "el día de hoy",
  week: "la última semana",
  month: "el último mes",
  quarter: "el último trimestre",
  year: "el último año",
  all: "todo el historial disponible",
};
function filterByPeriod(data, granularity) {
  const list = data || [];
  if (granularity === "all" || !granularity) return list.slice();
  const daysMap = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };
  const days = daysMap[granularity];
  if (!days) return list.slice();
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = localDateStr_(cutoff);
  return list.filter(r => r.date >= cutoffStr);
}
// meta: { patientName, firstName, ageText, granularity, audience }
// audience: "doctor" (habla de "el paciente [Nombre completo], de X años"),
// "family" (habla de "[Primer nombre]") o "patient" (le habla de tú
// directamente al propio paciente). El prompt completo se redacta en
// tercera persona (salvo "patient", que es en segunda persona), para que
// quien lo pegue en un chat de IA no tenga que reescribirlo.
function buildAiAnalysisPrompt(data, meta) {
  meta = meta || {};
  const filtered = data || [];
  const periodLabel = AI_PERIOD_LABELS[meta.granularity] || "el periodo seleccionado";
  const isDoctor = meta.audience === "doctor";
  const isPatient = meta.audience === "patient";
  const firstName = meta.firstName || meta.patientName || "";
  const subject = isDoctor
    ? `el paciente ${meta.patientName || "sin nombre registrado"}${meta.ageText ? ", de " + meta.ageText : ""}`
    : isPatient
      ? `ti${meta.ageText ? " (" + meta.ageText + ")" : ""}`
      : `${firstName || "el paciente"}${meta.ageText ? ", de " + meta.ageText : ""}`;
  const subjectShort = isDoctor ? "el paciente" : (meta.firstName || "la persona");

  if (!filtered.length) {
    return isPatient
      ? `No tienes lecturas registradas para ${periodLabel}. Elige otro periodo o registra una lectura primero.`
      : `No hay lecturas registradas para ${periodLabel} de ${subject}. Elige otro periodo o registra lecturas primero.`;
  }
  const sorted = [...filtered].sort((a, b) => (a.date + "T" + a.time).localeCompare(b.date + "T" + b.time));
  const sysVals = sorted.map(r => r.sys).filter(v => v != null);
  const diaVals = sorted.map(r => r.dia).filter(v => v != null);
  const hrVals = sorted.filter(r => r.hr != null).map(r => r.hr);
  const withWeight = sorted.filter(r => r.weight != null);
  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  const maxSysReading = sorted.reduce((m, r) => (m == null || r.sys > m.sys) ? r : m, null);
  const minSysReading = sorted.reduce((m, r) => (m == null || r.sys < m.sys) ? r : m, null);
  const counts = {};
  sorted.forEach(r => { const k = classify(r.sys, r.dia).key; counts[k] = (counts[k] || 0) + 1; });
  const countsText = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
  const medicatedCount = sorted.filter(r => r.medicated).length;
  const adherencePct = Math.round((medicatedCount / sorted.length) * 100);

  let text = "Este texto es un prompt preparado para que lo interprete un asistente de inteligencia artificial (como ChatGPT, Gemini u otro) y entregue un resumen útil a partir de datos reales de presión arterial. Pégalo tal cual en tu chat de IA de preferencia.\n\n";
  text += isDoctor
    ? `Actúa como si estuvieras preparando, para un médico, un resumen clínico breve y en lenguaje formal (español) sobre ${subject}. Los siguientes datos de presión arterial, frecuencia cardiaca y peso fueron registrados en Reigning Blood Pressure App.\n\n`
    : isPatient
      ? `Actúa como si le estuvieras explicando directamente a ${firstName || "la persona que registró estos datos"} (hablándole de tú, en segunda persona) cómo ha estado su propia salud, con calidez y lenguaje sencillo y cotidiano. Los siguientes datos de presión arterial, frecuencia cardiaca y peso fueron registrados en Reigning Blood Pressure App.\n\n`
      : `Actúa como si le estuvieras explicando a un familiar o amigo sin conocimientos médicos cómo va la salud de ${subject}, con palabras sencillas y cotidianas. Los siguientes datos de presión arterial, frecuencia cardiaca y peso fueron registrados en Reigning Blood Pressure App.\n\n`;
  text += `Periodo analizado: ${periodLabel}\n`;
  text += `Total de lecturas en este periodo: ${sorted.length}\n\n`;
  text += "Resumen:\n";
  text += `- Presión arterial promedio: ${avg(sysVals)}/${avg(diaVals)} mmHg\n`;
  if (maxSysReading) text += `- Lectura más alta: ${maxSysReading.sys}/${maxSysReading.dia} mmHg (${fmtDate(maxSysReading.date)})\n`;
  if (minSysReading) text += `- Lectura más baja: ${minSysReading.sys}/${minSysReading.dia} mmHg (${fmtDate(minSysReading.date)})\n`;
  text += `- Frecuencia cardiaca promedio: ${hrVals.length ? avg(hrVals) + " FC" : "sin datos"}\n`;
  text += `- Peso: ${withWeight.length ? "promedio " + avg(withWeight.map(r => r.weight)) + " kg, último registrado " + withWeight[withWeight.length - 1].weight + " kg" : "sin datos"}\n`;
  text += `- Distribución por categoría (guía AHA 2017): ${countsText}\n`;
  text += `- Adherencia al medicamento antihipertensivo: ${medicatedCount}/${sorted.length} lecturas registradas con medicamento tomado (${adherencePct}%)\n\n`;
  text += "Detalle de lecturas:\n";
  sorted.forEach(r => {
    text += `${fmtDate(r.date)} ${r.time} — ${r.sys}/${r.dia} mmHg${r.hr != null ? ", " + r.hr + " FC" : ""}${r.weight != null ? ", " + r.weight + " kg" : ""}${r.medicated ? ", medicado" : ", sin medicamento registrado"}${r.obs ? " — " + r.obs : ""}\n`;
  });

  if (isDoctor) {
    text += `\nCon esta información, redacta un RESUMEN CLÍNICO que el médico pueda leer en menos de 40 segundos (aproximadamente 80 a 110 palabras). Debe incluir: clasificación de la presión arterial según la guía AHA 2017, tendencia general (mejora, estable o empeora), frecuencia cardiaca y peso si son relevantes, adherencia al tratamiento antihipertensivo, y una sola línea de alerta si hay lecturas en etapa 2 o crisis hipertensiva. Usa terminología médica apropiada, tono formal y directo, sin rodeos ni frases de cortesía. Cierra con una línea breve invitando a revisar el detalle completo de las lecturas incluido arriba si se desea profundizar. Aclara que esto no sustituye la valoración clínica directa del paciente. Termina tu respuesta preguntando si el lector desea profundizar en algún punto del análisis o tiene alguna duda específica sobre el resumen brindado.`;
  } else if (isPatient) {
    text += `\nCon esta información, escribe un resumen breve y cálido dirigido directamente a ${firstName || "la persona"}, hablándole de tú en todo momento (segunda persona), que resalte los datos más importantes (cómo ha estado su presión, si se ha estado cuidando con su medicamento, y cómo va su peso), y que aclare con claridad qué tan bien o mal va todo. Empieza tu respuesta con un saludo breve y personal, por ejemplo "Hola ${firstName || "[nombre]"}, aquí tienes tu análisis:", seguido del resumen. Usa lenguaje cotidiano y cercano; si necesitas mencionar algún término médico, explícalo en palabras simples entre paréntesis. Aclara al final que esto no sustituye una consulta médica profesional. Termina tu respuesta preguntando si quiere profundizar en algún punto del análisis o si tiene alguna duda específica sobre el resumen brindado.`;
  } else {
    text += `\nCon esta información, escribe un resumen breve, cálido y fácil de entender para alguien sin conocimientos médicos, que resalte los datos más importantes (cómo ha estado la presión, si ${subjectShort === "el paciente" ? "el paciente" : subjectShort} se ha estado cuidando con su medicamento, y cómo va su peso), y que aclare con claridad qué tan bien o mal va todo. Usa lenguaje cotidiano y cercano; si necesitas mencionar algún término médico, explícalo en palabras simples entre paréntesis. Aclara al final que esto no sustituye una consulta médica profesional. Termina tu respuesta preguntando si el lector desea profundizar en algún punto del análisis o tiene alguna duda específica sobre el resumen brindado.`;
  }
  return text;
}

// ---- Racha de días consecutivos con al menos una lectura ----
function computeStreak(dateStrings) {
  const unique = [...new Set(dateStrings)].sort();
  if (!unique.length) return { current: 0, longest: 0 };
  const toDate = s => new Date(s + "T00:00:00");
  const dayDiff = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);

  let longest = 1, run = 1;
  for (let i = 1; i < unique.length; i++) {
    run = dayDiff(unique[i - 1], unique[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const todayStr = localDateStr_(new Date());
  const last = unique[unique.length - 1];
  let current = 0;
  if (dayDiff(last, todayStr) <= 1) {
    current = 1;
    for (let i = unique.length - 1; i > 0; i--) {
      if (dayDiff(unique[i - 1], unique[i]) === 1) current++;
      else break;
    }
  }
  return { current, longest };
}

// ---- Niveles de gamificación (temática "reino/corona", acorde al nombre
// de la app) ----
const LEVELS = [
  { min: 1, max: 3, name: "Heredero del Pulso", icon: "🤴", bg: "#EAF3EC", fg: "#4F7A6F",
    concept: "El inicio del camino. Estás tomando el control, conociendo tus números básicos y reclamando tu derecho a una vida saludable. Es el primer paso para construir tu reino." },
  { min: 4, max: 7, name: "Guardián del Trono", icon: "🛡️", bg: "#E4EEFB", fg: "#3E6FA0",
    concept: "Ya le estás echando ganas reales. Lograr mantener la constancia durante una semana completa significa que estás protegiendo tu rutina diaria con paso firme y defendiendo tu salud." },
  { min: 8, max: 21, name: "Protector del Reino", icon: "🏰", bg: "#EFE9F7", fg: "#6B4FA0",
    concept: "Disciplina avanzada. Llevar semanas midiendo tus latidos y tu presión demuestra un blindaje y una constancia madura. Tu salud está bajo un control absoluto y seguro." },
  { min: 22, max: Infinity, name: "Rey de la Presión", icon: "👑", bg: "#33403D", fg: "#FFFFFF",
    concept: "El grado máximo de soberanía. Has alcanzado la cumbre del autocuidado y la constancia. Los niveles ya no gobiernan tu vida; tú gobiernas tu salud con absoluta sabiduría y orgullo." },
];
function getLevel(streakDays) {
  if (!streakDays || streakDays < 1) return null;
  return LEVELS.find(l => streakDays >= l.min && streakDays <= l.max) || LEVELS[LEVELS.length - 1];
}
function levelRangeLabel_(l) {
  return l.max === Infinity ? `${l.min}+ días de racha` : `${l.min}–${l.max} días de racha`;
}

// ---- Tooltips de nivel: inyecta su CSS una sola vez y delega los eventos
// de click/tap (además del :hover nativo) para que también funcione en
// móvil, donde no hay hover real. ----
function ensureLevelTooltipStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-lvl-tooltip-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-lvl-tooltip-styles";
  style.textContent = `
    .lvl-ladder { display:flex; gap:10px; margin-top:14px; flex-wrap:wrap; }
    .lvl-badge { position:relative; border:none; cursor:pointer; width:42px; height:42px; border-radius:50%;
      background:var(--lvl-bg); color:var(--lvl-fg); font-size:19px; display:flex; align-items:center;
      justify-content:center; opacity:0.45; transform:scale(0.9); transition:opacity .15s ease, transform .15s ease; padding:0; }
    .lvl-badge.achieved { opacity:0.8; }
    .lvl-badge.current { opacity:1; transform:scale(1.08); box-shadow:0 0 0 3px var(--lvl-bg), 0 2px 6px rgba(0,0,0,0.18); }
    .lvl-badge:hover, .lvl-badge:focus-visible { opacity:1; outline:none; }
    .lvl-badge .lvl-tooltip { visibility:hidden; opacity:0; position:absolute; bottom:calc(100% + 10px); left:50%;
      transform:translateX(-50%) translateY(4px); background:#2B3532; color:#fff; padding:10px 12px; border-radius:10px;
      font-size:12px; line-height:1.45; width:210px; text-align:left; box-shadow:0 4px 14px rgba(0,0,0,0.2);
      transition:opacity .15s ease, transform .15s ease; z-index:20; pointer-events:none; }
    .lvl-badge .lvl-tooltip strong { display:block; font-size:12.5px; margin-bottom:4px; }
    .lvl-badge .lvl-tooltip .lvl-range { display:block; opacity:0.7; font-size:11px; margin-bottom:4px; }
    .lvl-badge:hover .lvl-tooltip, .lvl-badge.tt-open .lvl-tooltip { visibility:visible; opacity:1; transform:translateX(-50%) translateY(0); }
    .lvl-badge .lvl-tooltip::after { content:""; position:absolute; top:100%; left:50%; transform:translateX(-50%);
      border:6px solid transparent; border-top-color:#2B3532; }
  `;
  document.head.appendChild(style);
  wireLevelTooltips_();
}
function wireLevelTooltips_() {
  if (typeof document === "undefined" || wireLevelTooltips_._wired) return;
  wireLevelTooltips_._wired = true;
  document.addEventListener("click", (e) => {
    const badge = e.target.closest(".lvl-badge");
    document.querySelectorAll(".lvl-badge.tt-open").forEach(b => { if (b !== badge) b.classList.remove("tt-open"); });
    if (!badge) return;
    e.preventDefault();
    const willOpen = !badge.classList.contains("tt-open");
    badge.classList.toggle("tt-open", willOpen);
    badge.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      const tip = badge.querySelector(".lvl-tooltip");
      if (tip) {
        tip.style.transform = "translateX(-50%) translateY(0)";
        const rect = tip.getBoundingClientRect();
        const overflowRight = rect.right - window.innerWidth + 8;
        const overflowLeft = -rect.left + 8;
        if (overflowRight > 0) tip.style.transform = `translateX(calc(-50% - ${overflowRight}px)) translateY(0)`;
        else if (overflowLeft > 0) tip.style.transform = `translateX(calc(-50% + ${overflowLeft}px)) translateY(0)`;
      }
    }
  });
}
function levelLadderHTML(currentDays) {
  ensureLevelTooltipStyles_();
  const items = LEVELS.map(l => {
    const state = currentDays >= l.min && currentDays <= l.max ? "current" : (currentDays > l.max ? "achieved" : "locked");
    return `<button type="button" class="lvl-badge ${state}" style="--lvl-bg:${l.bg}; --lvl-fg:${l.fg};"
        aria-label="${l.name}, ${levelRangeLabel_(l)}" aria-expanded="false">
      <span class="lvl-icon" aria-hidden="true">${l.icon}</span>
      <span class="lvl-tooltip" role="tooltip">
        <strong>${l.icon} ${l.name}</strong>
        <span class="lvl-range">${levelRangeLabel_(l)}</span>
        <span class="lvl-concept">${l.concept}</span>
      </span>
    </button>`;
  }).join("");
  return `<div class="lvl-ladder">${items}</div>`;
}

function streakLevelHTML(streak) {
  const level = getLevel(streak.current);
  const levelHtml = level
    ? `<div style="display:flex; align-items:center; gap:10px; background:${level.bg}; color:${level.fg}; border-radius:12px; padding:12px 16px;">
         <div style="font-size:26px; line-height:1;">${level.icon}</div>
         <div>
           <div style="font-weight:650; font-size:14px;">${level.name}</div>
           <div style="font-size:12px; opacity:0.85;">${level.concept}</div>
         </div>
       </div>`
    : `<div style="color:var(--text-muted); font-size:13px;">Registra tu primera lectura para empezar tu racha.</div>`;
  return `
    <div>
      <div style="display:flex; gap:14px; align-items:stretch; flex-wrap:wrap;">
        <div class="card" style="flex:0 0 auto; min-width:130px; display:flex; flex-direction:column; justify-content:center; align-items:center;">
          <div style="font-size:26px;">🔥</div>
          <div style="font-size:22px; font-weight:650;">${streak.current}</div>
          <div style="font-size:11px; color:var(--text-muted);">día${streak.current === 1 ? "" : "s"} seguidos</div>
          ${streak.longest > streak.current ? `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">récord: ${streak.longest}</div>` : ""}
        </div>
        <div style="flex:1; min-width:220px;">${levelHtml}</div>
      </div>
      ${levelLadderHTML(streak.current)}
    </div>`;
}

// ---- Utilidades varias ----
function escapeHtml_(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtTimeOnly(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}
function fmtRelativeShort(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr} h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `hace ${diffDay} d`;
  return fmtDate(localDateStr_(d));
}

// ---- Feed de comentarios por día (v18) ----
// Los comentarios (de médico o de paciente) se agrupan por día local y se
// arman en hilos: cada comentario de nivel superior con sus respuestas
// anidadas debajo, en orden cronológico. Se usa tanto en doctor.html como
// en index.html.
function commentDateStr(comment) {
  const d = comment && comment.created_at ? new Date(comment.created_at) : null;
  return d && !isNaN(d) ? localDateStr_(d) : "";
}
function commentDaysWithActivity(comments) {
  return [...new Set((comments || []).map(commentDateStr))].filter(Boolean).sort();
}
// El día más reciente con comentarios, o hoy si todavía no hay ninguno.
function mostRecentCommentDay(comments) {
  const days = commentDaysWithActivity(comments);
  return days.length ? days[days.length - 1] : todayStr();
}
function threadCommentsForDay(comments, dateStr) {
  const dayComments = (comments || []).filter(c => commentDateStr(c) === dateStr);
  const byId = {};
  dayComments.forEach(c => { byId[c.id] = Object.assign({}, c, { replies: [] }); });
  const topLevel = [];
  dayComments.forEach(c => {
    const node = byId[c.id];
    if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(node);
    else topLevel.push(node);
  });
  topLevel.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const sortReplies = list => {
    list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    list.forEach(n => sortReplies(n.replies));
  };
  topLevel.forEach(t => sortReplies(t.replies));
  return topLevel;
}
// opts: { viewerRole, viewerId, canReply(comment) => bool, reactionsGrouped
// (ver groupReactionsByTarget) } — si se pasa reactionsGrouped, cada
// comentario incluye su barra de reacciones (v26).
function renderCommentThreadHTML(nodes, opts) {
  opts = opts || {};
  return (nodes || []).map(c => {
    const isSelf = opts.viewerRole && c.author_role === opts.viewerRole && String(c.author_id) === String(opts.viewerId);
    const authorLabel = isSelf ? "Tú" : (c.author || (c.author_role === "doctor" ? "Médico" : "Paciente"));
    const roleClass = c.author_role === "doctor" ? "comment-role-doctor" : "comment-role-patient";
    const canReply = typeof opts.canReply === "function" ? !!opts.canReply(c) : false;
    const replyBtn = canReply ? `<button type="button" class="btn-mini comment-reply-btn" data-reply-to="${c.id}">Responder</button>` : "";
    const reactionBar = opts.reactionsGrouped
      ? renderReactionBarHTML("comment", c.id, reactionsForTarget(opts.reactionsGrouped, "comment", c.id), { viewerRole: opts.viewerRole, viewerId: opts.viewerId })
      : "";
    const childrenHtml = c.replies && c.replies.length ? `<div class="comment-replies">${renderCommentThreadHTML(c.replies, opts)}</div>` : "";
    return `
      <div class="comment-node ${roleClass}" data-comment-id="${c.id}">
        <div class="comment-meta"><strong>${escapeHtml_(authorLabel)}</strong> · ${fmtTimeOnly(c.created_at)}</div>
        <div class="comment-text">${escapeHtml_(c.text)}</div>
        ${reactionBar}
        <div class="comment-actions">${replyBtn}</div>
        <div class="comment-reply-box" id="replyBox_${c.id}" style="display:none;"></div>
        ${childrenHtml}
      </div>`;
  }).join("");
}
function replyBoxHTML(parentId) {
  return `<textarea class="comment-reply-input" rows="2" placeholder="Escribe tu respuesta…"></textarea>
    <div class="comment-reply-actions">
      <button type="button" class="btn-mini comment-reply-send" data-parent-id="${parentId}">Enviar</button>
      <button type="button" class="btn-mini comment-reply-cancel" data-parent-id="${parentId}">Cancelar</button>
    </div>`;
}

// ---- Notificaciones (v18) ----
const NOTIFICATION_ICONS = { new_comment: "💬", new_reply: "↩️", stage_alert: "⚠️", new_reaction: "👍" };
function renderNotificationListHTML(notifications) {
  if (!notifications || !notifications.length) {
    return `<div class="notif-empty">No tienes notificaciones.</div>`;
  }
  return notifications.map(n => `
    <div class="notif-item ${n.read_at ? "" : "notif-unread"}">
      <div class="notif-icon">${NOTIFICATION_ICONS[n.type] || "🔔"}</div>
      <div class="notif-body">
        <div class="notif-message">${escapeHtml_(n.message)}</div>
        <div class="notif-when">${fmtRelativeShort(n.created_at)}</div>
      </div>
    </div>`).join("");
}

// ---- Tooltip publicitario (v21, reforzado en v23) ----
// En dispositivos con mouse real se abre al pasar el cursor y se cierra al
// quitarlo (mouseenter/mouseleave), como un tooltip normal — nada de click.
// En pantallas táctiles no existe "pasar el cursor", así que ahí se abre y
// cierra con tap (toggle), con un listener global que cierra cualquier
// tooltip abierto al tocar fuera de él. Se decide con matchMedia en vez de
// intentar detectar el navegador.
//
// v23: se reportó que en Mac (verificado en dos equipos distintos) el
// tooltip a veces se queda abierto de forma permanente aunque el cursor ya
// no esté encima. mouseenter/mouseleave dependen de que el navegador
// detecte correctamente cuándo el puntero entra/sale del árbol DOM del
// botón — con un elemento posicionado en "absolute" que se dibuja fuera de
// su caja visual (el tooltip cae debajo del ícono, superponiéndose a otro
// contenido), algunos navegadores pueden perder ese evento en casos límite.
// Para que esto ya NUNCA se quede fijo pase lo que pase, se añade una red de
// seguridad independiente: un vigilante global que en cada movimiento real
// del mouse verifica, usando las coordenadas exactas del cursor, si sigue
// dentro del área visible del botón o del tooltip — si no, lo cierra. Esto
// no depende de que mouseenter/mouseleave se disparen correctamente.
function wireMedAdBadge(badgeId) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  const tooltip = badge.querySelector(".med-ad-tooltip");
  if (!tooltip) return;
  const closeAll = () => document.querySelectorAll(".med-ad-tooltip.show").forEach(t => t.classList.remove("show"));
  const isTouch = window.matchMedia && window.matchMedia("(hover: none), (pointer: coarse)").matches;
  if (isTouch) {
    badge.addEventListener("click", e => {
      e.stopPropagation();
      const wasOpen = tooltip.classList.contains("show");
      closeAll();
      if (!wasOpen) tooltip.classList.add("show");
    });
  } else {
    const show = () => { closeAll(); tooltip.classList.add("show"); };
    const hide = () => tooltip.classList.remove("show");
    badge.addEventListener("mouseenter", show);
    badge.addEventListener("mouseleave", hide);
    badge.addEventListener("focus", show); // accesible con teclado (Tab)
    badge.addEventListener("blur", hide);
  }
  wireMedAdWatchdog_();
}
document.addEventListener("click", () => {
  document.querySelectorAll(".med-ad-tooltip.show").forEach(t => t.classList.remove("show"));
});
// Vigilante global (una sola vez): cierra cualquier tooltip abierto en
// cuanto el cursor real ya no está sobre su botón ni sobre el propio
// tooltip, y también al hacer scroll o redimensionar la ventana. Es
// independiente de mouseenter/mouseleave, así que funciona aunque esos
// eventos fallen por cualquier motivo.
function wireMedAdWatchdog_() {
  if (wireMedAdWatchdog_._wired) return;
  wireMedAdWatchdog_._wired = true;
  const margin = 6; // px de tolerancia para no cerrarlo por un pixel de más
  const closeIfCursorOutside = (x, y) => {
    document.querySelectorAll(".med-ad-tooltip.show").forEach(tooltip => {
      const badge = tooltip.closest(".med-ad-badge");
      const boxes = [tooltip.getBoundingClientRect()];
      if (badge) boxes.push(badge.getBoundingClientRect());
      const inside = boxes.some(r =>
        x >= r.left - margin && x <= r.right + margin && y >= r.top - margin && y <= r.bottom + margin);
      if (!inside) tooltip.classList.remove("show");
    });
  };
  document.addEventListener("mousemove", e => closeIfCursorOutside(e.clientX, e.clientY));
  const closeAllNow = () => document.querySelectorAll(".med-ad-tooltip.show").forEach(t => t.classList.remove("show"));
  document.addEventListener("scroll", closeAllNow, true);
  window.addEventListener("resize", closeAllNow);
}

// ---- Enlaces directos a ChatGPT/Gemini desde el prompt de Análisis con IA
// (v25). ChatGPT sí soporta precargar el prompt en su cuadro de texto vía
// "?q=" (solo falta que el usuario presione Enter para enviarlo; no existe
// forma de autoenviarlo desde fuera de chatgpt.com por las restricciones de
// seguridad del navegador). Gemini no tiene ese soporte nativo, así que ahí
// se copia el prompt al portapapeles y se abre Gemini para pegarlo. ----
function wireAiDeepLinks(opts) {
  opts = opts || {};
  const chatGptBtn = document.getElementById(opts.chatGptBtnId);
  const geminiBtn = document.getElementById(opts.geminiBtnId);
  const getPrompt = () => { const el = document.getElementById(opts.outputId); return el ? el.value : ""; };
  if (chatGptBtn) {
    chatGptBtn.addEventListener("click", () => {
      const prompt = getPrompt();
      if (!prompt) return;
      window.open("https://chatgpt.com/?q=" + encodeURIComponent(prompt), "_blank", "noopener");
    });
  }
  if (geminiBtn) {
    geminiBtn.addEventListener("click", async () => {
      const prompt = getPrompt();
      if (!prompt) return;
      try { await navigator.clipboard.writeText(prompt); } catch (err) { /* silencioso */ }
      window.open("https://gemini.google.com/app", "_blank", "noopener");
    });
  }
}

// ---- Reacciones estilo Facebook (v26) ----
// target_type: "comment" | "reading". reactor_role: "patient" | "doctor" o
// "family" (familia/amigos, sin cuenta — se identifican con un id anónimo
// por dispositivo, ver wireFamilyReactorId más abajo).
//
// Diseño deliberadamente SOLO con click/tap, nunca con hover: la saga de
// v20-v24 fue justo por depender de mouseenter/mouseleave en un elemento
// posicionado "absolute" que en algunos casos perdía el evento de salida y
// se quedaba fijo. Para no repetir esa clase de bug, el selector de
// reacciones aquí se abre y cierra siempre con click, sin ningún :hover.
const REACTIONS = [
  { key: "like", emoji: "👍", label: "Me gusta" },
  { key: "love", emoji: "❤️", label: "Me encanta" },
  { key: "haha", emoji: "😆", label: "Me divierte" },
  { key: "wow", emoji: "😮", label: "Me asombra" },
  { key: "sad", emoji: "😢", label: "Me entristece" },
  { key: "angry", emoji: "😡", label: "Me enoja" },
];
// Agrupa todas las reacciones de un paciente (comentarios + lecturas) por
// target, para poder pedirlas todas juntas una sola vez por página.
function groupReactionsByTarget(reactions) {
  const map = {};
  (reactions || []).forEach(r => {
    const k = `${r.target_type}:${r.target_id}`;
    if (!map[k]) map[k] = [];
    map[k].push(r);
  });
  return map;
}
function reactionsForTarget(grouped, targetType, targetId) {
  return (grouped && grouped[`${targetType}:${targetId}`]) || [];
}
// counts por tipo (solo los que tienen al menos 1), total, y cuál es "mía"
// (la del propio viewerRole/viewerId), si tiene alguna.
function summarizeReactions(list, viewerRole, viewerId) {
  const counts = {};
  let mine = null;
  (list || []).forEach(r => {
    counts[r.reaction] = (counts[r.reaction] || 0) + 1;
    if (viewerRole && r.reactor_role === viewerRole && String(r.reactor_id) === String(viewerId)) mine = r.reaction;
  });
  return { counts, total: (list || []).length, mine };
}

function ensureReactionStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-reaction-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-reaction-styles";
  style.textContent = `
    .reaction-bar { display:flex; align-items:center; gap:6px; margin-top:6px; flex-wrap:wrap; }
    .reaction-icons { display:flex; align-items:center; gap:2px; }
    .reaction-icon-btn { border:1px solid transparent; background:transparent; border-radius:50%;
      width:28px; height:28px; font-size:17px; line-height:1; cursor:pointer; padding:0;
      display:flex; align-items:center; justify-content:center; opacity:0.55; transition:transform 0.08s ease, opacity 0.08s ease; }
    .reaction-icon-btn:hover, .reaction-icon-btn:focus-visible { opacity:1; background:#F0F0F0; outline:none; transform:scale(1.12); }
    .reaction-icon-btn.active { opacity:1; background:#EAF3EC; border-color:#cfe3d7; }
    .reaction-summary { display:flex; align-items:center; gap:4px; font-size:12px; color:var(--text-muted); }
    .reaction-summary .rs-emoji { font-size:13px; }
  `;
  document.head.appendChild(style);
}

// Arma el HTML de la barra de reacciones para un target (comentario o
// lectura). list: reacciones ya filtradas para ese target (reactionsForTarget).
// opts: { viewerRole, viewerId }.
//
// v28: los 6 emojis quedan siempre visibles en línea (nada de picker ni
// flecha que abrir). Tocar el que ya tienes activo lo quita; tocar otro lo
// cambia; tocar cualquiera sin tener reacción propia la agrega.
function renderReactionBarHTML(targetType, targetId, list, opts) {
  ensureReactionStyles_();
  opts = opts || {};
  const { counts, total, mine } = summarizeReactions(list, opts.viewerRole, opts.viewerId);
  const summaryHtml = total
    ? `<span class="reaction-summary">${REACTIONS.filter(r => counts[r.key]).map(r => `<span class="rs-emoji">${r.emoji}</span>`).join("")} ${total}</span>`
    : "";
  const iconButtons = REACTIONS.map(r =>
    `<button type="button" class="reaction-icon-btn ${mine === r.key ? "active" : ""}" data-reaction="${r.key}" title="${r.label}" aria-label="${r.label}">${r.emoji}</button>`).join("");
  return `
    <div class="reaction-bar" data-target-type="${targetType}" data-target-id="${targetId}" data-mine="${mine || ""}">
      <div class="reaction-icons">${iconButtons}</div>
      ${summaryHtml}
    </div>`;
}

// Delega los clicks de todas las .reaction-bar dentro de "root" (una sola
// vez). Solo click/tap, nunca hover. opts: { onReact(targetType, targetId,
// reactionKey) } — quien llama decide cómo mandarlo al backend y cómo
// re-renderizar después.
function wireReactionBars(root, opts) {
  root = root || document;
  opts = opts || {};
  if (root._reactionBarsWired) return;
  root._reactionBarsWired = true;
  root.addEventListener("click", e => {
    const iconBtn = e.target.closest(".reaction-icon-btn");
    const bar = e.target.closest(".reaction-bar");
    if (!iconBtn || !bar) return;
    e.stopPropagation();
    playReactionSound();
    const targetType = bar.getAttribute("data-target-type");
    const targetId = bar.getAttribute("data-target-id");
    const reaction = iconBtn.getAttribute("data-reaction");
    if (typeof opts.onReact === "function") opts.onReact(targetType, targetId, reaction);
  });
}

// ---- Audio compartido para sonidos de reacciones/notificaciones (v29) ----
// Antes, cada función de sonido creaba su propio AudioContext la primera vez
// que se llamaba. Para las reacciones eso coincidía con un click (un gesto
// válido de usuario), pero las notificaciones llegan por sondeo o por SSE
// — sin ningún click de por medio — y en el celular (sobre todo iOS Safari)
// el navegador exige que el AudioContext se cree/reanude DENTRO de un gesto
// real; si no, se queda "suspended" para siempre y no suena nunca, que es
// justo el bug reportado ("no se escuchan los sonidos en móvil"). Ahora se
// desbloquea un solo AudioContext compartido en el primer toque/click que el
// usuario haga en cualquier parte de la página (sí es un gesto real), y las
// funciones de sonido reutilizan ese mismo contexto ya activo después,
// aunque las dispare un timer o el SSE mucho más tarde.
let _sharedAudioCtx = null;
function getSharedAudioCtx_() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!_sharedAudioCtx) _sharedAudioCtx = new Ctx();
  return _sharedAudioCtx;
}
if (typeof document !== "undefined") {
  const unlockSharedAudio_ = () => {
    const ctx = getSharedAudioCtx_();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  ["pointerdown", "touchend", "keydown"].forEach(evt => document.addEventListener(evt, unlockSharedAudio_, { once: true, passive: true }));
}

// Sonido corto ("pop") al reaccionar, generado con Web Audio API — sin
// archivos de audio externos, para no depender de ningún servicio ni
// aumentar el peso de la app. Silencioso si el navegador no lo soporta o
// bloquea el audio.
function playReactionSound() {
  try {
    const ctx = getSharedAudioCtx_();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
  } catch (err) { /* silencioso: el sonido es un extra, nunca debe romper la reacción */ }
}

// Sonido de notificación (paciente/médico al recibir una alerta nueva en la
// campanita, familia al ver reacciones nuevas desde su última visita) — un
// timbre de dos notas, distinto del "pop" de reaccionar para que se
// distingan al oído.
function playNotificationSound() {
  try {
    const ctx = getSharedAudioCtx_();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    [523.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.11;
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  } catch (err) { /* silencioso */ }
}
// Id anónimo por dispositivo para la vista de familia/amigos (sin cuenta):
// se genera una sola vez y se guarda en localStorage, para poder togglear su
// propia reacción de la misma forma que un paciente o médico logueado.
function getFamilyReactorId() {
  const KEY = "bp_family_reactor_id";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = "fam_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (err) {
    return "fam_" + Math.random().toString(36).slice(2); // sin localStorage: funciona la sesión actual, sin persistir
  }
}

// ---- Tiempo real (v28) ----
// Envuelve el EventSource nativo del navegador (que ya trae reconexión
// automática incluida, sin código extra) para recibir avisos de "algo
// cambió" desde el servidor y no depender de refrescar la pantalla a mano.
// url: el endpoint SSE (/api/stream para paciente/médico logueados,
// /familia/TOKEN/stream para el enlace de familia). onChange(kind): se
// llama con "reading" | "comment" | "reaction" cada vez que llega un aviso;
// quien llama decide qué recargar (reutilizando sus funciones de carga ya
// existentes) — aquí nunca viaja el dato en sí, solo el aviso.
function connectRealtime(url, onChange) {
  if (typeof EventSource === "undefined") return null; // navegador muy viejo: la página sigue funcionando igual que antes, solo sin tiempo real
  let source;
  try {
    source = new EventSource(url);
  } catch (err) {
    return null;
  }
  source.onmessage = ev => {
    try {
      const data = JSON.parse(ev.data);
      if (data && data.type && typeof onChange === "function") onChange(data.type);
    } catch (err) { /* keepalive u otro mensaje no-JSON: se ignora */ }
  };
  return source;
}

// ---- Confeti al agregar una lectura (v29) ----
// Canvas propio, sin librería externa (mismo criterio que los sonidos de
// Web Audio API de más abajo: un efecto chiquito no amerita una dependencia
// nueva). originEl: elemento desde donde "explota" el confeti (normalmente
// el botón "Agregar"); si no se da, sale del centro-arriba de la pantalla.
function fireConfetti(originEl) {
  try {
    const colors = ["#6FA98C", "#D8AE5C", "#D98E5F", "#9B8AC4", "#4F7A6F", "#2E9E96"];
    const rect = originEl && originEl.getBoundingClientRect ? originEl.getBoundingClientRect() : null;
    const originX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const originY = rect ? rect.top : window.innerHeight * 0.2;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed; inset:0; width:100vw; height:100vh; pointer-events:none; z-index:9999;";
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const particles = Array.from({ length: 70 }, () => ({
      x: originX, y: originY,
      vx: (Math.random() - 0.5) * 9,
      vy: -(Math.random() * 8 + 4),
      size: Math.random() * 6 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.3,
      shape: Math.random() < 0.5 ? "rect" : "circle",
    }));
    const gravity = 0.28;
    const start = performance.now();
    const durationMs = 1500;

    function frame(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
        const fade = Math.max(0, 1 - elapsed / durationMs);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        if (p.shape === "rect") ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      });
      if (elapsed < durationMs) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  } catch (err) { /* silencioso: el confeti es solo un extra, nunca debe romper el flujo de agregar */ }
}

// ---- Notificaciones push (Web Push) y badge del ícono (v29) ----
// Badge: mientras la app está abierta, cada página llama esto desde su
// propio renderNotifBadge() con el conteo que ya calcula para la campanita
// — así el número del ícono (iOS 16.4+/Android, solo si está anclada a la
// pantalla de inicio) siempre coincide con el de la campanita. Cuando la
// app está CERRADA, el mismo número se pone desde el service worker al
// recibir un push (ver sw.js), sin depender de que esta función corra.
function updateAppBadge_(count) {
  try {
    if (!("setAppBadge" in navigator)) return;
    if (count > 0) navigator.setAppBadge(count).catch(() => {});
    else if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
  } catch (err) { /* silencioso: el badge es un extra */ }
}

function urlBase64ToUint8Array_(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

// Registra el service worker una sola vez por página (no hace falta
// esperar a que el usuario active las notificaciones: registrarlo temprano
// no pide permiso ni suscribe a nada por sí solo, solo lo deja listo).
function registerServiceWorker_() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js").catch(() => null);
}

// Envuelve todo el flujo de activar/desactivar notificaciones push en un
// botón: pide permiso, registra el service worker si hace falta, suscribe
// (o desuscribe) al Push Manager del navegador, y avisa al servidor para
// que guarde (o borre) esa suscripción. reportStatus(state): se llama con
// "unsupported" | "denied" | "subscribed" | "unsubscribed" para que quien
// use esto actualice su propio botón/texto.
async function wirePushToggle(reportStatus) {
  const unsupported = !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window);
  if (unsupported) { reportStatus("unsupported"); return; }

  const reg = await registerServiceWorker_();
  if (!reg) { reportStatus("unsupported"); return; }
  const existing = await reg.pushManager.getSubscription();
  reportStatus(existing ? "subscribed" : (Notification.permission === "denied" ? "denied" : "unsubscribed"));

  return {
    subscribe: async () => {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { reportStatus("denied"); return; }
      const keyResp = await fetch("/api/push/vapid-public-key");
      const keyJson = await keyResp.json();
      if (!keyJson.ok || !keyJson.enabled || !keyJson.publicKey) { reportStatus("unsupported"); return; }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array_(keyJson.publicKey),
      });
      await fetch("/api/push/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      reportStatus("subscribed");
    },
    unsubscribe: async () => {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      reportStatus("unsubscribed");
    },
  };
}

// ---- Icono de ojo para mostrar/ocultar contraseña (v29) ----
// Mismo helper que /shared/auth.js (login/signup no cargan common.js, así
// que esa versión vive por separado), aquí para los campos de contraseña
// que aparecen dentro de los modales de Cuenta (cambiar contraseña, correo).
function ensurePasswordToggleStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-pw-toggle-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-pw-toggle-styles";
  style.textContent = `
    .pw-field { position: relative; }
    .pw-field input { padding-right: 38px; }
    .pw-toggle { position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; font-size: 16px; line-height: 1;
      padding: 6px; color: var(--text-muted); }
    .pw-toggle:hover { color: var(--text); }
  `;
  document.head.appendChild(style);
}
function wirePasswordToggle(input) {
  if (!input || input.dataset.pwWired) return;
  ensurePasswordToggleStyles_();
  input.dataset.pwWired = "1";
  const wrap = document.createElement("div");
  wrap.className = "pw-field";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pw-toggle";
  btn.setAttribute("aria-label", "Mostrar contraseña");
  btn.textContent = "👁";
  wrap.appendChild(btn);
  btn.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "👁" : "🙈";
    btn.setAttribute("aria-label", showing ? "Mostrar contraseña" : "Ocultar contraseña");
  });
}
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll('input[type="password"]').forEach(wirePasswordToggle);
  });
}

// ---- "Recomienda esta app" ----
function wireRecommendLink(elementId, appName) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.addEventListener("click", async (e) => {
    e.preventDefault();
    const url = window.location.origin + "/signup";
    const text = `Estoy usando ${appName || "Reigning Blood Pressure App"} para monitorear mi presión arterial. Pruébala tú también:`;
    if (navigator.share) {
      try { await navigator.share({ title: appName || "Reigning Blood Pressure App", text, url }); return; } catch (err) { /* usuario canceló, sigue al fallback */ }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      const original = el.textContent;
      el.textContent = "Copiado, ¡compártelo!";
      setTimeout(() => { el.textContent = original; }, 1800);
    } catch (err) { /* silencioso */ }
  });
}
