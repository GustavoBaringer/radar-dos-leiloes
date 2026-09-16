/* Service worker do push. Precisa estar na raiz para controlar o site inteiro. */
self.addEventListener('push', (evento) => {
  let d = {};
  try {
    d = evento.data ? evento.data.json() : {};
  } catch {
    d = { title: 'Radar de Leilões', body: evento.data ? evento.data.text() : '' };
  }
  evento.waitUntil(
    self.registration.showNotification(d.title || 'Radar de Leilões', {
      body: d.body || '',
      tag: d.tag,
      data: { url: d.url || '/' },
      badge: '/nopic.svg',
      icon: '/nopic.svg',
    }),
  );
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const alvo = evento.notification.data?.url || '/';
  // Reaproveita uma aba já aberta em vez de abrir outra a cada clique.
  evento.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((abas) => {
      for (const aba of abas) if ('focus' in aba) return aba.focus();
      return clients.openWindow(alvo);
    }),
  );
});
