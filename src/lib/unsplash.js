// Unsplash photo search. Only the Access Key is needed (public Client-ID auth).
// Per Unsplash API Guidelines: hotlink the returned image URLs, credit the
// photographer with a UTM'd link back, and trigger a download event on select.
const ACCESS_KEY = (process.env.UNSPLASH_ACCESS_KEY || '').trim();
const UTM = 'utm_source=silver_glider_events&utm_medium=referral';
const enabled = !!ACCESS_KEY;
const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const searchCache = new Map();
const pendingSearches = new Map();
const COLLECTION_PAGE_LIMIT = 3;
const seasonalCollections = new Map([
  ['christmas', [
    ['decorated christmas tree', 4],
    ['christmas party friends', 4],
    ['presents under christmas tree', 4],
    ['snowman', 4]
  ]],
  ['new-year', [
    ['new year eve party balloons', 5],
    ['new year eve party decorations signs', 5],
    ['champagne toast friends party', 5]
  ]]
]);

async function search(query, page = 1, perPage = 24) {
  const cacheKey = `${query}:${page}:${perPage}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL) return cached.data;
  if (pendingSearches.has(cacheKey)) return pendingSearches.get(cacheKey);
  const pending = fetchPhotos(query, page, perPage).then(result => {
    if (searchCache.size >= 200) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(cacheKey, { createdAt: Date.now(), data: result });
    return result;
  }).finally(() => pendingSearches.delete(cacheKey));
  pendingSearches.set(cacheKey, pending);
  return pending;
}

async function fetchPhotos(query, page, perPage) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}`
    + `&per_page=${perPage}&page=${page}&content_filter=high`;
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${ACCESS_KEY}`, 'Accept-Version': 'v1' }
  });
  if (!res.ok) {
    const err = new Error(
      res.status === 403 || res.status === 429
        ? 'Photo search is temporarily limited. Upload a photo or try again in a bit.'
        : `Unsplash search failed (${res.status})`
    );
    err.status = res.status === 403 || res.status === 429 ? 429 : 502;
    throw err;
  }
  const data = await res.json();
  return {
    page,
    totalPages: data.total_pages || 1,
    results: (data.results || []).map(p => ({
    id: p.id,
    thumb: p.urls.small,
    // regular is ~1080px wide — good for a cover; hotlinked per guidelines
    full: p.urls.regular,
    download_location: p.links.download_location,
    credit_name: p.user.name,
    credit_link: `${p.user.links.html}?${UTM}`
    }))
  };
}

async function searchPicker({ q, collection, page: rawPage, per_page: rawPerPage }) {
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  if (collection == null) {
    const query = String(q || '').trim();
    const perPage = Math.min(24, Math.max(1, parseInt(rawPerPage, 10) || 24));
    return query ? search(query, page, perPage) : { results: [] };
  }

  const topics = seasonalCollections.get(collection);
  if (!topics) throw Object.assign(new Error('Unknown photo collection.'), { status: 400 });
  if (page > COLLECTION_PAGE_LIMIT) return { page, totalPages: COLLECTION_PAGE_LIMIT, results: [] };

  const addFireworks = collection === 'new-year' && page === 1;
  const requests = topics.map(([query, size]) => search(query, page, size));
  if (addFireworks) requests.push(search('new year eve fireworks', 1, 2));
  const settled = await Promise.allSettled(requests);
  const primary = settled.slice(0, topics.length);
  const pages = primary.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!pages.length) throw primary[0].reason;

  const results = [];
  const seen = new Set();
  function add(photo) {
    const key = photo?.id || photo?.full;
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(photo);
  }

  const longest = Math.max(...pages.map(item => item.results.length));
  for (let index = 0; index < longest; index++) {
    for (const item of pages) add(item.results[index]);
  }

  // Fireworks are an accent, not a fallback when party results are scarce.
  const fireworks = addFireworks && settled.at(-1).value?.results;
  if (fireworks) {
    const quota = Math.min(2, Math.floor(results.length / 6));
    fireworks.slice(0, quota).forEach(add);
  }
  return {
    page,
    totalPages: Math.min(COLLECTION_PAGE_LIMIT, Math.max(...pages.map(item => item.totalPages))),
    results
  };
}

// Required by Unsplash when a user actually selects a photo
async function triggerDownload(downloadLocation) {
  if (!enabled || !downloadLocation) return;
  if (!/^https:\/\/api\.unsplash\.com\//.test(downloadLocation)) return; // only ping Unsplash
  try {
    await fetch(downloadLocation, { headers: { Authorization: `Client-ID ${ACCESS_KEY}` } });
  } catch (_) { /* non-fatal */ }
}

module.exports = { search, searchPicker, triggerDownload, enabled, UTM };
