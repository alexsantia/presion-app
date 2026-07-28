# Notas para trabajar en este repo

## Siempre subir la versión al tocar los archivos públicos

Cada vez que se edite cualquiera de `public/index.html`, `public/doctor.html`
o `public/familia.html` (o `public/shared/common.js`, que los tres cargan),
hay que subir el número de versión en los tres archivos HTML antes de darlos
por terminados, aunque el cambio sea "menor":

- El querystring de cache-busting: `<script src="/shared/common.js?v=X.Y">`
- El pie de página: `Reigning Blood Pressure App · creado por Alex Santiago · vX.Y`

Esto ya se le olvidó una vez (se hicieron cambios grandes de v30 sin subir el
número, y el usuario los reportó como "no veo los cambios"), y una segunda
vez (una ronda de correcciones v30.1 — menú hamburguesa y orden de "Racha" —
se copió al repo real sin subir la versión). Revisar esto es parte de cerrar
cualquier tarea que toque estos archivos, no un paso opcional al final.
