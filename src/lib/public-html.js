function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(value) {
  return new Date(value).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function render404() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Event not found</title><link rel="stylesheet" href="/css/brand.css"><script src="/js/legal-footer.js" defer></script></head>
<body><main style="max-width:400px;margin:0 auto;padding:20vh 24px;text-align:center">
<p class="sg-label" style="margin-bottom:20px">Silver Glider Events</p>
<h1 style="font-size:30px;margin-bottom:10px">Event not found</h1>
<p style="color:var(--sg-text-dim);font-size:15px">This event may have been removed, or the link is wrong.</p>
</main></body></html>`;
}

module.exports = { esc, fmtDate, render404 };
