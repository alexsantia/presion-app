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

// ---- Comparación por franja horaria (v30) ----
// Para la sección Estadísticas: promedia sys/dia/hr dentro de cada una de las
// cuatro franjas del día (mismos rangos que filterByTimeView, reutilizados
// para que ambas vistas coincidan), acotado al periodo elegido (semana, mes
// o año). Siempre regresa las 4 franjas en el mismo orden, aunque alguna no
// tenga lecturas (con sys/dia/hr en null, para que la gráfica muestre el
// hueco en vez de desaparecer la barra).
const TIME_OF_DAY_BUCKETS_ = [
  { key: "madrugada", label: "Madrugada (1–5h)" },
  { key: "manana", label: "Mañana (5–12h)" },
  { key: "tarde", label: "Tarde (12–19h)" },
  { key: "noche", label: "Noche (19–1h)" },
];
function timeOfDayComparisonData(data, granularity) {
  const periodFiltered = filterByPeriod(data, granularity || "month");
  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return TIME_OF_DAY_BUCKETS_.map(bucket => {
    const bucketData = filterByTimeView(periodFiltered, bucket.key);
    const sysVals = bucketData.map(r => r.sys).filter(v => v != null);
    const diaVals = bucketData.map(r => r.dia).filter(v => v != null);
    const hrVals = bucketData.map(r => r.hr).filter(v => v != null);
    return { key: bucket.key, label: bucket.label, sys: avg(sysVals), dia: avg(diaVals), hr: avg(hrVals), count: bucketData.length };
  });
}

// v30.7: mismo criterio que filterByPeriod, pero recibe el nombre del campo
// de fecha a usar — las lecturas normales usan "date" y el historial de
// laboratorio (lab_history) usa "fecha", y ahora las gráficas de
// Estadísticas necesitan filtrar ambos por el mismo selector de periodo.
function filterByPeriodField_(data, granularity, dateField) {
  const list = data || [];
  if (granularity === "all" || !granularity) return list.slice();
  const daysMap = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };
  const days = daysMap[granularity];
  if (!days) return list.slice();
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = localDateStr_(cutoff);
  return list.filter(r => r[dateField] >= cutoffStr);
}

