// NightLine service worker: shows push notifications and opens the right room when tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.some(w => w.focused && w.visibilityState === "visible")) return; // already looking at the app
    await self.registration.showNotification(data.title || "NightLine", {
      body: data.body || "New message",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: "room-" + (data.room || ""),
      renotify: true,
      data: { room: data.room || "" }
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const room = event.notification.data?.room || "";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { await w.focus(); w.postMessage({ room }); return; }
    await self.clients.openWindow("./" + (room ? "?room=" + encodeURIComponent(room) : ""));
  })());
});
