(() => {
  const storagePrefix = 'sge.ticket-browser.v1.';
  const lifetimeMs = 90 * 24 * 60 * 60 * 1000;
  const browserKeyPattern = /^[0-9a-f]{32}$/;
  const pageKeys = new Map();

  function pruneExpired(storage, now) {
    // Bound the amount of synchronous storage access on a click. Only inspect
    // this feature's entries and never send any of them across events.
    for (let index = storage.length - 1, scanned = 0; index >= 0 && scanned < 32; index--, scanned++) {
      const name = storage.key(index);
      if (!name?.startsWith(storagePrefix)) continue;
      try {
        const saved = JSON.parse(storage.getItem(name));
        if (!(saved?.expiresAt > now)) storage.removeItem(name);
      } catch (_) { storage.removeItem(name); }
    }
  }

  function browserKeyFor(eventId) {
    if (pageKeys.has(eventId)) return pageKeys.get(eventId);
    const storageKey = `${storagePrefix}${eventId}`;
    const now = Date.now();
    let storage;
    try {
      storage = window.localStorage;
      const saved = JSON.parse(storage.getItem(storageKey) || 'null');
      if (saved?.expiresAt > now && typeof saved.key === 'string' && browserKeyPattern.test(saved.key)) {
        pageKeys.set(eventId, saved.key);
        return saved.key;
      }
    } catch (_) { /* Storage is optional, including private browsing. */ }

    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    const key = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    pageKeys.set(eventId, key);
    try {
      if (storage) {
        pruneExpired(storage, now);
        storage.setItem(storageKey, JSON.stringify({ key, expiresAt: now + lifetimeMs }));
      }
    } catch (_) { /* The key still deduplicates clicks on this page. */ }
    return key;
  }

  function track(event) {
    if (!event.isTrusted || event.defaultPrevented) return;
    if (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0) return;
    if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') return;
    const link = event.target?.closest?.('a[data-external-ticket-click]');
    if (!link) return;
    const { externalTicketClick, externalTicketEvent } = link.dataset;
    if (!/^\/api\/public\/events\/[^/?#]+\/external-ticket-click$/.test(externalTicketClick || '') ||
        !/^[1-9]\d{0,9}$/.test(externalTicketEvent || '')) return;
    try {
      // Native link navigation always wins (new tabs and keyboard included).
      // Never send the destination, the page referrer, or an account identifier.
      fetch(externalTicketClick, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserKey: browserKeyFor(externalTicketEvent) }),
        keepalive: true,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer'
      }).catch(() => {});
    } catch (_) { /* Analytics must never block the external ticket link. */ }
  }

  document.addEventListener('click', track);
  document.addEventListener('auxclick', track);
})();
