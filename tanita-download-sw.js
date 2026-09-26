const PDF_CACHE = 'tanita-pdf-download-v1';
const DOWNLOAD_PATH = new URL('./tanita-download/', self.registration.scope).pathname;

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(DOWNLOAD_PATH)) return;

  event.respondWith((async () => {
    const cachedUrl = url.origin + url.pathname;
    const cache = await caches.open(PDF_CACHE);
    const saved = await cache.match(cachedUrl);
    if (!saved) return new Response('This PDF is no longer available. Return to the scanner and retry.', { status: 410 });

    const requestedName = url.searchParams.get('filename') || 'TANITA.pdf';
    const filename = requestedName.replace(/[^\w .-]/g, '_').replace(/^\.+/, '_');
    const blob = await saved.blob();
    return new Response(blob, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(requestedName)}`,
        'Content-Length': String(blob.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  })());
});
