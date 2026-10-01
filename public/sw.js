/*
 * SmartQ service worker. Its only job is to let the ticket page show phone
 * notifications ("5 people ahead", "You are next"): Android Chrome only shows
 * them through a service worker. It does not cache or intercept anything.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Tapping the notification brings the student back to their ticket.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/student/dashboard';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.includes(url) && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  }));
});
