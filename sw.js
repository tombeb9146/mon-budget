/*
 * Service worker : garde une copie des fichiers de l'application sur le téléphone
 * pour qu'elle fonctionne sans connexion.
 * À chaque nouvelle version de l'application, augmenter le numéro de VERSION.
 */
const VERSION = 'budget-v14';
const FILES = [
  './',
  'index.html',
  'style.css',
  'store.js',
  'xlsx.js',
  'app.js',
  'export.js',
  'backup.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  // cache: 'reload' : on met de côté les fichiers tout juste téléchargés, jamais une ancienne copie
  event.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Réseau d'abord (pour recevoir les mises à jour), copie locale si hors connexion.
// cache: 'no-cache' oblige à revérifier chaque fichier auprès du site : sans cela, le navigateur
// réutiliserait sa propre copie jusqu'à 10 minutes et une mise à jour pourrait tarder.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    fetch(event.request.url, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
