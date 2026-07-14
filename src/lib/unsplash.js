// Unsplash photo search. Only the Access Key is needed (public Client-ID auth).
// Per Unsplash API Guidelines: hotlink the returned image URLs, credit the
// photographer with a UTM'd link back, and trigger a download event on select.
const ACCESS_KEY = (process.env.UNSPLASH_ACCESS_KEY || '').trim();
const UTM = 'utm_source=silver_glider_events&utm_medium=referral';
const enabled = !!ACCESS_KEY;
const SEARCH_CACHE_TTL = 30 * 60 * 1000;
const searchCache = new Map();

async function search(query, page = 1, perPage = 24) {
  const cacheKey = `${query}:${page}:${perPage}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL) return cached.data;

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
  const result = {
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
  if (searchCache.size >= 200) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(cacheKey, { createdAt: Date.now(), data: result });
  return result;
}

// Required by Unsplash when a user actually selects a photo
async function triggerDownload(downloadLocation) {
  if (!enabled || !downloadLocation) return;
  if (!/^https:\/\/api\.unsplash\.com\//.test(downloadLocation)) return; // only ping Unsplash
  try {
    await fetch(downloadLocation, { headers: { Authorization: `Client-ID ${ACCESS_KEY}` } });
  } catch (_) { /* non-fatal */ }
}

module.exports = { search, triggerDownload, enabled, UTM };
