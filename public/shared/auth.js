// v29: icono de ojo para mostrar/ocultar contraseña, en todas las pantallas
// de acceso (login, signup, invitación de médico, restablecer contraseña).
// Envuelve cada <input type="password"> en un contenedor relativo y le pone
// un botoncito de ojo encima, sin tocar el HTML de cada página una por una.
function wirePasswordToggle(input) {
  if (!input || input.dataset.pwWired) return;
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
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('input[type="password"]').forEach(wirePasswordToggle);
});
