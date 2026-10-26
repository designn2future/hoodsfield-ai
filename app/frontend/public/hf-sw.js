// Tiny service worker: lets Android Chrome show the Assistant's notifications and opens the app when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const run = e.notification.data && e.notification.data.run;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { await c.focus(); c.postMessage({ type: 'hf-open-assistant', run }); return; }
    await self.clients.openWindow('/#assistant');
  })());
});
