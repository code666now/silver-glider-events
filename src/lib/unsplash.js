// Unsplash photo search. Only the Access Key is needed (public Client-ID auth).
// Per Unsplash API Guidelines: hotlink the returned image URLs, credit the
// photographer with a UTM'd link back, and trigger a download event on select.
const ACCESS_KEY = (process.env.UNSPLASH_ACCESS_KEY || '').trim();
const UTM = 'utm_source=silver_glider_events&utm_medium=referral';
const enabled = !!ACCESS_KEY;

async function search(query, page = 1) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}`
    + `&per_page=24&page=${page}&content_filter=high`;
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${ACCESS_KEY}`, 'Accept-Version': 'v1' }
  });
  if (!res.ok) throw new Error(`Unsplash search failed (${res.status})`);
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

// Required by Unsplash when a user actually selects a photo
async function triggerDownload(downloadLocation) {
  if (!enabled || !downloadLocation) return;
  if (!/^https:\/\/api\.unsplash\.com\//.test(downloadLocation)) return; // only ping Unsplash
  try {
    await fetch(downloadLocation, { headers: { Authorization: `Client-ID ${ACCESS_KEY}` } });
  } catch (_) { /* non-fatal */ }
}

module.exports = { search, triggerDownload, enabled, UTM };