// ---- Gráficas de una sola métrica en Estadísticas (v30.6, filtro de
// periodo y observaciones agregados en v30.7): Frecuencia cardíaca y Peso
// salen de las lecturas normales (currentData, ya trae hr, weight y obs);
// Perímetro abdominal, Colesterol y Triglicéridos salen del historial de
// laboratorio (lab_history), que no tiene observaciones. ----
function readingsSeriesForKey_(data, key) {
  const filtered = (data || []).filter(r => r[key] != null);
  return {
    labels: filtered.map(r => fmtDate(r.date) + (r.time ? " " + r.time : "")),
    values: filtered.map(r => r[key]),
    obs: filtered.map(r => r.obs || ""),
  };
}
function labHistorySeriesForKey_(history, key) {
  const filtered = (history || []).filter(h => h[key] != null);
  return { labels: filtered.map(h => fmtDate(h.fecha)), values: filtered.map(h => h[key]), obs: filtered.map(() => "") };
}
function renderMetricTrendChart(prevInstance, canvasEl, emptyEl, series, opts) {
  if (prevInstance) prevInstance.destroy();
  const hasData = series.values.length > 0;
  if (emptyEl) emptyEl.style.display = hasData ? "none" : "block";
  if (canvasEl) canvasEl.style.display = hasData ? "" : "none";
  if (!hasData || !canvasEl) return null;
  const ctx = canvasEl.getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: { labels: series.labels, datasets: [{
      label: opts.label, data: series.values, borderColor: opts.color, backgroundColor: opts.color,
      tension: 0.25, spanGaps: true, pointRadius: 3,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterBody(items) {
              const obs = series.obs && series.obs[items[0].dataIndex];
              return obs ? [`Obs: ${obs}`] : [];
            },
          },
        },
      },
      scales: { y: { title: { display: true, text: opts.unit || "" }, beginAtZero: false } },
    },
  });
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
// Ajusta la posición horizontal de un tooltip centrado (translateX(-50%))
// para que nunca quede cortado ni ilegible cerca del borde de la pantalla,
// en desktop o en móvil (v30.1). El tooltip debe ya estar visible/medible
// (visibility:hidden sí se puede medir; display:none no) antes de llamar
// esta función. verticalTransform es el componente vertical que ya traía
// el tooltip (por ejemplo "translateY(0)"), si aplica.
function keepTooltipInViewport_(tooltip, verticalTransform) {
  if (!tooltip || typeof window === "undefined") return;
  const vert = verticalTransform || "";
  tooltip.style.transform = `translateX(-50%) ${vert}`.trim();
  const margin = 8;
  const rect = tooltip.getBoundingClientRect();
  const overflowRight = rect.right - window.innerWidth + margin;
  const overflowLeft = margin - rect.left;
  let shift = 0;
  if (overflowRight > 0) shift = -overflowRight;
  else if (overflowLeft > 0) shift = overflowLeft;
  if (shift) {
    tooltip.style.transform = `translateX(calc(-50% + ${shift}px)) ${vert}`.trim();
  }
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
    if (willOpen) keepTooltipInViewport_(badge.querySelector(".lvl-tooltip"), "translateY(0)");
  });
  // En desktop (con mouse real) el tooltip también se abre por :hover puro,
  // sin pasar por el click de arriba, así que aquí se reajusta la posición
  // en cuanto el cursor entra al badge.
  document.addEventListener("mouseover", (e) => {
    const badge = e.target.closest(".lvl-badge");
    if (!badge) return;
    keepTooltipInViewport_(badge.querySelector(".lvl-tooltip"), "translateY(0)");
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
          <div style="font-weight:700; font-size:13px; letter-spacing:.2px;">Racha</div>
          <div style="font-size:26px; margin-top:2px;">🔥</div>
          <div style="font-size:13px;">de <span style="font-size:22px; font-weight:650;">${streak.current}</span> día${streak.current === 1 ? "" : "s"} seguidos</div>
          ${streak.longest > streak.current ? `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">récord: ${streak.longest}</div>` : ""}
        </div>
        <div style="flex:1; min-width:220px;">${levelHtml}</div>
      </div>
      ${levelLadderHTML(streak.current)}
    </div>`;
}

// ---- Malos hábitos (v30.1) ----
// Catálogo de tipos de mal hábito, compartido entre el formulario de
// registro y el listado de historial. Cada tipo define qué campo numérico
// (si aplica) y qué campo de texto se le pide al paciente, según lo que
// tenga sentido registrar en cada caso: para alcohol, cuántas copas y de
// qué bebida; para desvelo, horas de sueño continuo; para alimentación o
// sal en exceso, una descripción libre de lo que se comió; etc.
const HABIT_TYPES = [
  { key: "alimentacion", label: "Alimentación", icon: "🍔",
    numberField: null,
    textField: { label: "Alimentos no saludables", placeholder: "Ej. hamburguesa, papas fritas, refresco" } },
  { key: "alcohol", label: "Alcohol", icon: "🍷",
    numberField: { label: "Copas", unit: "copas", placeholder: "Ej. 2", step: "1", min: "0" },
    textField: { label: "Tipo de bebida", placeholder: "Ej. cerveza, vino, tequila" } },
  { key: "tabaco", label: "Tabaco", icon: "🚬",
    numberField: { label: "Cigarrillos", unit: "cigarrillos", placeholder: "Ej. 5", step: "1", min: "0" },
    textField: { label: "Notas (opcional)", placeholder: "" } },
  { key: "desvelo", label: "Desvelo", icon: "🌙",
    numberField: { label: "Horas de sueño continuo", unit: "horas de sueño", placeholder: "Ej. 4.5", step: "0.5", min: "0", max: "24" },
    textField: { label: "Notas (opcional)", placeholder: "" } },
  { key: "sal", label: "Sal en exceso", icon: "🧂",
    numberField: null,
    textField: { label: "¿Qué comiste con exceso de sal?", placeholder: "Ej. sopa instantánea, embutidos" } },
  { key: "sedentarismo", label: "Sedentarismo", icon: "🛋️",
    numberField: { label: "Horas sin actividad física", unit: "horas sedentario", placeholder: "Ej. 8", step: "0.5", min: "0", max: "24" },
    textField: { label: "Notas (opcional)", placeholder: "" } },
  { key: "otro", label: "Otro", icon: "📝",
    numberField: { label: "Valor (opcional)", unit: "", placeholder: "", step: "0.1" },
    textField: { label: "Descripción", placeholder: "Describe el hábito" } },
];
function habitTypeByKey_(key) {
  return HABIT_TYPES.find(h => h.key === key) || HABIT_TYPES[HABIT_TYPES.length - 1];
}
function habitEntryHTML_(h, opts) {
  opts = opts || {};
  const type = habitTypeByKey_(h.tipo);
  const parts = [];
  if (h.valor_numero != null && h.valor_numero !== "") {
    const unit = type.numberField ? type.numberField.unit : "";
    parts.push(`${h.valor_numero}${unit ? " " + unit : ""}`);
  }
  if (h.valor_texto) parts.push(escapeHtml_(h.valor_texto));
  const deleteBtn = opts.readOnly ? "" : `<button type="button" class="btn-mini danger habit-delete-btn" data-habit-id="${h.id}">Eliminar</button>`;
  return `
    <div class="habit-entry" data-habit-id="${h.id}">
      <div class="habit-entry-icon">${type.icon}</div>
      <div class="habit-entry-body">
        <div class="habit-entry-title">${type.label}</div>
        <div class="habit-entry-detail">${parts.join(" · ") || "(sin detalle)"}</div>
        <div class="habit-entry-date">${fmtDate(h.fecha)}</div>
      </div>
      ${deleteBtn}
    </div>`;
}
function renderHabitsListHTML(habits, opts) {
  if (!habits || !habits.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no se ha registrado ningún mal hábito.</div>`;
  }
  return habits.map(h => habitEntryHTML_(h, opts)).join("");
}
function ensureHabitStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-habit-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-habit-styles";
  style.textContent = `
    .habit-entry { display:flex; align-items:flex-start; gap:10px; padding:10px 0; border-bottom:1px solid var(--border); }
    .habit-entry:last-child { border-bottom:none; }
    .habit-entry-icon { font-size:20px; line-height:1; padding-top:2px; }
    .habit-entry-body { flex:1; min-width:0; }
    .habit-entry-title { font-weight:650; font-size:13.5px; }
    .habit-entry-detail { font-size:13px; color:var(--text); margin-top:1px; }
    .habit-entry-date { font-size:11px; color:var(--text-muted); margin-top:2px; }
  `;
  document.head.appendChild(style);
}

