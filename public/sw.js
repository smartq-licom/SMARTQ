/*
 * SmartQ service worker. It shows phone notifications: the ticket page's own
 * ("5 people ahead", "You are next"; Android Chrome only shows them through a
 * service worker) and Web Push notices sent by the server (data/push.js), which
 * arrive even when the page is closed. It does not cache or intercept anything.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// A notice from the server: called, leave now, may not be served today...
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'SmartQ', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'SmartQ', {
    body: d.body || '',
    icon: '/img/lcc-seal.jpg',
    badge: '/img/lcc-seal.jpg',
    tag: d.tag || 'smartq',
    renotify: true,
    vibrate: [200, 100, 200, 100, 200],
    data: { url: d.url || '/queue' },
  }));
});

// Tapping the notification brings the student back to their ticket.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/queue';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.includes(url) && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  }));
});
