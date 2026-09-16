// NightLine service worker (v9): push notifications that don't get lost across lots of rooms.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// Ask an open app window which chat it's showing (answers null if none / hidden).
function askWhichRoom(client) {
  return new Promise(resolve => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 400);
    ch.port1.onmessage = e => { clearTimeout(timer); resolve(e.data?.room ?? null); };
    try { client.postMessage({ type: "which-room" }, [ch.port2]); } catch (e) { clearTimeout(timer); resolve(null); }
  });
}

async function updateBadge() {
  try {
    const all = await self.registration.getNotifications();
    const total = all.reduce((n, x) => n + (x.data?.count || 1), 0);
    if (total > 0) await self.navigator.setAppBadge?.(total); else await self.navigator.clearAppBadge?.();
  } catch (e) {}
}

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    const room = data.room || "";
    const tag = "room-" + room;

    // Only stay quiet if someone is literally looking at THIS chat right now.
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = wins.filter(w => w.visibilityState === "visible");
    const rooms = await Promise.all(visible.map(askWhichRoom));
    if (room && rooms.includes(room)) return;

    // Stack messages from the same chat into one notification with a running count.
    const existing = await self.registration.getNotifications({ tag });
    const prev = existing[0];
    const count = (prev?.data?.count || 0) + 1;
    const lines = [...(prev?.data?.lines || []), data.body || "New message"].slice(-4);
    const mention = !!data.mention || !!prev?.data?.mention;
    const title = count > 1
      ? `${mention ? "📣 " : ""}${count} new messages · ${data.roomLabel || data.title || "NightLine"}`
      : (data.title || "NightLine");
    const body = count > 1 ? lines.join("\n") : (data.body || "New message");

    await self.registration.showNotification(title, {
      body,
      icon: data.icon || "icon-192.png",
      badge: "icon-192.png",
      tag,
      renotify: true,                              // buzz again for each new message
      requireInteraction: !!data.mention,          // mentions stay on screen until dismissed (where supported)
      timestamp: Date.now(),
      data: { room, count, lines, mention }
    });
    await updateBadge();
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const room = event.notification.data?.room || "";
  event.waitUntil((async () => {
    await updateBadge();
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { await w.focus(); w.postMessage({ room }); return; }
    await self.clients.openWindow("./" + (room ? "?room=" + encodeURIComponent(room) : ""));
  })());
});

self.addEventListener("notificationclose", event => { event.waitUntil(updateBadge()); });
