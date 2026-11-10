// spec-web service worker: shows the system card for a Web Push and opens the right tab on click.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let m = {}
  try { m = event.data ? event.data.json() : {} } catch { m = { title: 'Spec-web', body: event.data ? event.data.text() : '' } }
  event.waitUntil((async () => {
    // A visible, focused page already shows its own toast; a second system card would only duplicate it.
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (pages.some((c) => c.visibilityState === 'visible' && c.focused)) return
    await self.registration.showNotification(m.title || 'Spec-web', {
      body: m.body || '', tag: m.tag || m.title, icon: '/favicon.png', renotify: true, data: { tab: m.tab || '', domain: m.domain || '' },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { tab, domain } = event.notification.data || {}
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const page = pages[0]
    if (page) { await page.focus(); page.postMessage({ type: 'pw-open-tab', tab, domain }); return }
    await self.clients.openWindow('/?pwtab=' + encodeURIComponent(tab || '') + (domain ? '&pwdomain=' + domain : ''))
  })())
})
