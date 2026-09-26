// NightLane service worker (v15): push notifications + fast repeat loads.
const CACHE="nightlane-v15";
// Outside files the app needs to start: the server library (a fixed version, so it never changes) and the fonts.
const LIB="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.min.js";
const OUTSIDE=u=>u.hostname==="cdn.jsdelivr.net"||u.hostname==="fonts.googleapis.com"||u.hostname==="fonts.gstatic.com";
const STATIC=["icon-192.png","icon-512.png","apple-touch-icon.png","favicon.ico","manifest.json","badge-96.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(async c => { await c.addAll(STATIC).catch(()=>{}); try { const lr = await fetch(LIB, { mode: "cors" }); if (lr.ok) await c.put(LIB, lr); } catch (e) {} try { const r = await fetch("./", { cache: "no-store" }); if (r.ok) await c.put("shell", r); } catch (e) {} }).then(()=>self.skipWaiting())); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// ---- private chat photos / videos / voice ----
// Those files only open for people in the chat. When the app asks for one, attach the viewer's login
// (sent here by the app) so the server can check. If anything's off, fall back to the plain request and
// the app retries with a short-lived private link.
let AUTH = null;
self.addEventListener("message", e => {
  if (e.data && e.data.type === "nl-unread") { e.waitUntil(unreadStore(e.data.n).then(() => setBadge(e.data.n))); return; }
  if (e.data && e.data.type === "nl-auth") {
    AUTH = e.data.auth || null;
    caches.open(CACHE).then(c => AUTH ? c.put("__nl_auth", new Response(JSON.stringify(AUTH))) : c.delete("__nl_auth"));
  }
});
async function getAuth() {
  if (AUTH) return AUTH;
  const r = await caches.match("__nl_auth"); if (r) { try { AUTH = await r.json(); } catch (e) {} }
  return AUTH;
}
const PRIVATE_FILE = /\/storage\/v1\/object\/public\/chat-(images|media)\//;
async function privateFile(req, url) {
  const a = await getAuth();
  if (a && a.token) {
    const h = new Headers({ Authorization: "Bearer " + a.token, apikey: a.key || "" });
    const range = req.headers.get("range"); if (range) h.set("range", range);
    try {
      const r = await fetch(url.href.replace("/object/public/", "/object/authenticated/"), { headers: h, mode: "cors", credentials: "omit" });
      if (r.ok || r.status === 206) return r;
    } catch (e) {}
  }
  return fetch(req);
}

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (PRIVATE_FILE.test(url.pathname)) { e.respondWith(privateFile(req, url)); return; }
  if (url.origin !== location.origin) {
    if (!OUTSIDE(url)) return;
    // library + fonts: use the saved copy (works offline), fetch and save it the first time
    e.respondWith(caches.match(req, { ignoreVary: true }).then(hit => hit || fetch(req).then(r => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })));
    return;
  }
  const isShell = req.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/");
  if (isShell) {
    // network first: always pick up your latest upload; fall back to the cached copy when offline
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("shell", copy)); return r; }).catch(() => caches.match("shell")));
  } else if (STATIC.some(s => url.pathname.endsWith("/" + s))) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })));
  }
});


// Ask an open app window which chat it's showing (answers null if none / hidden).
function askWhichRoom(client) {
  return new Promise(resolve => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 400);
    ch.port1.onmessage = e => { clearTimeout(timer); resolve(e.data?.room ?? null); };
    try { client.postMessage({ type: "which-room" }, [ch.port2]); } catch (e) { clearTimeout(timer); resolve(null); }
  });
}

// App-icon badge (iPhone home-screen app + installed desktop app; Android shows its own dot/count from notifications).
// The app tells us the real unread total whenever it knows it; each new message while it's closed adds 1.
async function unreadStore(n) {
  const c = await caches.open(CACHE);
  if (n === undefined) { const r = await c.match("__nl_unread"); return r ? (+(await r.text()) || 0) : 0; }
  await c.put("__nl_unread", new Response(String(Math.max(0, n|0))));
}
async function setBadge(n) {
  try { if (n > 0) await self.navigator.setAppBadge?.(n); else await self.navigator.clearAppBadge?.(); } catch (e) {}
}
async function updateBadge() {
  try { const n = (await unreadStore()) + 1; await unreadStore(n); await setBadge(n); } catch (e) {}
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
      ? `${mention ? "📣 " : ""}${count} new messages · ${data.roomLabel || data.title || "NightLane"}`
      : (data.title || "NightLane");
    const body = count > 1 ? lines.join("\n") : (data.body || "New message");

    await self.registration.showNotification(title, {
      body,
      icon: data.icon || "icon-192.png",
      badge: "badge-96.png",
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
