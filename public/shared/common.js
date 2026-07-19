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

function fmtDate(d) {
  const [y, m, day] = d.split("-");
  return `${day}/${m}`;
}

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

  const todayStr = new Date().toISOString().slice(0, 10);
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