// ---- Acerca de (v30.3) ----
// Historial de versiones, mostrado igual en las tres vistas (paciente,
// médico, familia). En vez de depender de qué sistema de modales tenga
// cada página (index.html sí tiene uno, doctor.html y familia.html no), se
// dibuja como un overlay propio y autosuficiente, con su CSS inyectado una
// sola vez, así funciona igual sin importar desde dónde se llame.
const APP_VERSION_HISTORY = [
  { version: "30.7", changes: [
    "Las gráficas de Estadísticas ahora respetan el filtro de semana, mes y año.",
    "Los puntos de las gráficas de frecuencia cardíaca y peso muestran la observación de esa lectura al pasar el cursor.",
    "\"Invitar a tu médico\" ahora se abre desde el menú de hamburguesa, no desde Parámetros.",
    "Nueva animación de destello al cambiar de pestaña.",
  ] },
  { version: "30.6", changes: [
    "Corregido: la foto de perfil no se actualizaba en algunos casos por el caché del navegador.",
    "Botones de Guardar y Cancelar al elegir una foto de perfil nueva, con vista previa antes de subirla.",
    "Efecto de confeti en cualquier botón de la app, no solo al agregar una lectura.",
    "Nuevas gráficas en Estadísticas: frecuencia cardíaca, peso, perímetro abdominal, triglicéridos y colesterol.",
  ] },
  { version: "30.5", changes: [
    "El botón de ver/ocultar contraseña ya no se encima con el texto en las pantallas de acceso.",
    "Los mensajes generales del administrador ahora se pueden dirigir solo a paciente, solo a médico, o solo al enlace de familia y amigos.",
    "El enlace de familia y amigos ahora también muestra estos mensajes generales.",
  ] },
  { version: "30.4", changes: [
    "Nueva sección de Síntomas diarios, con síntoma, fecha, hora y descripción.",
    "Foto de perfil visible debajo del encabezado en las vistas de paciente y de familia.",
    "Las vistas de familia y médico ahora tienen las mismas pestañas que la de paciente: Estadísticas, Malos hábitos, Catálogo de médicos y Síntomas diarios.",
    "Buscar médico por nombre o contacto en el catálogo de médicos.",
  ] },
  { version: "30.3.2", changes: [
    "Al tomar una foto con la cámara, ahora se puede confirmar o repetir antes de subirla.",
    "Clic en cualquier foto de perfil para verla ampliada (cuenta, médicos vinculados, catálogo de médicos).",
    "Cuando no hay foto, se muestran las iniciales del nombre en vez de un ícono genérico.",
  ] },
  { version: "30.3.1", changes: [
    "El botón de Tomar foto ahora abre la cámara de verdad en cualquier navegador (antes en Mac/PC solo abría el explorador de archivos).",
  ] },
  { version: "30.3", changes: [
    "Botón para tomar la foto de perfil directo con la cámara.",
    "Esta sección de Acerca de, con el historial de versiones.",
    "Catálogo de médicos por especialidad, con publicación opcional para cada médico.",
  ] },
  { version: "30.2", changes: [
    "Botón de prueba para diagnosticar las notificaciones push.",
  ] },
  { version: "30.1", changes: [
    "El menú y los recuadros de ayuda ya no se cortan en pantallas angostas.",
    "Nueva sección de Malos hábitos.",
    "La racha de días seguidos con nuevo diseño.",
    "Las tablas ahora muestran 10 lecturas por página de entrada.",
  ] },
  { version: "30", changes: [
    "Las reacciones aparecen debajo de cada comentario.",
    "Gráfica de Estadísticas por franja horaria del día.",
    "Invitaciones a tu médico por correo electrónico.",
    "Fotos de perfil.",
    "Panel de administrador.",
  ] },
  { version: "29", changes: [
    "Sección de Estadísticas.",
    "Notificaciones push y contador de pendientes en el ícono de la app.",
    "Mejoras de uso en pantallas de celular.",
  ] },
  { version: "28", changes: [
    "Los cambios de tu médico o tu familia aparecen solos, sin recargar.",
    "Respaldo y restauración de tus datos.",
    "Reacciones con iconos en lecturas y comentarios.",
  ] },
];
function ensureAboutStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-about-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-about-styles";
  style.textContent = `
    .bp-about-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center; z-index:200; padding:16px; box-sizing:border-box; }
    .bp-about-card { background:#fff; border-radius:14px; max-width:380px; width:100%; max-height:85vh; overflow-y:auto; padding:22px; box-shadow:0 10px 40px rgba(0,0,0,0.25); }
    .bp-about-card h2 { margin:0 0 4px; font-size:19px; }
    .bp-about-version { font-size:13px; color:#666; margin-bottom:14px; }
    .bp-about-meta { font-size:13px; margin-bottom:16px; line-height:1.5; }
    .bp-about-history h3 { font-size:13px; margin:14px 0 6px; }
    .bp-about-entry { margin-bottom:10px; }
    .bp-about-entry-version { font-weight:650; font-size:13px; }
    .bp-about-entry ul { margin:4px 0 0; padding-left:18px; font-size:12.5px; }
    .bp-about-close { margin-top:14px; width:100%; }
  `;
  document.head.appendChild(style);
}
function showAboutOverlay_(currentVersion) {
  ensureAboutStyles_();
  const overlay = document.createElement("div");
  overlay.className = "bp-about-overlay";
  const historyHtml = APP_VERSION_HISTORY.map(v => `
    <div class="bp-about-entry">
      <div class="bp-about-entry-version">v${escapeHtml_(v.version)}</div>
      <ul>${v.changes.map(c => `<li>${escapeHtml_(c)}</li>`).join("")}</ul>
    </div>`).join("");
  overlay.innerHTML = `
    <div class="bp-about-card">
      <h2>Reigning Blood Pressure App</h2>
      <div class="bp-about-version">Versión ${escapeHtml_(currentVersion)}</div>
      <div class="bp-about-meta">Desarrollado por <strong>Empresso Tech</strong><br>Autor: Alex Santiago</div>
      <div class="bp-about-history">
        <h3>Historial de versiones</h3>
        ${historyHtml}
      </div>
      <button type="button" class="btn-secondary bp-about-close">Cerrar</button>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  overlay.querySelector(".bp-about-close").addEventListener("click", close);
}
function wireAboutTrigger(triggerEl, currentVersion) {
  if (!triggerEl) return;
  triggerEl.addEventListener("click", e => {
    e.preventDefault();
    showAboutOverlay_(currentVersion);
  });
}

// ---- Catálogo de médicos (v30.3) ----
// Cada médico decide, por su cuenta, si publica su ficha en este catálogo
// (nombre, especialidad, una breve descripción, contacto y ciudad). Se
// muestra igual en las 3 vistas: index.html (paciente), doctor.html
// (médico, para poder referir a otro especialista) y familia.html (público,
// sin sesión).
const DOCTOR_SPECIALTIES = [
  "Cardiología", "Medicina Interna", "Medicina Familiar", "Nefrología",
  "Endocrinología", "Geriatría", "Nutrición", "Otro",
];
function ensureDoctorCatalogStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-catalog-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-catalog-styles";
  style.textContent = `
    .catalog-group { margin-bottom: 18px; }
    .catalog-specialty { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin: 0 0 8px; }
    .catalog-card { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .catalog-card:last-child { border-bottom: none; }
    .catalog-card-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--border, #E2E2E2); flex-shrink: 0; }
    .catalog-card-body { flex: 1; min-width: 0; }
    .catalog-card-name { font-weight: 650; font-size: 13.5px; }
    .catalog-card-bio { font-size: 13px; margin-top: 2px; }
    .catalog-card-meta { font-size: 12px; color: var(--text-muted); margin-top: 3px; }
  `;
  document.head.appendChild(style);
}
function doctorCatalogCardHTML_(d) {
  return `
    <div class="catalog-card">
      ${avatarWithInitialsHTML_("doctor", d.id, d.name, 40)}
      <div class="catalog-card-body">
        <div class="catalog-card-name">${escapeHtml_(d.title || "Dr(a).")} ${escapeHtml_(d.name)}</div>
        ${d.catalog_bio ? `<div class="catalog-card-bio">${escapeHtml_(d.catalog_bio)}</div>` : ""}
        <div class="catalog-card-meta">${[d.catalog_city, d.catalog_contact].filter(Boolean).map(escapeHtml_).join(" · ")}</div>
      </div>
    </div>`;
}
// searchQuery (v30.4) busca por nombre o por el contacto que el médico
// haya publicado (que a veces es su correo o teléfono) — nunca por el
// correo de acceso de la cuenta, que no forma parte del catálogo público.
function renderDoctorCatalogHTML(doctors, specialtyFilter, searchQuery) {
  ensureDoctorCatalogStyles_();
  let list = specialtyFilter ? (doctors || []).filter(d => d.specialty === specialtyFilter) : (doctors || []);
  const q = (searchQuery || "").trim().toLowerCase();
  if (q) list = list.filter(d => (d.name || "").toLowerCase().includes(q) || (d.catalog_contact || "").toLowerCase().includes(q));
  if (!list.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">${q || specialtyFilter ? "No se encontraron médicos con ese filtro." : "Todavía no hay médicos publicados en el catálogo."}</div>`;
  }
  const groups = {};
  list.forEach(d => { (groups[d.specialty || "Otro"] = groups[d.specialty || "Otro"] || []).push(d); });
  return Object.keys(groups).sort().map(spec => `
    <div class="catalog-group">
      <h3 class="catalog-specialty">${escapeHtml_(spec)}</h3>
      ${groups[spec].map(doctorCatalogCardHTML_).join("")}
    </div>`).join("");
}
// Llena un <select> con las especialidades presentes en los datos (más
// "Todas") y vuelve a dibujar la lista cada vez que cambia el filtro o la
// búsqueda. searchInputEl es opcional (v30.4): un <input> de texto para
// buscar por nombre o por el contacto publicado del médico.
function wireDoctorCatalogFilter(selectEl, containerEl, doctors, searchInputEl) {
  if (!selectEl || !containerEl) return;
  const present = [...new Set((doctors || []).map(d => d.specialty || "Otro"))].sort();
  selectEl.innerHTML = `<option value="">Todas las especialidades</option>` +
    present.map(s => `<option value="${escapeHtml_(s)}">${escapeHtml_(s)}</option>`).join("");
  const redraw = () => { containerEl.innerHTML = renderDoctorCatalogHTML(doctors, selectEl.value || null, searchInputEl ? searchInputEl.value : ""); };
  selectEl.addEventListener("change", redraw);
  if (searchInputEl) searchInputEl.addEventListener("input", redraw);
  redraw();
}

