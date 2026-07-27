// Service worker de Reigning Blood Pressure App (v29).
// Solo existe para dos cosas: (1) recibir notificaciones push del sistema
// aunque la app esté cerrada, y (2) poner el número de notificaciones sin
// leer sobre el ícono cuando está anclada a la pantalla de inicio (iOS
// 16.4+ / Android). No cachea nada ni intercepta peticiones normales — esta
// app siempre necesita datos frescos del servidor, así que no tiene ningún
// sentido convertirla en una app "offline-first".
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// Formato del payload (ver sendPushToRecipient_ en db-postgres.js):
// { title, body, count }. "count" es el total de notificaciones sin leer
// de ese destinatario en ese momento — se usa tal cual para el badge, sin
// necesidad de que el service worker sepa nada más de la app.
self.addEventListener("push", event => {
  let data = { title: "Reigning Blood Pressure App", body: "Tienes una notificación nueva." };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (err) { /* payload no-JSON: se usa el mensaje genérico */ }

  const showNotification = self.registration.showNotification(data.title, {
    body: data.body,
    icon: "/shared/logos/icon-512.png",
    badge: "/shared/logos/icon-512.png",
    tag: "bp-notification",
    renotify: true,
  });

  // setAppBadge desde el service worker: así el número en el ícono se
  // actualiza aunque el usuario nunca haya abierto la app para ver este
  // push en particular (por ejemplo, si lo ignora y le siguen llegando más).
  const badgePromise = ("setAppBadge" in self.registration && typeof data.count === "number")
    ? (data.count > 0 ? self.registration.setAppBadge(data.count) : self.registration.clearAppBadge())
    : Promise.resolve();

  event.waitUntil(Promise.all([showNotification, badgePromise.catch(() => {})]));
});

// Al tocar la notificación del sistema, enfoca una pestaña ya abierta de la
// app si existe, o abre una nueva en la página principal.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
