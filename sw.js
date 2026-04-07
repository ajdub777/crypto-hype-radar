// Crypto Hype Radar — Service Worker
// Handles: install/activate lifecycle, push events, and notification clicks.
// Notifications are fired via reg.showNotification() from the page, not a push server.

const CACHE_VERSION = 'chr-v2';

self.addEventListener('install', event => {
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Take control of all clients right away
  event.waitUntil(clients.claim());
});

// Web Push handler — fires if/when a real push server sends a push message
self.addEventListener('push', event => {
  const data = event.data
    ? event.data.json()
    : { title: 'Crypto Hype Radar', body: 'New signal detected!' };

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      vibrate: [200, 100, 200],
      tag: data.tag || 'chr-signal',
      renotify: true,
      data: { url: data.url || 'https://cryptohyperadar.com' },
      actions: [{ action: 'view', title: 'View Signal' }]
    })
  );
});

// Notification click handler — opens or focuses the site
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://cryptohyperadar.com';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If a tab is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes('cryptohyperadar.com') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// Message handler — allows the page to send arbitrary commands to the SW
self.addEventListener('message', event => {
  if (!event.data) return;

  // The page can request an immediate notification via postMessage
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, coinId } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [200, 100, 200],
        tag: 'signal-' + (coinId || 'unknown'),
        renotify: true,
        data: { url: 'https://cryptohyperadar.com' },
        actions: [{ action: 'view', title: 'View Signal' }]
      })
    );
  }

  // The page can ask the SW to skip waiting and activate immediately
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