// ---- Síntomas diarios (v30.4) ----
const SYMPTOM_SUGGESTIONS = [
  "Dolor de cabeza", "Mareo", "Palpitaciones", "Visión borrosa", "Náusea",
  "Fatiga", "Dificultad para respirar", "Dolor en el pecho", "Zumbido en los oídos", "Otro",
];
function symptomEntryHTML_(s, opts) {
  opts = opts || {};
  const deleteBtn = opts.readOnly ? "" : `<button type="button" class="btn-mini danger symptom-delete-btn" data-symptom-id="${s.id}">Eliminar</button>`;
  return `
    <div class="habit-entry" data-symptom-id="${s.id}">
      <div class="habit-entry-icon">🌡️</div>
      <div class="habit-entry-body">
        <div class="habit-entry-title">${escapeHtml_(s.sintoma)}</div>
        ${s.descripcion ? `<div class="habit-entry-detail">${escapeHtml_(s.descripcion)}</div>` : ""}
        <div class="habit-entry-date">${fmtDate(s.fecha)}${s.hora ? " · " + escapeHtml_(s.hora) : ""}</div>
      </div>
      ${deleteBtn}
    </div>`;
}
// opts: { readOnly } — doctor.html usa readOnly:true (puede ver, no borrar).
function renderSymptomsListHTML(symptoms, opts) {
  if (!symptoms || !symptoms.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no hay síntomas registrados.</div>`;
  }
  return symptoms.map(s => symptomEntryHTML_(s, opts)).join("");
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
      if (!wasOpen) { tooltip.classList.add("show"); keepTooltipInViewport_(tooltip); }
    });
  } else {
    const show = () => { closeAll(); tooltip.classList.add("show"); keepTooltipInViewport_(tooltip); };
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
function fireConfetti(originEl, count) {
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

    const particles = Array.from({ length: count || 70 }, () => ({
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
// v30.6: confeti en cualquier botón de la app al presionarlo, no solo al
// agregar una lectura (eso ya lo tenía desde v29, con más partículas). Un
// solo listener delegado en el documento; se usan menos partículas aquí
// para que no se sienta excesivo en botones de uso muy frecuente (paginar,
// cerrar un modal, filtros).
function wireConfettiOnAllButtons_() {
  if (typeof document === "undefined" || document.body.dataset.confettiWired) return;
  document.body.dataset.confettiWired = "1";
  document.addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    fireConfetti(btn, 22);
  });
}
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", wireConfettiOnAllButtons_);
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
  if (!("serviceWorker" in navigator)) {
    console.warn("[push] este navegador no tiene Service Worker (serviceWorker no está en navigator)");
    return Promise.resolve(null);
  }
  return navigator.serviceWorker.register("/sw.js")
    .then(reg => { console.log("[push] service worker registrado, scope:", reg.scope); return reg; })
    .catch(err => { console.error("[push] falló el registro del service worker:", err); return null; });
}

// Envuelve todo el flujo de activar/desactivar notificaciones push en un
// botón: pide permiso, registra el service worker si hace falta, suscribe
// (o desuscribe) al Push Manager del navegador, y avisa al servidor para
// que guarde (o borre) esa suscripción. reportStatus(state): se llama con
// "unsupported" | "denied" | "subscribed" | "unsubscribed" para que quien
// use esto actualice su propio botón/texto.
async function wirePushToggle(reportStatus) {
  const unsupported = !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window);
  if (unsupported) {
    console.warn("[push] API no disponible en este navegador:", {
      serviceWorker: "serviceWorker" in navigator,
      PushManager: "PushManager" in window,
      Notification: "Notification" in window,
      standalone: window.matchMedia && window.matchMedia("(display-mode: standalone)").matches,
    });
    reportStatus("unsupported");
    return;
  }

  const reg = await registerServiceWorker_();
  if (!reg) { reportStatus("unsupported"); return; }
  const existing = await reg.pushManager.getSubscription().catch(err => { console.error("[push] getSubscription falló:", err); return null; });
  reportStatus(existing ? "subscribed" : (Notification.permission === "denied" ? "denied" : "unsubscribed"));

  return {
    subscribe: async () => {
      try {
        const permission = await Notification.requestPermission();
        console.log("[push] permiso de notificaciones:", permission);
        if (permission !== "granted") { reportStatus("denied"); return; }
        const keyResp = await fetch("/api/push/vapid-public-key");
        const keyJson = await keyResp.json();
        if (!keyJson.ok || !keyJson.enabled || !keyJson.publicKey) {
          console.error("[push] el servidor no tiene VAPID configurado o la ruta falló:", keyJson);
          reportStatus("unsupported");
          return;
        }
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array_(keyJson.publicKey),
        });
        console.log("[push] suscripción creada, endpoint:", sub.endpoint);
        const saveResp = await fetch("/api/push/subscribe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
        if (!saveResp.ok) console.error("[push] el servidor no pudo guardar la suscripción, status:", saveResp.status);
        reportStatus("subscribed");
      } catch (err) {
        console.error("[push] subscribe falló:", err);
        throw err;
      }
    },
    unsubscribe: async () => {
      try {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch("/api/push/unsubscribe", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          await sub.unsubscribe();
        }
        reportStatus("unsubscribed");
      } catch (err) {
        console.error("[push] unsubscribe falló:", err);
        throw err;
      }
    },
  };
}

// ---- Foto de perfil (v30) ----
// URL pública para mostrar la foto de una cuenta (paciente o médico). "v" es
// para invalidar el caché del navegador justo después de subir/borrar una
// foto nueva (si no, algunos navegadores se quedan con la vieja).
function avatarUrl(accountType, id, cacheBuster) {
  if (!id) return "";
  return `/api/avatar/${accountType === "doctor" ? "doctor" : "patient"}/${id}` + (cacheBuster ? `?v=${cacheBuster}` : "");
}

// ---- Iniciales y vista ampliada de foto de perfil (v30.3.2) ----
// Cuando no hay foto, en vez del ícono genérico 👤 se muestran las
// iniciales del nombre (hasta 2 letras). Y en cualquier avatar clicable (la
// foto grande de la cuenta, los avatares chicos de médicos vinculados, el
// catálogo de médicos) un clic abre una vista ampliada — un solo manejador
// delegado en todo el documento cubre las tres vistas sin repetir código.
function initialsFromName_(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
// Devuelve el HTML de un avatar circular de tamaño fijo que muestra la foto
// si carga, o las iniciales del nombre si no hay foto (o falla la carga).
// Se usa para los avatares chicos (médicos vinculados, catálogo); la foto
// grande de la cuenta usa su propia estructura ya existente (avatar-preview
// + avatar-preview-fallback), ver setAvatarFallbackInitials_ más abajo.
// cacheBuster (opcional): pásalo (p. ej. Date.now()) justo después de subir
// o quitar la propia foto, para forzar al navegador a pedirla de nuevo en
// vez de mostrar la versión vieja que tenía en caché (ver wireAvatarUploader
// más abajo). En el resto de los casos (médicos vinculados, catálogo) se
// deja sin cache-buster para aprovechar el caché normalmente.
function avatarWithInitialsHTML_(accountType, id, name, sizePx, cacheBuster) {
  const initials = initialsFromName_(name);
  const fontSize = Math.max(9, Math.round(sizePx * 0.4));
  return `<span style="position:relative; display:inline-block; width:${sizePx}px; height:${sizePx}px; vertical-align:middle; margin-right:6px; flex-shrink:0;">
    <span style="position:absolute; inset:0; border-radius:50%; background:var(--accent-soft, #E8F0EC); color:var(--accent, #4F7A6F); display:flex; align-items:center; justify-content:center; font-size:${fontSize}px; font-weight:650;">${escapeHtml_(initials)}</span>
    <img class="avatar-clickable" data-avatar-name="${escapeHtml_(name || "")}" src="${avatarUrl(accountType, id, cacheBuster)}" alt=""
      style="position:absolute; inset:0; width:100%; height:100%; border-radius:50%; object-fit:cover; cursor:pointer; display:block;"
      onerror="this.style.visibility='hidden'" onload="this.style.visibility='visible'">
  </span>`;
}
// Actualiza el texto de un div.avatar-preview-fallback ya existente en el
// HTML (la foto grande de Cuenta) con las iniciales del nombre, y marca el
// <img> junto a él como clicable para la vista ampliada.
function setAvatarFallbackInitials_(fallbackEl, imgEl, name) {
  if (fallbackEl) fallbackEl.textContent = initialsFromName_(name);
  if (imgEl) {
    imgEl.classList.add("avatar-clickable");
    imgEl.dataset.avatarName = name || "";
  }
}
function ensureAvatarLightboxStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-lightbox-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-lightbox-styles";
  style.textContent = `
    .avatar-clickable { cursor: pointer; }
    .bp-lightbox-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.82); display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:260; padding:24px; box-sizing:border-box; cursor:zoom-out; }
    .bp-lightbox-img { max-width:min(85vw, 440px); max-height:75vh; border-radius:16px; box-shadow:0 10px 50px rgba(0,0,0,0.4); object-fit:contain; }
    .bp-lightbox-name { color:#fff; font-size:14px; margin-top:14px; font-weight:600; }
  `;
  document.head.appendChild(style);
}
function openAvatarLightbox_(url, name) {
  ensureAvatarLightboxStyles_();
  const overlay = document.createElement("div");
  overlay.className = "bp-lightbox-overlay";
  overlay.innerHTML = `<img class="bp-lightbox-img" src="${url}" alt="">` +
    (name ? `<div class="bp-lightbox-name">${escapeHtml_(name)}</div>` : "");
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}
function wireAvatarLightboxDelegation_() {
  if (typeof document === "undefined" || wireAvatarLightboxDelegation_._wired) return;
  wireAvatarLightboxDelegation_._wired = true;
  ensureAvatarLightboxStyles_();
  document.addEventListener("click", e => {
    const img = e.target.closest(".avatar-clickable");
    if (!img || !img.naturalWidth) return; // sin foto real (falló la carga), no hay nada que ampliar
    e.preventDefault();
    openAvatarLightbox_(img.src, img.dataset.avatarName || "");
  });
}
wireAvatarLightboxDelegation_();

// Redimensiona/comprime una imagen del lado del cliente antes de subirla,
// para que nunca se manden fotos de varios MB a la base de datos (Postgres
// no tiene por qué cargar con eso, y en móvil sube más rápido así). Regresa
// { base64, mime } listos para mandar a /api/account/avatar.
function resizeImageForAvatar_(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("no se pudo leer el archivo"));
    reader.onload = () => {
      img.onerror = () => reject(new Error("el archivo no es una imagen válida"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality || 0.85);
        resolve({ base64: dataUrl.split(",")[1], mime: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- Captura de foto con la cámara (v30.3.1) ----
// El atributo capture="user" de <input type="file"> solo abre la cámara en
// navegadores móviles (iOS/Android); en escritorio (Mac, Windows) los
// navegadores lo ignoran por completo y muestran el selector de archivos de
// siempre, sin ninguna forma de detectarlo de antemano — no es un bug de
// esta app, es que la especificación deja "capture" como una simple pista
// que el navegador puede ignorar. Por eso el botón "Tomar foto" ya NO usa
// un input de archivo: pide la cámara directamente con getUserMedia,
// muestra una vista previa en vivo en un recuadro propio, y el usuario
// captura el cuadro exacto que quiera. Esto funciona igual en escritorio y
// en móvil, sin depender de qué decida el navegador.
function ensureCameraCaptureStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-camera-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-camera-styles";
  style.textContent = `
    .bp-camera-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:250; padding:16px; box-sizing:border-box; }
    .bp-camera-card { background:#fff; border-radius:14px; padding:16px; max-width:420px; width:100%; box-shadow:0 10px 40px rgba(0,0,0,0.3); box-sizing:border-box; }
    .bp-camera-video, .bp-camera-preview { width:100%; border-radius:10px; background:#000; display:block; max-height:60vh; object-fit:contain; }
    .bp-camera-hint { font-size:12px; color:var(--text-muted, #7C8A85); margin-top:8px; text-align:center; }
    .bp-camera-actions { display:flex; gap:8px; margin-top:12px; }
    .bp-camera-actions button { flex:1; }
    .bp-camera-error { font-size:13px; color:#A6534B; margin-top:10px; }
  `;
  document.head.appendChild(style);
}
// onCaptured(blob) se llama SOLO cuando el usuario confirma la foto (Blob
// JPEG), lista para pasarse a resizeImageForAvatar_ igual que un archivo
// subido a mano. v30.3.2: después de capturar, se muestra el cuadro
// congelado con "Volver a tomar"/"Confirmar" antes de llamar onCaptured —
// antes se subía la foto en cuanto se presionaba el obturador, sin poder
// revisarla ni repetirla si salía mal.
function openCameraCapture_(onCaptured) {
  ensureCameraCaptureStyles_();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Este navegador no permite abrir la cámara desde aquí. Usa "Subir foto" en su lugar.');
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "bp-camera-overlay";
  overlay.innerHTML = `
    <div class="bp-camera-card">
      <video class="bp-camera-video" autoplay playsinline muted></video>
      <img class="bp-camera-preview" style="display:none;" alt="Foto capturada">
      <div class="bp-camera-hint" data-cam-hint>Encuadra tu foto y presiona Capturar.</div>
      <div class="bp-camera-error" style="display:none;"></div>
      <div class="bp-camera-actions">
        <button type="button" class="btn-secondary" data-cam-cancel>Cancelar</button>
        <button type="button" class="btn-primary" data-cam-shoot disabled>📸 Capturar</button>
        <button type="button" class="btn-secondary" data-cam-retake style="display:none;">🔄 Volver a tomar</button>
        <button type="button" class="btn-primary" data-cam-confirm style="display:none;">✅ Confirmar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector("video");
  const previewImgEl = overlay.querySelector(".bp-camera-preview");
  const hint = overlay.querySelector("[data-cam-hint]");
  const errBox = overlay.querySelector(".bp-camera-error");
  const cancelBtn = overlay.querySelector("[data-cam-cancel]");
  const shootBtn = overlay.querySelector("[data-cam-shoot]");
  const retakeBtn = overlay.querySelector("[data-cam-retake]");
  const confirmBtn = overlay.querySelector("[data-cam-confirm]");
  let stream = null;
  let capturedBlob = null;
  let capturedUrl = null;
  function cleanup() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    overlay.remove();
  }
  cancelBtn.addEventListener("click", cleanup);
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
    .then(s => { stream = s; video.srcObject = s; shootBtn.disabled = false; })
    .catch(err => {
      errBox.style.display = "block";
      errBox.textContent = "No se pudo abrir la cámara: " + (err && err.message ? err.message : "revisa el permiso de cámara de tu navegador para este sitio.");
    });
  shootBtn.addEventListener("click", () => {
    if (!video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) return;
      capturedBlob = blob;
      capturedUrl = URL.createObjectURL(blob);
      previewImgEl.src = capturedUrl;
      video.style.display = "none";
      previewImgEl.style.display = "block";
      hint.textContent = "¿Se ve bien? Confirma o vuelve a tomarla.";
      shootBtn.style.display = "none";
      cancelBtn.style.display = "none";
      retakeBtn.style.display = "";
      confirmBtn.style.display = "";
    }, "image/jpeg", 0.92);
  });
  retakeBtn.addEventListener("click", () => {
    if (capturedUrl) { URL.revokeObjectURL(capturedUrl); capturedUrl = null; }
    capturedBlob = null;
    previewImgEl.style.display = "none";
    video.style.display = "block";
    hint.textContent = "Encuadra tu foto y presiona Capturar.";
    shootBtn.style.display = "";
    cancelBtn.style.display = "";
    retakeBtn.style.display = "none";
    confirmBtn.style.display = "none";
  });
  confirmBtn.addEventListener("click", () => {
    const blob = capturedBlob;
    cleanup();
    if (blob) onCaptured(blob);
  });
}

// Conecta un <input type="file"> y/o un botón de "Tomar foto" con la
// subida/borrado de foto de perfil.
// opts: { fileInput, cameraButton, previewImg, removeBtn, accountType,
// accountId, onStatus } — cameraButton es un <button> normal (v30.3.1, ya no
// un <input capture=...>, ver openCameraCapture_ arriba). Ambos caminos
// comparten la misma lógica de redimensionar y subir.
// onStatus(kind, message): kind "loading" | "success" | "error", para que
// cada página lo muestre con su propio setStatus().
// v30.6: dos correcciones sobre la foto de perfil.
// (1) La imagen de /api/avatar/:type/:id se sirve con caché de 5 minutos
//     (Cache-Control), así que si algo vuelve a poner la misma URL (sin más)
//     en un <img>, el navegador puede mostrar la foto vieja del caché en vez
//     de pedir la nueva — por eso avatarUrl() SIEMPRE necesita un
//     cache-buster distinto justo después de subir o quitar una foto.
// (2) Elegir un archivo con "Subir foto" subía la imagen de inmediato, sin
//     ninguna vista previa ni forma de arrepentirse (a diferencia de la
//     cámara, que desde v30.3.2 sí pide confirmar o repetir). Ahora se
//     muestra una vista previa del archivo elegido con botones de Guardar y
//     Cancelar, y solo se sube al servidor cuando se confirma con Guardar.
function wireAvatarUploader(opts) {
  const { fileInput, cameraButton, previewImg, removeBtn, accountType, accountId, onStatus, onUploaded,
          actionsWrap, pendingWrap, saveBtn, cancelBtn } = opts;
  if (!fileInput && !cameraButton) return;
  let pendingFile = null;
  let pendingObjectUrl = null;
  function refreshPreview() {
    if (previewImg) previewImg.src = avatarUrl(accountType, accountId, Date.now());
  }
  function showPendingPreview(file) {
    pendingFile = file;
    if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
    pendingObjectUrl = URL.createObjectURL(file);
    if (previewImg) { previewImg.src = pendingObjectUrl; previewImg.classList.remove("avatar-hidden"); }
    if (actionsWrap) actionsWrap.style.display = "none";
    if (pendingWrap) pendingWrap.style.display = "";
  }
  function clearPending() {
    pendingFile = null;
    if (pendingObjectUrl) { URL.revokeObjectURL(pendingObjectUrl); pendingObjectUrl = null; }
    if (actionsWrap) actionsWrap.style.display = "";
    if (pendingWrap) pendingWrap.style.display = "none";
  }
  async function doUpload(file) {
    try {
      onStatus && onStatus("loading", "Subiendo foto…");
      const { base64, mime } = await resizeImageForAvatar_(file, 256, 0.85);
      const resp = await fetch("/api/account/avatar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data_base64: base64, mime }),
      });
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || "no se pudo subir la foto");
      clearPending();
      refreshPreview();
      onStatus && onStatus("success", "Foto de perfil actualizada.");
      onUploaded && onUploaded();
    } catch (err) {
      onStatus && onStatus("error", err.message);
    }
  }
  if (fileInput) fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) { onStatus && onStatus("error", "Elige un archivo de imagen."); return; }
    // Si hay botones de Guardar/Cancelar, se muestra la vista previa y se
    // espera confirmación; si la página no los tiene (compatibilidad hacia
    // atrás), se sube de inmediato como antes.
    if (saveBtn && cancelBtn) showPendingPreview(file);
    else doUpload(file);
  });
  if (cameraButton) cameraButton.addEventListener("click", () => openCameraCapture_(doUpload));
  if (saveBtn) saveBtn.addEventListener("click", () => { if (pendingFile) doUpload(pendingFile); });
  if (cancelBtn) cancelBtn.addEventListener("click", () => clearPending());
  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      try {
        onStatus && onStatus("loading", "Quitando foto…");
        const resp = await fetch("/api/account/avatar/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const json = await resp.json();
        if (!json.ok) throw new Error(json.error || "no se pudo quitar la foto");
        refreshPreview();
        onStatus && onStatus("success", "Foto de perfil quitada.");
        onUploaded && onUploaded();
      } catch (err) {
        onStatus && onStatus("error", err.message);
      }
    });
  }
  refreshPreview();
}

