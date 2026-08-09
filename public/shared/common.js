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
    if (!groups.has(key)) groups.set(key, { key, label, sys: [], dia: [], hr: [], weight: [], medicated: [], obs: [], related: [] });
    const g = groups.get(key);
    if (r.sys != null) g.sys.push(r.sys);
    if (r.dia != null) g.dia.push(r.dia);
    if (r.hr != null) g.hr.push(r.hr);
    if (r.weight != null) g.weight.push(r.weight);
    g.medicated.push(r.medicated ? 1 : 0);
    if (r.obs && String(r.obs).trim()) g.obs.push(String(r.obs).trim());
    g.related.push(!!r.related_type);
  });
  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return Array.from(groups.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(g => ({ key: g.key, label: g.label, sys: avg(g.sys), dia: avg(g.dia), hr: avg(g.hr), weight: avg(g.weight), medicated: avg(g.medicated), obs: g.obs.join(" · "), count: Math.max(g.sys.length, g.dia.length),
      // v31: true si AL MENOS una lectura de este grupo (ej. de esta hora,
      // si se agrupó por hora) está relacionada con otra sección.
      related: g.related.some(Boolean) }));
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
      // v31: "Relacionar con" — si esta lectura está ligada a un ejercicio,
      // síntoma o actividad de wellness, se marca para pintarse distinto en
      // la gráfica de Tendencia (ver relatedPointStyles_ más abajo).
      related: !!r.related_type,
    }));
}
// ---- v31: "Relacionar con" — colorear distinto en la gráfica las lecturas
// ligadas a un ejercicio/síntoma/actividad de wellness. ----
const RELATED_TYPE_LABELS_ = { exercise: "Ejercicio", symptom: "Síntoma", wellness: "Wellness" };
const RELATED_POINT_COLOR_ = "#8B5CF6"; // morado, distinto de sys/dia/hr/peso
// Arma los arreglos pointBackgroundColor/pointBorderColor/pointRadius que
// Chart.js necesita para pintar solo ALGUNOS puntos de un dataset distinto
// (los "related"), sin tocar el color de línea normal del resto.
function relatedPointStyles_(grouped, baseColor) {
  return {
    pointBackgroundColor: grouped.map(g => g.related ? RELATED_POINT_COLOR_ : baseColor),
    pointBorderColor: grouped.map(g => g.related ? RELATED_POINT_COLOR_ : baseColor),
    pointRadius: grouped.map(g => g.related ? 6 : 3),
    pointHoverRadius: grouped.map(g => g.related ? 8 : 5),
  };
}
function anyRelatedInGrouped_(grouped) {
  return (grouped || []).some(g => g.related);
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

// ---- Comparación por día de la semana (v30.14) ----
// Para "Estadísticas": promedia sys/dia/hr agrupando las lecturas por día de
// la semana (Lunes a Domingo), opcionalmente acotadas primero a una franja
// horaria (reutiliza filterByTimeView — "todas" o mañana/tarde/noche/
// madrugada) y siempre acotadas al periodo elegido (semana, mes o año).
// Responde preguntas como "¿mis mañanas del lunes suelen ser más altas que
// las del viernes?". Siempre regresa los 7 días en el mismo orden (lunes
// primero), aunque alguno no tenga lecturas (sys/dia/hr en null, para que la
// gráfica muestre el hueco en vez de desaparecer la barra).
const WEEKDAY_BUCKETS_ = [
  { key: 0, label: "Lunes" },
  { key: 1, label: "Martes" },
  { key: 2, label: "Miércoles" },
  { key: 3, label: "Jueves" },
  { key: 4, label: "Viernes" },
  { key: 5, label: "Sábado" },
  { key: 6, label: "Domingo" },
];
function dateStrToWeekday_(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return (d.getDay() + 6) % 7; // lunes = 0 ... domingo = 6
}
function weekdayComparisonData(data, granularity, timeView) {
  const periodFiltered = filterByPeriod(data, granularity || "month");
  const timeFiltered = filterByTimeView(periodFiltered, timeView);
  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return WEEKDAY_BUCKETS_.map(bucket => {
    const bucketData = timeFiltered.filter(r => dateStrToWeekday_(r.date) === bucket.key);
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
// v30.19: cuando el periodo "Día" trae su propio selector de fecha (en vez
// de fijarse siempre a "hoy"), esto filtra a ESE día exacto — a diferencia
// de filterByPeriodField_(data, "day", ...), que siempre eran "las últimas
// 24 horas desde ahora" (o sea, siempre hoy). dateField es "date" (lecturas)
// o "fecha" (historial de laboratorio), igual que filterByPeriodField_.
function filterByExactDate_(data, dateStr, dateField) {
  if (!dateStr) return [];
  return (data || []).filter(r => r[dateField] === dateStr);
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

// ---- Presión Arterial Media / PAM (v30.16) ----
// PAM = (sistólica + 2 × diastólica) / 3 — el promedio de presión que en
// realidad "sienten" los órganos durante todo el ciclo cardíaco (el corazón
// pasa más tiempo en diástole que en sístole, por eso el diastólico pesa el
// doble en la fórmula, no un simple promedio de los dos números). No
// sustituye la clasificación AHA de cada lectura; es una métrica aparte que
// se calcula al vuelo a partir de sys/dia, sin guardarse en la base de
// datos.
function pamValue_(sys, dia) {
  if (sys == null || dia == null) return null;
  return Math.round(((sys + 2 * dia) / 3) * 10) / 10;
}
function pamSeriesForReadings_(data) {
  const filtered = (data || []).filter(r => r.sys != null && r.dia != null);
  return {
    labels: filtered.map(r => fmtDate(r.date) + (r.time ? " " + r.time : "")),
    values: filtered.map(r => pamValue_(r.sys, r.dia)),
    obs: filtered.map(r => r.obs || ""),
  };
}
// v30.17: rango "óptimo" de PAM citado por referencias clínicas generales
// (70-100 mmHg garantiza buena perfusión de cerebro/riñones/corazón); por
// debajo de 60-65 mmHg hay riesgo de isquemia, y sostenido por arriba de 100
// implica esfuerzo excesivo para el corazón. Se usa para pintar la banda de
// fondo de la gráfica de PAM en Estadísticas.
const PAM_IDEAL_RANGE = { min: 70, max: 100, color: "rgba(111, 169, 140, 0.15)" };
// v30.17: banda de fondo para un rango "ideal" (por ahora, solo la usa PAM)
// — un plugin de Chart.js normal (no un plugin global registrado, que
// afectaría TODAS las gráficas de la app) que se pasa por gráfica en el
// arreglo `plugins` del constructor, así que solo pinta cuando el que llama
// a renderMetricTrendChart manda opts.idealRange. Dibuja el rectángulo antes
// de las líneas/puntos (beforeDatasetsDraw) usando la escala Y ya calculada,
// para que la banda quede exactamente entre min y max del rango.
function idealRangeBandPlugin_(range) {
  return {
    id: "idealRangeBand",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const yScale = scales.y;
      if (!chartArea || !yScale) return;
      const yTop = yScale.getPixelForValue(range.max);
      const yBottom = yScale.getPixelForValue(range.min);
      ctx.save();
      ctx.fillStyle = range.color || "rgba(111, 169, 140, 0.15)";
      ctx.fillRect(chartArea.left, yTop, chartArea.right - chartArea.left, yBottom - yTop);
      ctx.restore();
    },
  };
}
function renderMetricTrendChart(prevInstance, canvasEl, emptyEl, series, opts) {
  if (prevInstance) prevInstance.destroy();
  const hasData = series.values.length > 0;
  if (emptyEl) emptyEl.style.display = hasData ? "none" : "block";
  if (canvasEl) canvasEl.style.display = hasData ? "" : "none";
  if (!hasData || !canvasEl) return null;
  const ctx = canvasEl.getContext("2d");
  const idealRange = opts.idealRange;
  // Con banda ideal: el eje siempre incluye ese rango (con algo de margen),
  // aunque todas las lecturas caigan muy por arriba o por abajo — si no, la
  // banda podría quedar fuera de la vista y parecer que no existe.
  const yScaleOpts = { title: { display: true, text: opts.unit || "" }, beginAtZero: false };
  if (idealRange) {
    const vals = series.values.filter(v => v != null);
    yScaleOpts.suggestedMin = Math.min(idealRange.min - 10, ...vals);
    yScaleOpts.suggestedMax = Math.max(idealRange.max + 10, ...vals);
  }
  return new Chart(ctx, {
    type: "line",
    data: { labels: series.labels, datasets: [{
      label: opts.label, data: series.values, borderColor: opts.color, backgroundColor: opts.color,
      tension: 0.25, spanGaps: true, pointRadius: 3,
    }] },
    plugins: idealRange ? [idealRangeBandPlugin_(idealRange)] : [],
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
      scales: { y: yScaleOpts },
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
  { version: "32.0", changes: [
    "Nueva sección Sueño: hora de inicio y fin (la duración se calcula sola, editable a mano) y calidad de sueño opcional en escala 1-10. Nuevas gráficas de duración y calidad de sueño en Estadísticas.",
    "Nueva Interpretación con IA en Estadísticas: junta tus capturas del periodo elegido (presión, sueño, ejercicio, malos hábitos, síntomas, wellness, medicamentos y laboratorios) y genera una lectura en lenguaje sencillo. No sustituye a tu médico.",
  ] },
  { version: "31.1", changes: [
    "El selector de localización de dolor de cabeza ahora usa las 14 imágenes de referencia reales (en vez del dibujo esquemático anterior), para identificar mejor dónde duele.",
  ] },
  { version: "31.0", changes: [
    "Ejercicio: hora de inicio y fin (la duración se calcula sola, editable a mano) y métricas especializadas por tipo (distancia, FC promedio, series/repeticiones/peso levantado, escalones, según aplique).",
    "Nuevo panel de captura de presión arterial durante actividad física en la sección Ejercicio, con su propia gráfica e historial, independiente de la Presión Arterial en reposo.",
    "Nueva sección Wellness: meditación, vapor, sauna, lectura/audiolibro en reposo, pintura, dibujo, escritura, etc.",
    "Para el síntoma \"Dolor de cabeza\", nuevo selector gráfico de localización (puedes elegir más de una zona) — solo ubicación, no un diagnóstico.",
    "Nuevo botón \"Relacionar con\" en Agregar Lectura: liga la lectura con un ejercicio, síntoma o actividad de wellness reciente, lo anota en Observaciones y la resalta en la gráfica de Tendencia.",
  ] },
  { version: "30.19", changes: [
    "Al elegir \"Día\" en las gráficas de PAM y Frecuencia cardíaca (Estadísticas), ahora aparece un selector de fecha para ver cualquier día concreto, en vez de fijarse siempre a hoy.",
  ] },
  { version: "30.18", changes: [
    "En Estadísticas, la gráfica de Presión Arterial Media (PAM) ahora aparece hasta arriba, justo después del filtro general.",
    "Nuevo filtro \"Día\" en las gráficas de PAM y Frecuencia cardíaca.",
  ] },
  { version: "30.17", changes: [
    "La gráfica de PAM en Estadísticas ahora muestra una banda verde con el rango óptimo (70-100 mmHg) de fondo, más una guía con la interpretación clínica (rango óptimo, límite crítico inferior y límite superior elevado).",
  ] },
  { version: "30.16", changes: [
    "Nueva gráfica en Estadísticas: Presión Arterial Media (PAM), calculada como (Sistólica + 2 × Diastólica) / 3.",
    "En Medicamentos, la sección \"Medicamento eventual\" ahora aparece justo debajo de \"Tomas de hoy\".",
  ] },
  { version: "30.15", changes: [
    "Comparar por día de la semana ahora también muestra la frecuencia cardíaca promedio (línea, con su propio eje), no solo sistólica y diastólica.",
  ] },
  { version: "30.14", changes: [
    "Nueva gráfica en Estadísticas: Comparar por día de la semana. Agrupa tus lecturas por lunes, martes, etc., con la opción de acotarlas primero a una franja horaria (por ejemplo, comparar solo tus mañanas del lunes contra las del viernes).",
  ] },
  { version: "30.13", changes: [
    "Corregido: la fecha de inicio de tratamiento en Medicamentos se veía descuadrada.",
    "Nuevo síntoma: temblor de ojo (tic palpebral).",
    "En Tomas de hoy ahora se muestra la fecha junto a la hora de cada toma.",
    "Nueva Bitácora de medicamentos dentro de la pestaña Medicamentos: resumen día por día de tomas programadas y eventuales de los últimos 30 días.",
    "Nueva sección de medicamentos eventuales en Medicamentos, para registrar tomas fuera de tu plan regular (aspirina, paracetamol, antiácidos, etc.).",
  ] },
  { version: "30.12", changes: [
    "Corregido: en Medicamentos, los campos de frecuencia y el aviso de tratamiento indefinido se veían apretados/descuadrados.",
    "Nueva sección de Consultas médicas: fecha, con qué médico, motivo, foto de la receta y próxima cita (o \"Sin cita programada\").",
    "Nuevo catálogo de síntomas con la escala más adecuada para cada uno: intensidad 1-10 para la mayoría, y temperatura real en °C para Fiebre. Se agregaron zumbido de oídos (tinnitus), irritación en la piel, dolor de huesos y cuerpo cortado.",
  ] },
  { version: "30.11", changes: [
    "Corregido: el recordatorio de una toma programada para más tarde hoy ya no sonaba de inmediato al crear el medicamento.",
    "Nueva interfaz de frecuencia en Medicamentos: además de cada cuántas horas, ahora se puede indicar cada cuántos días o semanas.",
    "Nuevo campo de duración del tratamiento en Medicamentos: fecha de inicio y fecha de fin, o periodo indefinido.",
    "Nuevas gráficas en Estadísticas: calorías quemadas por ejercicio y porcentaje de apego a los medicamentos.",
  ] },
  { version: "30.10", changes: [
    "Corregido: el panel de notificaciones se salía de la pantalla en móvil.",
    "Nueva pestaña de Ejercicio: registra tipo, duración y fecha; las calorías se calculan solas con tu peso, estatura, edad y género.",
    "Nuevo campo de estatura en Parámetros.",
    "Las gráficas de Estadísticas ya no parpadean todas cuando usas el filtro propio de una sola.",
    "El Directorio Médico (antes \"Catálogo de médicos\") se movió al final de las pestañas, con su propio estilo, como valor agregado.",
  ] },
  { version: "30.9", changes: [
    "Nuevo perfil ampliado para médicos en el catálogo (carta de presentación): modalidad de atención, subespecialidad, años de experiencia, idiomas, aseguradoras, formación, distinciones y más, todo opcional salvo lo mínimo para publicarse.",
    "El filtro general de Estadísticas ahora vuelve a sincronizar todas las gráficas, incluso las que tenían su propio filtro independiente.",
    "Revisión a fondo de las notificaciones push: mensaje claro en iPhone cuando falta anclar la app a la pantalla de inicio.",
    "Nueva animación de 3 latidos de corazón al agregar una lectura.",
  ] },
  { version: "30.8", changes: [
    "Nueva sección de Medicamentos: nombre, sustancia activa, miligramos, dosis y cada cuánto debe tomarse. El calendario semanal se calcula solo, a partir de la frecuencia.",
    "Recordatorio push para tomar el medicamento, con casilla para marcarlo como tomado; si no se marca, se vuelve a recordar cada 30 minutos hasta la siguiente toma.",
    "Las gráficas de Estadísticas ahora tienen un filtro general y, además, cada gráfica puede tener su propio filtro independiente, con un botón para quitarlos todos.",
    "Nueva animación al cambiar de pestaña, separada del efecto de confeti de los demás botones.",
  ] },
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
// v30.9: modalidad de atención — campo obligatorio para publicarse, junto
// con especialidad y contacto (lo mínimo para que alguien sepa si le sirve
// este médico antes de contactarlo).
const CONSULTATION_MODE_LABELS = { presencial: "📍 Presencial", virtual: "💻 Virtual", ambos: "📍💻 Presencial y virtual" };
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
    .catalog-card-subspecialty { font-size: 12px; color: var(--text-muted); margin-top: 1px; }
    .catalog-card-bio { font-size: 13px; margin-top: 4px; }
    .catalog-card-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .catalog-card-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .catalog-card-badge { font-size: 11px; background: var(--accent-soft); color: var(--accent-hover, var(--accent)); border-radius: 6px; padding: 2px 7px; }
    .catalog-card-more { margin-top: 6px; }
    .catalog-card-more summary { font-size: 12px; color: var(--accent); cursor: pointer; }
    .catalog-card-more-section { margin-top: 8px; }
    .catalog-card-more-section h4 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); margin: 0 0 3px; }
    .catalog-card-more-section ul { margin: 0; padding-left: 16px; font-size: 12.5px; }
    .catalog-card-more-section p { margin: 0; font-size: 12.5px; }
  `;
  document.head.appendChild(style);
}
// education/professional_activities/distinctions/associations se guardan
// como texto libre, un punto por línea (ver update_doctor_catalog_profile en
// db-postgres.js); aquí se parten en líneas no vacías para pintarse como
// lista, igual que el perfil de referencia de hospital que inspiró esto.
function bulletLinesHTML_(text) {
  const lines = String(text || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  return `<ul>${lines.map(l => `<li>${escapeHtml_(l)}</li>`).join("")}</ul>`;
}
function doctorCatalogCardHTML_(d) {
  const badges = [];
  if (d.consultation_mode) badges.push(CONSULTATION_MODE_LABELS[d.consultation_mode] || "");
  if (d.years_experience) badges.push(`🎓 ${d.years_experience} año${d.years_experience === 1 ? "" : "s"} de experiencia`);
  const metaParts = [d.catalog_city, d.catalog_contact, d.languages].filter(Boolean);
  const moreSections = [
    d.education && { title: "Formación académica", body: bulletLinesHTML_(d.education) },
    d.professional_activities && { title: "Actividades profesionales", body: bulletLinesHTML_(d.professional_activities) },
    d.distinctions && { title: "Distinciones", body: bulletLinesHTML_(d.distinctions) },
    d.associations && { title: "Asociaciones", body: bulletLinesHTML_(d.associations) },
    d.insurances && { title: "Aseguradoras", body: `<p>${escapeHtml_(d.insurances)}</p>` },
    d.schedule_note && { title: "Horario de atención", body: `<p>${escapeHtml_(d.schedule_note)}</p>` },
    d.website && { title: "Más información", body: `<p>${escapeHtml_(d.website)}</p>` },
  ].filter(Boolean);
  return `
    <div class="catalog-card">
      ${avatarWithInitialsHTML_("doctor", d.id, d.name, 40)}
      <div class="catalog-card-body">
        <div class="catalog-card-name">${escapeHtml_(d.title || "Dr(a).")} ${escapeHtml_(d.name)}</div>
        ${d.subspecialty ? `<div class="catalog-card-subspecialty">${escapeHtml_(d.subspecialty)}</div>` : ""}
        ${d.catalog_bio ? `<div class="catalog-card-bio">${escapeHtml_(d.catalog_bio)}</div>` : ""}
        ${badges.length ? `<div class="catalog-card-badges">${badges.map(b => `<span class="catalog-card-badge">${b}</span>`).join("")}</div>` : ""}
        ${metaParts.length ? `<div class="catalog-card-meta">${metaParts.map(escapeHtml_).join(" · ")}</div>` : ""}
        ${moreSections.length ? `
          <details class="catalog-card-more">
            <summary>Ver perfil completo</summary>
            ${moreSections.map(s => `<div class="catalog-card-more-section"><h4>${s.title}</h4>${s.body}</div>`).join("")}
          </details>` : ""}
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

// ---- Síntomas diarios (v30.4; catálogo con escala propia en v30.12) ----
// Cada síntoma trae la escala más adecuada para registrarlo. La mayoría usa
// intensidad subjetiva 1-10 (1 casi imperceptible, 10 máximo/insoportable) —
// es la misma escala tipo "dolor" que se usa en consultorios, y mantenerla
// igual entre síntomas ayuda a comparar a lo largo del tiempo sin aprender
// una escala distinta para cada uno. Fiebre es la excepción a propósito: un
// grado real en °C es un dato objetivo mucho más útil para el médico que
// una intensidad subjetiva, así que ahí se pide temperatura en vez de 1-10.
const SYMPTOM_CATALOG = [
  { value: "dolor_cabeza", label: "Dolor de cabeza", scale: "intensity" },
  { value: "mareo", label: "Mareo", scale: "intensity" },
  { value: "palpitaciones", label: "Palpitaciones", scale: "intensity" },
  { value: "vision_borrosa", label: "Visión borrosa", scale: "intensity" },
  { value: "nausea", label: "Náusea", scale: "intensity" },
  { value: "fatiga", label: "Fatiga", scale: "intensity" },
  { value: "dificultad_respirar", label: "Dificultad para respirar", scale: "intensity" },
  { value: "dolor_pecho", label: "Dolor en el pecho", scale: "intensity" },
  { value: "zumbido_oidos", label: "Zumbido en los oídos (tinnitus)", scale: "intensity" },
  { value: "irritacion_piel", label: "Irritación en la piel", scale: "intensity" },
  { value: "dolor_huesos", label: "Dolor de huesos", scale: "intensity" },
  { value: "cuerpo_cortado", label: "Cuerpo cortado (malestar general)", scale: "intensity" },
  { value: "temblor_ojo", label: "Temblor de ojo (tic palpebral)", scale: "intensity" },
  { value: "fiebre", label: "Fiebre", scale: "temperature" },
  { value: "otro", label: "Otro", scale: "intensity" },
];
function symptomCatalogEntry_(value) {
  return SYMPTOM_CATALOG.find(s => s.value === value) || null;
}
const SYMPTOM_INTENSITY_LABELS_ = {
  1: "Casi imperceptible", 2: "Muy leve", 3: "Leve", 4: "Leve-moderado", 5: "Moderado",
  6: "Moderado-fuerte", 7: "Fuerte", 8: "Muy fuerte", 9: "Severo", 10: "Máximo / insoportable",
};
// Nota clínica orientativa (no se guarda, solo ayuda a leer el número):
// febrícula 37.5-38, fiebre 38-39, fiebre alta 39-40, urgente 40+.
function feverNote_(temp) {
  if (temp == null) return "";
  if (temp < 37.5) return "";
  if (temp < 38) return " (febrícula)";
  if (temp < 39) return " (fiebre)";
  if (temp < 40) return " (fiebre alta)";
  return " (muy alta, busca atención pronto)";
}
function symptomEntryHTML_(s, opts) {
  opts = opts || {};
  const deleteBtn = opts.readOnly ? "" : `<button type="button" class="btn-mini danger symptom-delete-btn" data-symptom-id="${s.id}">Eliminar</button>`;
  let scaleChip = "";
  if (s.temperatura != null) {
    scaleChip = `<span class="symptom-scale-chip symptom-scale-temp">${s.temperatura}°C${escapeHtml_(feverNote_(Number(s.temperatura)))}</span>`;
  } else if (s.severidad != null) {
    const n = Math.round(Number(s.severidad));
    scaleChip = `<span class="symptom-scale-chip">Intensidad ${n}/10 – ${escapeHtml_(SYMPTOM_INTENSITY_LABELS_[n] || "")}</span>`;
  }
  // v31: si el síntoma es dolor de cabeza y tiene ubicaciones guardadas, se
  // muestran como chips de solo lectura (nunca el dibujo interactivo aquí,
  // eso solo vive en el formulario de captura).
  const headPainSummary = headPainLocationsSummaryHTML_(s.ubicaciones_dolor);
  return `
    <div class="habit-entry" data-symptom-id="${s.id}">
      <div class="habit-entry-icon">🌡️</div>
      <div class="habit-entry-body">
        <div class="habit-entry-title">${escapeHtml_(s.sintoma)}</div>
        ${scaleChip}
        ${headPainSummary}
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
function ensureSymptomStyles_() {
  ensureHeadPainStyles_(); // v31: estilos del selector/resumen de ubicación de dolor de cabeza
  if (typeof document === "undefined" || document.getElementById("bp-symptom-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-symptom-styles";
  style.textContent = `
    .symptom-scale-chip { display: inline-block; font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 20px; margin-top: 3px; }
    .symptom-scale-chip.symptom-scale-temp { color: #A6534B; background: #FBEFEE; }
    .symptom-intensity-wrap { display: flex; align-items: center; gap: 10px; }
    .symptom-intensity-wrap input[type="range"] { flex: 1; }
    .symptom-intensity-value { font-size: 12px; font-weight: 650; color: var(--accent); min-width: 118px; text-align: right; }
  `;
  document.head.appendChild(style);
}

// ---- Medicamentos (v30.8) ----
// El calendario semanal no se captura a mano: el servidor ya manda, por cada
// medicamento, las horas del día calculadas a partir de la frecuencia (ver
// computeDoseTimes_ en db-postgres.js). Aquí solo se pintan como una
// cuadrícula de 7 días con esas mismas horas repetidas cada día (una toma
// programada por horas se repite todos los días, no varía por día de la
// semana), a modo de vista de solo lectura del horario.
const MEDICATION_WEEKDAY_LABELS_ = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
function medicationWeeklyCalendarHTML_(times) {
  if (!times || !times.length) {
    return `<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">Sin horario calculado todavía.</div>`;
  }
  const cols = MEDICATION_WEEKDAY_LABELS_.map(day => `
    <div class="med-cal-day">
      <div class="med-cal-day-label">${day}</div>
      ${times.map(t => `<div class="med-cal-chip">${escapeHtml_(t)}</div>`).join("")}
    </div>`).join("");
  return `<div class="med-cal-grid">${cols}</div>`;
}
// v30.11: descripción de la frecuencia según la unidad (antes solo existían
// horas, tope de 24 — no alcanzaba para "cada 3 días" ni "cada semana").
function medicationFrequencyLabel_(m) {
  const unit = m.frequency_unit || "hours";
  const value = m.frequency_value != null ? m.frequency_value : m.frequency_hours;
  if (value == null) return "";
  const n = Number(value);
  if (unit === "days") return `Cada ${n} día${n === 1 ? "" : "s"}`;
  if (unit === "weeks") return `Cada ${n === 1 ? "semana" : n + " semanas"}`;
  return `Cada ${n} hora${n === 1 ? "" : "s"}`;
}
// Rango de vigencia del tratamiento: "Desde dd/mm/aaaa" (indefinido) o
// "Del dd/mm/aaaa al dd/mm/aaaa" si tiene fecha de fin.
function medicationDateRangeLabel_(m) {
  if (!m.start_date) return "";
  const fmt = s => s.split("-").reverse().join("/");
  return m.end_date ? `Del ${fmt(m.start_date)} al ${fmt(m.end_date)}` : `Desde ${fmt(m.start_date)}, indefinido`;
}
function medicationEntryHTML_(m, opts) {
  opts = opts || {};
  const detailParts = [];
  if (m.active_substance) detailParts.push(escapeHtml_(m.active_substance));
  if (m.mg != null) detailParts.push(`${m.mg} mg`);
  if (m.dose_text) detailParts.push(escapeHtml_(m.dose_text));
  const unit = m.frequency_unit || "hours";
  const freqBase = medicationFrequencyLabel_(m);
  const freqLabel = freqBase
    ? `${freqBase}${m.first_dose_time ? " · primera toma " + escapeHtml_(m.first_dose_time) : ""}`
    : "";
  const dateRangeLabel = medicationDateRangeLabel_(m);
  const actions = opts.readOnly ? "" : `
    <div class="med-entry-actions">
      <button type="button" class="btn-mini medication-edit-btn" data-medication-id="${m.id}">Editar</button>
      <button type="button" class="btn-mini danger medication-delete-btn" data-medication-id="${m.id}">Eliminar</button>
    </div>`;
  // El calendario semanal (cuadrícula de 7 días) solo tiene sentido para
  // frecuencia por horas, donde de verdad se repite todos los días; para
  // días/semanas se muestra en su lugar el rango de vigencia como texto.
  const scheduleHTML = unit === "hours"
    ? medicationWeeklyCalendarHTML_(m.times)
    : (dateRangeLabel ? `<div class="med-entry-daterange">📅 ${escapeHtml_(dateRangeLabel)}</div>` : "");
  return `
    <div class="med-entry" data-medication-id="${m.id}">
      <div class="med-entry-header">
        <div class="med-entry-title">💊 ${escapeHtml_(m.name)}</div>
        ${actions}
      </div>
      ${detailParts.length ? `<div class="med-entry-detail">${detailParts.join(" · ")}</div>` : ""}
      ${freqLabel ? `<div class="med-entry-freq">${freqLabel}</div>` : ""}
      ${unit === "hours" && dateRangeLabel ? `<div class="med-entry-daterange">📅 ${escapeHtml_(dateRangeLabel)}</div>` : ""}
      ${scheduleHTML}
    </div>`;
}
// opts: { readOnly } — doctor.html y familia.html usan readOnly:true.
function renderMedicationsListHTML(medications, opts) {
  if (!medications || !medications.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no se ha registrado ningún medicamento.</div>`;
  }
  return medications.map(m => medicationEntryHTML_(m, opts)).join("");
}
function ensureMedicationStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-medication-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-medication-styles";
  style.textContent = `
    .med-entry { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .med-entry:last-child { border-bottom: none; }
    .med-entry-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .med-entry-title { font-weight: 650; font-size: 14px; }
    .med-entry-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .med-entry-detail { font-size: 13px; color: var(--text); margin-top: 3px; }
    .med-entry-freq { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .med-entry-daterange { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .med-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-top: 8px; }
    .med-cal-day { text-align: center; background: var(--accent-soft); border-radius: 8px; padding: 5px 2px; }
    .med-cal-day-label { font-size: 10.5px; font-weight: 700; color: var(--text-muted); margin-bottom: 3px; }
    .med-cal-chip { font-size: 10px; background: var(--bg-page, white); color: var(--accent-hover, var(--accent)); border-radius: 5px; padding: 1px 2px; margin-top: 2px; }
    @media (max-width: 560px) {
      .med-cal-grid { grid-template-columns: repeat(7, 1fr); gap: 3px; }
      .med-cal-day-label { font-size: 9px; }
      .med-cal-chip { font-size: 8.5px; }
    }
    .med-dose-today-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); cursor: pointer; }
    .med-dose-today-row:last-child { border-bottom: none; }
    .med-dose-today-row input[type="checkbox"] { width: 18px; height: 18px; flex-shrink: 0; }
    .med-dose-time { font-weight: 700; font-size: 13px; color: var(--accent); min-width: 78px; }
    .med-dose-date { font-weight: 500; font-size: 11px; color: var(--text-muted); }
    .med-dose-name { font-size: 13px; color: var(--text); }
    .med-dose-today-row.is-taken .med-dose-name, .med-dose-today-row.is-taken .med-dose-time { color: var(--text-muted); text-decoration: line-through; }
    .eventual-med-entry { padding: 10px 0; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .eventual-med-entry:last-child { border-bottom: none; }
    .eventual-med-title { font-weight: 650; font-size: 13.5px; }
    .eventual-med-detail { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .medlog-day { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .medlog-day:last-child { border-bottom: none; }
    .medlog-day-date { font-weight: 700; font-size: 13px; color: var(--text); margin-bottom: 6px; }
    .medlog-item { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 3px 0; flex-wrap: wrap; }
    .medlog-time { font-weight: 650; color: var(--accent); min-width: 42px; }
    .medlog-name { color: var(--text); flex: 1; min-width: 120px; }
    .medlog-status { font-size: 11.5px; color: var(--text-muted); }
    .medlog-item.is-taken .medlog-status { color: #4F9E8C; font-weight: 600; }
    .medlog-item.is-missed .medlog-status { color: #C97064; }
    .medlog-item-eventual .medlog-time { color: #B0559B; }
    .medlog-notes { font-size: 11.5px; color: var(--text-muted); font-style: italic; }
  `;
  document.head.appendChild(style);
}
// ---- Medicamentos eventuales (v30.13) ----
function eventualMedicationEntryHTML_(e, opts) {
  opts = opts || {};
  const deleteBtn = opts.readOnly ? "" : `<button type="button" class="btn-mini danger eventual-med-delete-btn" data-eventual-id="${e.id}">Eliminar</button>`;
  const detailParts = [fmtDate(e.fecha)];
  if (e.hora) detailParts.push(escapeHtml_(e.hora));
  if (e.dosis) detailParts.push(escapeHtml_(e.dosis));
  return `
    <div class="eventual-med-entry" data-eventual-id="${e.id}">
      <div>
        <div class="eventual-med-title">🩹 ${escapeHtml_(e.nombre)}</div>
        <div class="eventual-med-detail">${detailParts.join(" · ")}</div>
        ${e.notas ? `<div class="eventual-med-detail">${escapeHtml_(e.notas)}</div>` : ""}
      </div>
      ${deleteBtn}
    </div>`;
}
// opts: { readOnly } — doctor.html y familia.html usan readOnly:true.
function renderEventualMedicationsListHTML(list, opts) {
  if (!list || !list.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no se ha registrado ningún medicamento eventual.</div>`;
  }
  return list.map(e => eventualMedicationEntryHTML_(e, opts)).join("");
}
// ---- Bitácora de medicamentos (v30.13) ----
// Resumen por día: tomas programadas (tomadas/no marcadas) + medicamentos
// eventuales de ese mismo día. Ver listMedicationLog en db-postgres.js.
function medicationLogDayHTML_(day) {
  const scheduledHTML = (day.scheduled || []).map(s => `
    <div class="medlog-item ${s.taken ? "is-taken" : "is-missed"}">
      <span class="medlog-time">${escapeHtml_(s.dose_time)}</span>
      <span class="medlog-name">💊 ${escapeHtml_(s.medication_name)}${s.dose_text ? " — " + escapeHtml_(s.dose_text) : ""}</span>
      <span class="medlog-status">${s.taken ? "✅ Tomada" : "— No marcada"}</span>
    </div>`).join("");
  const eventualHTML = (day.eventual || []).map(e => `
    <div class="medlog-item medlog-item-eventual">
      <span class="medlog-time">${e.hora ? escapeHtml_(e.hora) : "—"}</span>
      <span class="medlog-name">🩹 ${escapeHtml_(e.nombre)}${e.dosis ? " — " + escapeHtml_(e.dosis) : ""}</span>
      ${e.notas ? `<span class="medlog-notes">${escapeHtml_(e.notas)}</span>` : ""}
    </div>`).join("");
  return `
    <div class="medlog-day">
      <div class="medlog-day-date">${fmtDate(day.fecha)}</div>
      ${scheduledHTML}${eventualHTML}
    </div>`;
}
function renderMedicationLogHTML(log) {
  if (!log || !log.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no hay nada que mostrar en la bitácora.</div>`;
  }
  return log.map(medicationLogDayHTML_).join("");
}
// Panel de "tomas de hoy" (solo vista de paciente): una casilla por cada
// hora programada de cada medicamento activo, para marcarla como tomada.
function medicationDoseTodayHTML_(doses) {
  if (!doses || !doses.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">No hay medicamentos programados por ahora.</div>`;
  }
  const sorted = doses.slice().sort((a, b) => a.dose_time.localeCompare(b.dose_time));
  return sorted.map(d => `
    <label class="med-dose-today-row ${d.taken ? "is-taken" : ""}" data-medication-id="${d.medication_id}" data-dose-time="${d.dose_time}">
      <input type="checkbox" class="med-dose-checkbox" data-medication-id="${d.medication_id}" data-dose-time="${d.dose_time}" ${d.taken ? "checked" : ""}>
      <span class="med-dose-time">${d.dose_date ? `<span class="med-dose-date">${fmtDate(d.dose_date)}</span> ` : ""}${escapeHtml_(d.dose_time)}</span>
      <span class="med-dose-name">${escapeHtml_(d.medication_name)}${d.dose_text ? " — " + escapeHtml_(d.dose_text) : ""}</span>
    </label>`).join("");
}

// ---- Ejercicio (v30.10; hora de fin + métricas especializadas en v31) ----
// Captura manual (tipo, duración, fecha); las calorías ya vienen calculadas
// desde el servidor (ver calcExerciseCalories_ en db-postgres.js, usa MET del
// tipo de ejercicio junto con peso, estatura, edad y género del paciente).
// v31: qué métricas especializadas mostrar/capturar por tipo de ejercicio
// (misma lista que EXERCISE_METRIC_FIELDS en db-postgres.js). Carrera,
// caminata, hiking, ciclismo, natación y elíptica llevan distancia + FC
// promedio; pesas lleva series/repeticiones/peso levantado; escaleras lleva
// escalones + FC promedio; el resto (yoga, baile, fútbol, básquetbol) solo
// FC promedio; "otro" no tiene ninguna métrica especializada.
const EXERCISE_METRIC_FIELDS_ = {
  caminata_ligera: ["distancia_km", "fc_promedio"],
  caminata_rapida: ["distancia_km", "fc_promedio"],
  trote: ["distancia_km", "fc_promedio"],
  correr_rapido: ["distancia_km", "fc_promedio"],
  hiking: ["distancia_km", "fc_promedio"],
  ciclismo: ["distancia_km", "fc_promedio"],
  natacion: ["distancia_km", "fc_promedio"],
  yoga: ["fc_promedio"],
  pesas: ["series", "repeticiones", "peso_levantado_kg"],
  baile: ["fc_promedio"],
  futbol: ["fc_promedio"],
  basquetbol: ["fc_promedio"],
  eliptica: ["distancia_km", "fc_promedio"],
  escaleras: ["escalones", "fc_promedio"],
  otro: [],
};
const EXERCISE_METRIC_META_ = {
  distancia_km: { label: "Distancia (km)", type: "number", step: "0.01", min: "0", max: "500" },
  fc_promedio: { label: "FC promedio (lpm)", type: "number", step: "1", min: "30", max: "220" },
  series: { label: "Series", type: "number", step: "1", min: "1", max: "50" },
  repeticiones: { label: "Repeticiones", type: "number", step: "1", min: "1", max: "999" },
  peso_levantado_kg: { label: "Peso levantado (kg)", type: "number", step: "0.5", min: "0", max: "500" },
  escalones: { label: "Escalones / pisos", type: "number", step: "1", min: "1", max: "9999" },
};
function exerciseMetricFieldsFor_(tipo) { return EXERCISE_METRIC_FIELDS_[tipo] || []; }
function exerciseEntryHTML_(ex, opts) {
  opts = opts || {};
  const dateLabel = ex.fecha ? ex.fecha.split("-").reverse().join("/") : "";
  const actions = opts.readOnly ? "" : `
    <div class="ex-entry-actions">
      <button type="button" class="btn-mini exercise-edit-btn" data-exercise-id="${ex.id}">Editar</button>
      <button type="button" class="btn-mini danger exercise-delete-btn" data-exercise-id="${ex.id}">Eliminar</button>
    </div>`;
  const detailParts = [dateLabel];
  // v31: si hay hora de inicio Y de fin, se muestran ambas (ej. "07:00–07:45");
  // si solo hay una (registros viejos, antes de v31, o capturada a mano sin
  // hora de fin), se muestra igual que antes.
  if (ex.hora && ex.hora_fin) detailParts.push(`${escapeHtml_(ex.hora)}–${escapeHtml_(ex.hora_fin)}`);
  else if (ex.hora) detailParts.push(escapeHtml_(ex.hora));
  detailParts.push(`${ex.duracion_min} min`);
  if (ex.calorias != null) detailParts.push(`🔥 ${ex.calorias} kcal`);
  // v31: métricas especializadas guardadas (se muestran las que tengan
  // valor, sin depender de si el tipo actual las lista — así un registro
  // viejo o de un tipo distinto no pierde su dato si lo tiene).
  const metricParts = [];
  if (ex.distancia_km != null) metricParts.push(`📏 ${ex.distancia_km} km`);
  if (ex.fc_promedio != null) metricParts.push(`❤️ FC prom. ${ex.fc_promedio}`);
  if (ex.series != null) metricParts.push(`${ex.series} series`);
  if (ex.repeticiones != null) metricParts.push(`${ex.repeticiones} reps`);
  if (ex.peso_levantado_kg != null) metricParts.push(`🏋️ ${ex.peso_levantado_kg} kg`);
  if (ex.escalones != null) metricParts.push(`🪜 ${ex.escalones} escalones`);
  return `
    <div class="ex-entry" data-exercise-id="${ex.id}">
      <div class="ex-entry-header">
        <div class="ex-entry-title">🏃 ${escapeHtml_(ex.tipo_label)}</div>
        ${actions}
      </div>
      <div class="ex-entry-detail">${detailParts.join(" · ")}</div>
      ${metricParts.length ? `<div class="ex-entry-metrics">${metricParts.join(" · ")}</div>` : ""}
      ${ex.notas ? `<div class="ex-entry-notes">${escapeHtml_(ex.notas)}</div>` : ""}
    </div>`;
}
// opts: { readOnly } — doctor.html y familia.html usan readOnly:true.
function renderExercisesListHTML(exercises, opts) {
  if (!exercises || !exercises.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no se ha registrado ningún ejercicio.</div>`;
  }
  return exercises.map(ex => exerciseEntryHTML_(ex, opts)).join("");
}
function exerciseTotalsHTML_(exercises) {
  if (!exercises || !exercises.length) return "";
  const totalMin = exercises.reduce((a, e) => a + (Number(e.duracion_min) || 0), 0);
  const totalCal = exercises.reduce((a, e) => a + (e.calorias != null ? Number(e.calorias) : 0), 0);
  return `<div class="ex-totals">${exercises.length} registro${exercises.length === 1 ? "" : "s"} · ${totalMin} min en total${totalCal ? ` · 🔥 ${totalCal} kcal en total` : ""}</div>`;
}
function ensureExerciseStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-exercise-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-exercise-styles";
  style.textContent = `
    .ex-entry { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .ex-entry:last-child { border-bottom: none; }
    .ex-entry-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .ex-entry-title { font-weight: 650; font-size: 14px; }
    .ex-entry-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .ex-entry-detail { font-size: 13px; color: var(--text); margin-top: 3px; }
    .ex-entry-metrics { font-size: 12px; color: var(--accent); font-weight: 600; margin-top: 2px; }
    .ex-entry-notes { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .ex-totals { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
  `;
  document.head.appendChild(style);
}

// ---- v31: lecturas de presión durante actividad física (sección Ejercicio)
// ----
// Panel de captura idéntico en espíritu a "Agregar lectura" (Presión
// Arterial), pero guardado en su propia tabla/gráfica: son mediciones en
// actividad física, no en reposo, y el usuario pidió explícitamente no
// mezclarlas con la gráfica/tabla principal.
function exerciseReadingEntryHTML_(r, opts) {
  opts = opts || {};
  const dateLabel = r.date ? r.date.split("-").reverse().join("/") : "";
  const actions = opts.readOnly ? "" : `
    <div class="ex-entry-actions">
      <button type="button" class="btn-mini exercise-reading-edit-btn" data-exercise-reading-id="${r.id}">Editar</button>
      <button type="button" class="btn-mini danger exercise-reading-delete-btn" data-exercise-reading-id="${r.id}">Eliminar</button>
    </div>`;
  const parts = [dateLabel, r.time].filter(Boolean);
  parts.push(`${r.sys ?? "–"}/${r.dia ?? "–"} mmHg`);
  if (r.hr != null) parts.push(`FC ${r.hr}`);
  return `
    <div class="ex-entry" data-exercise-reading-id="${r.id}">
      <div class="ex-entry-header">
        <div class="ex-entry-title">💓 ${escapeHtml_(parts.join(" · "))}</div>
        ${actions}
      </div>
      ${r.obs ? `<div class="ex-entry-notes">${escapeHtml_(r.obs)}</div>` : ""}
    </div>`;
}
function renderExerciseReadingsListHTML(readings, opts) {
  if (!readings || !readings.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no hay lecturas de presión capturadas durante actividad física.</div>`;
  }
  return [...readings].sort((a, b) => (b.date + "T" + b.time).localeCompare(a.date + "T" + a.time))
    .map(r => exerciseReadingEntryHTML_(r, opts)).join("");
}

// ---- v31: sección Wellness ----
// Actividades de relajación/ocio en reposo — no llevan calorías (no son
// actividad física), solo tipo, duración y notas. "otro" al final por si el
// paciente hace algo que no está en la lista.
const WELLNESS_CATALOG = [
  { value: "meditacion", label: "Meditación" },
  { value: "respiracion", label: "Ejercicios de respiración" },
  { value: "vapor", label: "Vapor" },
  { value: "sauna", label: "Sauna" },
  { value: "lectura_reposo", label: "Lectura en reposo" },
  { value: "audiolibro_reposo", label: "Audiolibro en reposo" },
  { value: "musica_relajante", label: "Música relajante" },
  { value: "pintura", label: "Pintura" },
  { value: "dibujo", label: "Dibujo" },
  { value: "escritura", label: "Escritura" },
  { value: "otro", label: "Otro" },
];
function wellnessCatalogEntry_(value) {
  return WELLNESS_CATALOG.find(w => w.value === value) || null;
}
function wellnessEntryHTML_(w, opts) {
  opts = opts || {};
  const dateLabel = w.fecha ? w.fecha.split("-").reverse().join("/") : "";
  const label = (wellnessCatalogEntry_(w.tipo) || {}).label || w.tipo;
  const actions = opts.readOnly ? "" : `
    <div class="ex-entry-actions">
      <button type="button" class="btn-mini wellness-edit-btn" data-wellness-id="${w.id}">Editar</button>
      <button type="button" class="btn-mini danger wellness-delete-btn" data-wellness-id="${w.id}">Eliminar</button>
    </div>`;
  const detailParts = [dateLabel];
  if (w.hora) detailParts.push(escapeHtml_(w.hora));
  if (w.duracion_min != null) detailParts.push(`${w.duracion_min} min`);
  return `
    <div class="ex-entry" data-wellness-id="${w.id}">
      <div class="ex-entry-header">
        <div class="ex-entry-title">🧘 ${escapeHtml_(label)}</div>
        ${actions}
      </div>
      <div class="ex-entry-detail">${detailParts.join(" · ")}</div>
      ${w.notas ? `<div class="ex-entry-notes">${escapeHtml_(w.notas)}</div>` : ""}
    </div>`;
}
function renderWellnessListHTML(entries, opts) {
  if (!entries || !entries.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no se ha registrado ninguna actividad de wellness.</div>`;
  }
  return entries.map(w => wellnessEntryHTML_(w, opts)).join("");
}
function wellnessTotalsHTML_(entries) {
  if (!entries || !entries.length) return "";
  const totalMin = entries.reduce((a, e) => a + (Number(e.duracion_min) || 0), 0);
  return `<div class="ex-totals">${entries.length} registro${entries.length === 1 ? "" : "s"}${totalMin ? ` · ${totalMin} min en total` : ""}</div>`;
}

// ---- v32: sección Sueño — hora de inicio/fin (casi siempre cruza la
// medianoche), duración calculada sola pero editable a mano (mismo patrón
// que Ejercicio), y calidad de sueño opcional en escala 1-10 (misma idea que
// la intensidad de Síntomas, pero para qué tan bien durmió esa noche). ----
const SLEEP_QUALITY_LABELS_ = {
  1: "Muy mala", 2: "Mala", 3: "Mala-regular", 4: "Regular", 5: "Regular-buena",
  6: "Buena", 7: "Buena-muy buena", 8: "Muy buena", 9: "Excelente", 10: "Óptima",
};
function sleepDurationLabel_(min) {
  if (min == null) return "";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}
function sleepEntryHTML_(s, opts) {
  opts = opts || {};
  const dateLabel = s.fecha ? s.fecha.split("-").reverse().join("/") : "";
  const actions = opts.readOnly ? "" : `
    <div class="ex-entry-actions">
      <button type="button" class="btn-mini sleep-edit-btn" data-sleep-id="${s.id}">Editar</button>
      <button type="button" class="btn-mini danger sleep-delete-btn" data-sleep-id="${s.id}">Eliminar</button>
    </div>`;
  const detailParts = [dateLabel];
  if (s.hora_inicio && s.hora_fin) detailParts.push(`${escapeHtml_(s.hora_inicio)}–${escapeHtml_(s.hora_fin)}`);
  else if (s.hora_inicio) detailParts.push(escapeHtml_(s.hora_inicio));
  if (s.duracion_min != null) detailParts.push(sleepDurationLabel_(s.duracion_min));
  const qualityChip = s.calidad != null
    ? `<span class="symptom-scale-chip">Calidad ${s.calidad}/10 – ${escapeHtml_(SLEEP_QUALITY_LABELS_[s.calidad] || "")}</span>`
    : "";
  return `
    <div class="ex-entry" data-sleep-id="${s.id}">
      <div class="ex-entry-header">
        <div class="ex-entry-title">🌙 Sueño</div>
        ${actions}
      </div>
      <div class="ex-entry-detail">${detailParts.join(" · ")}</div>
      ${qualityChip ? `<div style="margin-top:3px;">${qualityChip}</div>` : ""}
      ${s.notas ? `<div class="ex-entry-notes">${escapeHtml_(s.notas)}</div>` : ""}
    </div>`;
}
function renderSleepListHTML(entries, opts) {
  if (!entries || !entries.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no se ha registrado ningún sueño.</div>`;
  }
  return entries.map(s => sleepEntryHTML_(s, opts)).join("");
}
function sleepTotalsHTML_(entries) {
  if (!entries || !entries.length) return "";
  const withDuration = entries.filter(e => e.duracion_min != null);
  const withQuality = entries.filter(e => e.calidad != null);
  const parts = [`${entries.length} registro${entries.length === 1 ? "" : "s"}`];
  if (withDuration.length) {
    const avgMin = withDuration.reduce((a, e) => a + Number(e.duracion_min), 0) / withDuration.length;
    parts.push(`promedio ${sleepDurationLabel_(avgMin)}`);
  }
  if (withQuality.length) {
    const avgQ = withQuality.reduce((a, e) => a + Number(e.calidad), 0) / withQuality.length;
    parts.push(`calidad promedio ${Math.round(avgQ * 10) / 10}/10`);
  }
  return `<div class="ex-totals">${parts.join(" · ")}</div>`;
}
// Serie para la gráfica de Estadísticas: duración en HORAS (más legible que
// minutos en el eje de una gráfica), reutilizando el mismo formato
// {labels, values, obs} que ya entiende renderMetricTrendChart.
function sleepDurationSeriesForChart_(entries) {
  const filtered = (entries || []).filter(e => e.duracion_min != null);
  return {
    labels: filtered.map(e => fmtDate(e.fecha)),
    values: filtered.map(e => Math.round((Number(e.duracion_min) / 60) * 100) / 100),
    obs: filtered.map(e => e.notas || ""),
  };
}
function sleepQualitySeriesForChart_(entries) {
  const filtered = (entries || []).filter(e => e.calidad != null);
  return {
    labels: filtered.map(e => fmtDate(e.fecha)),
    values: filtered.map(e => Number(e.calidad)),
    obs: filtered.map(e => e.notas || ""),
  };
}

// ---- v31.1: localización gráfica del dolor de cabeza ----
// Solo aplica al síntoma "dolor_cabeza". Deliberadamente son solo imágenes de
// ubicación (nunca nombres de tipos de dolor de cabeza ni diagnóstico):
// selección múltiple sobre las 14 ilustraciones reales que el usuario dejó
// en Images/Head (servidas como /shared/head-pain/HeadN.png), reemplazando
// el dibujo SVG hecho a mano de la v31.0 original — el usuario reportó que
// esas zonas dibujadas no servían para identificar bien la localización.
// Las etiquetas son deliberadamente neutras ("Zona N"), no descriptivas ni
// diagnósticas: la imagen es la que comunica la ubicación, el texto es solo
// para accesibilidad (alt/aria).
const HEAD_PAIN_LOCATIONS = Array.from({ length: 14 }, (_, i) => {
  const n = i + 1;
  return { value: `head${n}`, label: `Zona ${n}`, img: `/shared/head-pain/Head${n}.png` };
});
function headPainLocationLabel_(value) {
  const entry = HEAD_PAIN_LOCATIONS.find(h => h.value === value);
  return entry ? entry.label : value;
}
function headPainLocationImg_(value) {
  const entry = HEAD_PAIN_LOCATIONS.find(h => h.value === value);
  return entry ? entry.img : "";
}
// Panel interactivo (paciente): cuadrícula con las 14 imágenes; tocar una
// imagen la selecciona/deselecciona (selección múltiple). selected: array de
// values ya elegidos.
function headPainPickerHTML_(selected) {
  selected = selected || [];
  const isSel = v => selected.includes(v);
  const cards = HEAD_PAIN_LOCATIONS.map(h => `
    <button type="button" class="head-pain-card${isSel(h.value) ? " selected" : ""}" data-head-pain-value="${h.value}" aria-pressed="${isSel(h.value)}" aria-label="${escapeHtml_(h.label)}">
      <img src="${h.img}" alt="${escapeHtml_(h.label)}" loading="lazy">
      <span class="head-pain-card-check">✓</span>
    </button>`).join("");
  return `
    <div class="head-pain-picker">
      <div class="head-pain-grid">${cards}</div>
      <div class="head-pain-hint">Toca una o varias imágenes que se parezcan a dónde sientes el dolor (puedes elegir más de una). Solo indica la ubicación — no es un diagnóstico.</div>
    </div>`;
}
// Vista de solo lectura (miniaturas, sin interacción) para mostrar dentro
// del historial de síntomas (paciente y doctor.html).
function headPainLocationsSummaryHTML_(locations) {
  if (!locations || !locations.length) return "";
  const thumbs = locations.map(v => `<img class="head-pain-thumb-static" src="${headPainLocationImg_(v)}" alt="${escapeHtml_(headPainLocationLabel_(v))}" title="${escapeHtml_(headPainLocationLabel_(v))}">`).join("");
  return `<div class="head-pain-summary">📍 ${thumbs}</div>`;
}
function ensureHeadPainStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-head-pain-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-head-pain-styles";
  style.textContent = `
    .head-pain-picker { margin-top: 6px; }
    .head-pain-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; }
    .head-pain-card { position: relative; border: 2px solid var(--border); background: var(--card-bg, #fff); border-radius: 10px; padding: 3px; cursor: pointer; line-height: 0; transition: border-color 0.15s, box-shadow 0.15s; }
    .head-pain-card img { width: 100%; height: auto; border-radius: 7px; display: block; }
    .head-pain-card:hover { border-color: rgba(139, 92, 246, 0.5); }
    .head-pain-card.selected { border-color: #6D28D9; box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.35); }
    .head-pain-card-check { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 50%; background: #6D28D9; color: #fff; font-size: 11px; line-height: 18px; text-align: center; display: none; }
    .head-pain-card.selected .head-pain-card-check { display: block; }
    .head-pain-thumb-static { width: 34px; height: auto; border-radius: 6px; border: 1px solid rgba(139, 92, 246, 0.4); margin: 2px 4px 2px 0; vertical-align: middle; }
    .head-pain-hint { font-size: 11px; color: var(--text-muted); margin-top: 8px; text-align: center; }
  `;
  document.head.appendChild(style);
}

// ---- Consultas médicas (v30.12) ----
// La foto de la receta se sirve por HTTP directo (no viaja en el JSON de la
// lista), así que hace falta la base de la URL para armarla: el paciente y
// el médico usan /api/consultations/ (con sesión), familia.html usa
// /familia/<token>/consultations/ (sin sesión) — ver opts.photoBaseUrl.
function consultationNextApptLabel_(c) {
  if (!c.next_appointment_date) return { text: "Sin cita programada", isPending: false };
  return { text: `Próxima cita: ${fmtDate(c.next_appointment_date)}`, isPending: true };
}
function consultationEntryHTML_(c, opts) {
  opts = opts || {};
  const actions = opts.readOnly ? "" : `
    <div class="consult-entry-actions">
      <button type="button" class="btn-mini consultation-edit-btn" data-consultation-id="${c.id}">Editar</button>
      <button type="button" class="btn-mini danger consultation-delete-btn" data-consultation-id="${c.id}">Eliminar</button>
    </div>`;
  const nextAppt = consultationNextApptLabel_(c);
  const photoHTML = c.has_receta && opts.photoBaseUrl
    ? `<a href="${opts.photoBaseUrl}${c.id}/photo" target="_blank" rel="noopener" class="consult-receta-link">
         <img src="${opts.photoBaseUrl}${c.id}/photo" alt="Foto de la receta" class="consult-receta-thumb">
       </a>`
    : "";
  return `
    <div class="consult-entry" data-consultation-id="${c.id}">
      <div class="consult-entry-header">
        <div class="consult-entry-title">🩺 ${escapeHtml_(c.doctor_name || "Consulta")}</div>
        ${actions}
      </div>
      <div class="consult-entry-date">${fmtDate(c.fecha)}</div>
      ${c.motivo ? `<div class="consult-entry-detail"><strong>Motivo:</strong> ${escapeHtml_(c.motivo)}</div>` : ""}
      ${c.notas ? `<div class="consult-entry-notes">${escapeHtml_(c.notas)}</div>` : ""}
      <div class="consult-entry-next ${nextAppt.isPending ? "is-pending" : "is-none"}">${nextAppt.isPending ? "📅" : "—"} ${escapeHtml_(nextAppt.text)}</div>
      ${photoHTML}
    </div>`;
}
// opts: { readOnly, photoBaseUrl } — doctor.html y familia.html usan readOnly:true.
function renderConsultationsListHTML(consultations, opts) {
  if (!consultations || !consultations.length) {
    return `<div style="color:var(--text-muted); font-size:13px;">Aún no se ha registrado ninguna consulta.</div>`;
  }
  return consultations.map(c => consultationEntryHTML_(c, opts)).join("");
}
function ensureConsultationStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-consultation-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-consultation-styles";
  style.textContent = `
    .consult-entry { padding: 12px 0; border-bottom: 1px solid var(--border); }
    .consult-entry:last-child { border-bottom: none; }
    .consult-entry-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .consult-entry-title { font-weight: 650; font-size: 14px; }
    .consult-entry-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .consult-entry-date { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .consult-entry-detail { font-size: 13px; color: var(--text); margin-top: 4px; }
    .consult-entry-notes { font-size: 12px; color: var(--text-muted); margin-top: 3px; }
    .consult-entry-next { font-size: 12px; font-weight: 600; margin-top: 6px; }
    .consult-entry-next.is-pending { color: var(--accent); }
    .consult-entry-next.is-none { color: var(--text-muted); font-weight: 500; }
    .consult-receta-thumb { display: block; width: 90px; height: 90px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); margin-top: 8px; }
  `;
  document.head.appendChild(style);
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
// v30.8: los botones de pestañas de sección (.page-tab-btn) tienen su propia
// animación de destello (ver flashTab_ en cada página) — antes también les
// caía el confeti genérico de aquí abajo, encimando ambos efectos y tapando
// el destello por completo. Se excluyen para que la pestaña se vea con una
// sola animación, distinta a la de los demás botones.
// v30.9: el botón "Agregar" de una lectura nueva (data-heartbeat-btn) tiene su
// propia animación de 3 latidos de corazón (ver fireHeartbeats más abajo) en
// vez del confeti genérico, para diferenciarlo como un evento de salud.
function wireConfettiOnAllButtons_() {
  if (typeof document === "undefined" || document.body.dataset.confettiWired) return;
  document.body.dataset.confettiWired = "1";
  document.addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    if (btn.classList.contains("page-tab-btn") || btn.hasAttribute("data-page-tab")) return;
    if (btn.hasAttribute("data-heartbeat-btn")) return;
    fireConfetti(btn, 22);
  });
}
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", wireConfettiOnAllButtons_);
}

// v30.9: animación de "3 latidos de corazón en rojo" para el botón Agregar
// de una lectura nueva — un corazón aparece sobre el botón y pulsa 3 veces
// (como un latido) antes de desvanecerse, en vez del confeti genérico.
function ensureHeartbeatStyles_() {
  if (typeof document === "undefined" || document.getElementById("bp-heartbeat-styles")) return;
  const style = document.createElement("style");
  style.id = "bp-heartbeat-styles";
  style.textContent = `
  .bp-heartbeat-fx {
    position: fixed;
    z-index: 9999;
    pointer-events: none;
    font-size: 32px;
    line-height: 1;
    color: #e0304a;
    filter: drop-shadow(0 2px 4px rgba(224,48,74,.45));
    animation: bp-heartbeat-beat 1.05s ease-in-out 3;
    will-change: transform, opacity;
  }
  @keyframes bp-heartbeat-beat {
    0%   { transform: translate(-50%, -60%) scale(1); opacity: .95; }
    14%  { transform: translate(-50%, -60%) scale(1.4); opacity: 1; }
    28%  { transform: translate(-50%, -60%) scale(1); opacity: .95; }
    42%  { transform: translate(-50%, -60%) scale(1.22); opacity: 1; }
    56%  { transform: translate(-50%, -60%) scale(1); opacity: .95; }
    92%  { transform: translate(-50%, -60%) scale(1); opacity: .95; }
    100% { transform: translate(-50%, -60%) scale(1); opacity: 0; }
  }`;
  document.head.appendChild(style);
}
function fireHeartbeats(originEl) {
  try {
    if (typeof document === "undefined") return;
    ensureHeartbeatStyles_();
    const rect = originEl && originEl.getBoundingClientRect ? originEl.getBoundingClientRect() : null;
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top : window.innerHeight * 0.2;
    const heart = document.createElement("div");
    heart.className = "bp-heartbeat-fx";
    heart.textContent = "❤️";
    heart.setAttribute("aria-hidden", "true");
    heart.style.left = x + "px";
    heart.style.top = y + "px";
    document.body.appendChild(heart);
    setTimeout(() => heart.remove(), 3300);
  } catch (err) { /* silencioso: la animación es un extra */ }
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
    // v30.9: en iPhone/iPad, Safari SOLO expone la API de Push cuando la app
    // ya se agregó a la pantalla de inicio y se abre desde ahí (modo
    // standalone) — desde el navegador normal, "Notification"/"PushManager"
    // ni siquiera existen, así que antes esto cae siempre en el mensaje
    // genérico "no disponible" sin decir por qué ni cómo arreglarlo. Se
    // detecta ese caso específico para dar instrucciones accionables en vez
    // de dejar al usuario sin saber qué hacer.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.navigator.standalone === true
      || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    console.warn("[push] API no disponible en este navegador:", {
      serviceWorker: "serviceWorker" in navigator,
      PushManager: "PushManager" in window,
      Notification: "Notification" in window,
      isIOS, isStandalone,
    });
    reportStatus(isIOS && !isStandalone ? "ios_needs_install" : "unsupported");
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
