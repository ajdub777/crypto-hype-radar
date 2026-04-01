self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'Crypto Hype Radar', body: 'New signal detected!' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      vibrate: [200, 100, 200],
      data: { url: 'https://cryptohyperadar.com' },
      actions: [{ action: 'view', title: 'View Signal' }]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('https://cryptohyperadar.com'));
});