// ---- Mensajes generales del administrador (v30) ----
// Se guardan en localStorage los ids ya cerrados, para no repetir el mismo
// aviso una vez que el paciente/médico ya lo vio y lo cerró — pero si el
// administrador publica uno nuevo, ese sí se muestra aunque haya otros ya
// cerrados antes.
function ensureBroadcastStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-broadcast-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-broadcast-styles";
  style.textContent = `
    .bp-broadcast { background: #FBF6E9; border: 1px solid #EEDCA8; border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; font-size: 13px; display: flex; gap: 10px; align-items: flex-start; }
    .bp-broadcast .bp-broadcast-body { flex: 1; }
    .bp-broadcast strong { display: block; margin-bottom: 2px; }
    .bp-broadcast-close { background: none; border: none; cursor: pointer; font-size: 15px; color: #A5791E; padding: 0 2px; line-height: 1; }
  `;
  document.head.appendChild(style);
}
// Dibuja los mensajes generales activos ya obtenidos (sin volver a pedirlos)
// dentro de containerEl, respetando los que la persona ya cerró en este
// navegador. Lo usan tanto wireBroadcastBanner (paciente/médico, con sesión)
// como familia.html (sin sesión, los mensajes llegan junto con los demás
// datos del enlace de solo lectura).
function renderBroadcastsIntoContainer_(containerEl, broadcasts) {
  if (!containerEl) return;
  ensureBroadcastStyles_();
  const dismissedKey = "bp_dismissed_broadcasts";
  const dismissed = JSON.parse(localStorage.getItem(dismissedKey) || "[]");
  const toShow = (broadcasts || []).filter(b => dismissed.indexOf(b.id) === -1);
  containerEl.innerHTML = toShow.map(b => `
    <div class="bp-broadcast" data-id="${b.id}">
      <div class="bp-broadcast-body"><strong>📣 ${b.title}</strong>${b.body || ""}</div>
      <button type="button" class="bp-broadcast-close" data-dismiss="${b.id}" aria-label="Cerrar">✕</button>
    </div>`).join("");
  containerEl.querySelectorAll("[data-dismiss]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.dismiss;
      const list = JSON.parse(localStorage.getItem(dismissedKey) || "[]");
      list.push(id);
      localStorage.setItem(dismissedKey, JSON.stringify(list));
      btn.closest(".bp-broadcast").remove();
    });
  });
}
async function wireBroadcastBanner(containerEl) {
  if (!containerEl) return;
  try {
    const resp = await fetch("/api/broadcasts");
    const json = await resp.json();
    if (!json.ok) return;
    renderBroadcastsIntoContainer_(containerEl, json.data || []);
  } catch (err) { /* silencioso: un aviso que no cargó no debe romper la página */ }
}
function renderBroadcastBannerFromList(containerEl, broadcasts) {
  renderBroadcastsIntoContainer_(containerEl, broadcasts);
}

// ---- Tickets de soporte (v30) ----
// Widget autocontenido: formulario para abrir un ticket + lista de los
// propios + hilo de mensajes al abrir uno. authorRoleLabel es "patient" o
// "doctor" (para mostrar "Tú" en los mensajes propios en el hilo).
function ensureTicketStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-ticket-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-ticket-styles";
  style.textContent = `
    .bp-ticket-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 13px; }
    .bp-ticket-row:last-child { border-bottom: none; }
    .bp-ticket-row:hover { opacity: 0.8; }
    .bp-ticket-pill { font-size: 11px; font-weight: 650; padding: 3px 9px; border-radius: 20px; }
    .bp-ticket-pill.open { background: #FBF6E9; color: #A5791E; }
    .bp-ticket-pill.closed { background: var(--bg-page, #F4F7F5); color: var(--text-muted); }
    .bp-ticket-msg { padding: 9px 11px; border-radius: 10px; margin-bottom: 7px; font-size: 13px; max-width: 85%; }
    .bp-ticket-msg.mine { background: var(--accent-soft, #E8F0EC); margin-left: auto; }
    .bp-ticket-msg.other { background: var(--bg-page, #F4F7F5); }
    .bp-ticket-msg .who { font-size: 11px; color: var(--text-muted); margin-bottom: 2px; }
  `;
  document.head.appendChild(style);
}
function wireSupportTickets(opts) {
  const { listEl, formEl, subjectInput, messageInput, threadWrap, threadListEl, threadSubjectEl, replyForm, replyInput, backBtn, myRole, onStatus } = opts;
  if (!listEl) return;
  ensureTicketStyles_();
  let currentId = null;
  async function refreshList() {
    try {
      const resp = await fetch("/api/support/tickets");
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error);
      listEl.innerHTML = (json.data || []).length
        ? json.data.map(t => `
            <div class="bp-ticket-row" data-id="${t.id}">
              <span>${t.subject}</span>
              <span class="bp-ticket-pill ${t.status}">${t.status === "open" ? "Abierto" : "Cerrado"}</span>
            </div>`).join("")
        : `<div style="font-size:13px;color:var(--text-muted);">Todavía no has abierto ningún ticket.</div>`;
    } catch (err) { onStatus && onStatus("error", err.message); }
  }
  async function openThread(id) {
    try {
      currentId = id;
      const resp = await fetch(`/api/support/tickets/${id}/messages`);
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error);
      threadSubjectEl.textContent = json.data.ticket.subject;
      threadListEl.innerHTML = json.data.messages.map(m => `
        <div class="bp-ticket-msg ${m.author_role === myRole ? "mine" : "other"}">
          <div class="who">${m.author_role === myRole ? "Tú" : (m.author_role === "admin" ? "Soporte" : m.author_role)}</div>
          ${m.text}
        </div>`).join("");
      listEl.parentElement.style.display = "none";
      threadWrap.style.display = "block";
    } catch (err) { onStatus && onStatus("error", err.message); }
  }
  listEl.addEventListener("click", e => {
    const row = e.target.closest(".bp-ticket-row");
    if (row) openThread(row.dataset.id);
  });
  if (backBtn) backBtn.addEventListener("click", () => {
    threadWrap.style.display = "none";
    listEl.parentElement.style.display = "block";
    refreshList();
  });
  if (formEl) formEl.addEventListener("submit", async e => {
    e.preventDefault();
    const subject = subjectInput.value.trim();
    const message = messageInput.value.trim();
    if (!subject || !message) return;
    try {
      onStatus && onStatus("loading", "Enviando…");
      const resp = await fetch("/api/support/tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, message }) });
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error);
      subjectInput.value = ""; messageInput.value = "";
      onStatus && onStatus("success", "Ticket enviado. Te responderemos aquí mismo.");
      await refreshList();
    } catch (err) { onStatus && onStatus("error", err.message); }
  });
  if (replyForm) replyForm.addEventListener("submit", async e => {
    e.preventDefault();
    const text = replyInput.value.trim();
    if (!text || !currentId) return;
    try {
      const resp = await fetch(`/api/support/tickets/${currentId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error);
      replyInput.value = "";
      await openThread(currentId);
    } catch (err) { onStatus && onStatus("error", err.message); }
  });
  refreshList();
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
    .pw-field input { padding-right: 44px !important; }
    .pw-toggle { position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
      width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
      background: none; border: none; cursor: pointer; font-size: 16px; line-height: 1;
      padding: 0; color: var(--text-muted); }
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
