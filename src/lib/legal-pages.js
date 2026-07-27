const fs = require('fs');
const path = require('path');

const legalDir = path.join(__dirname, '..', 'legal');
const documents = {
  terms: {
    title: 'Terms of Service',
    description: 'Terms governing access to and use of the Silver Glider Events platform.',
    path: '/terms',
    text: fs.readFileSync(path.join(legalDir, 'terms.txt'), 'utf8')
  },
  privacy: {
    title: 'Privacy Policy',
    description: 'How Silver Glider Entertainment Inc. collects, uses, and protects data across Silver Glider Events.',
    path: '/privacy',
    text: fs.readFileSync(path.join(legalDir, 'privacy.txt'), 'utf8')
  }
};

const privacySections = new Set([
  'Owner and Data Controller',
  'Types of Data We Collect',
  'Data We Collect Automatically',
  'Data You Give to Us',
  'Mode and Place of Processing the Data',
  'The Purposes of Processing',
  'Detailed Information on the Processing of Personal Data',
  'Further Information for Users in the European Union',
  'Further Information for Users in the United States',
  'Additional Information About Data Collection and Processing',
  'Definitions and Legal References',
  'SMS Messaging Program',
  'Contact'
]);

const privacySubsections = new Set([
  'Methods of processing',
  'Place',
  'Retention time',
  'Handling and Facilitating Payments for Event Access',
  'Event Access, Ticket Issuance, and Activity History',
  'Event Host Application Data',
  'Public Host Profiles',
  'Follower Relationships',
  'Hosting and Backend Infrastructure',
  'Managing Contacts and Sending Messages',
  'Registration and Authentication',
  'SMS Communications and The Silver Glider Line',
  'Weekly Event Drop Email Subscription',
  'Cookie Policy',
  'Legal basis of processing',
  'Rights of Users under GDPR',
  'Notice at Collection',
  'Your Privacy Rights Under US State Laws',
  'Additional Rights for California Residents (CCPA/CPRA)',
  'Legal action',
  'System logs and maintenance',
  'Changes to this privacy policy'
]);

const definitionLabels = new Set([
  'Personal Data',
  'Usage Data',
  'User',
  'Data Controller',
  'Tracker',
  'Event Access',
  'Host',
  'Sale',
  'Merchant of Record'
]);

const listsAfterHeading = new Map([
  ['Your Privacy Rights Under US State Laws', 6],
  ['Additional Rights for California Residents (CCPA/CPRA)', 3]
]);

const listLengths = new Map([
  ['Silver Glider does not guarantee:', 3],
  ['To access certain features you may need to create an account. You agree to:', 3],
  ['This means the Host (not Silver Glider) is the seller of record for Tickets and is responsible for:', 6],
  ['As a Host you represent, warrant, and agree:', 4],
  ['You agree that:', 3],
  ['When purchasing a Ticket:', 3],
  ['You agree not to:', 9],
  ['Silver Glider may, at any time and in its sole discretion:', 4],
  ['SILVER GLIDER DOES NOT WARRANT THAT:', 3],
  ['Either party may:', 2],
  ['You agree to indemnify, defend, and hold harmless Silver Glider and its officers, directors, employees, contractors, and agents from claims, liabilities, damages, losses, and expenses (including attorneys’ fees) arising from:', 4],
  ['Among the types of Personal Data that Silver Glider Events collects, by itself or through third parties, there are:', 10],
  ['The Data concerning the User is collected to allow Silver Glider Entertainment Inc. to provide the Platform, comply with its legal obligations, respond to enforcement requests, protect its rights and interests, detect any malicious or fraudulent activity, as well as the following:', 8],
  ['The Owner may process Personal Data relating to Users if one of the following applies:', 4],
  ['Users have the right to:', 8]
]);

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(value) {
  return esc(value)
    .replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/g, '<a href="mailto:$1">$1</a>');
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function classify(kind, line) {
  if (kind === 'terms') {
    if (/^\d+\.\s/.test(line)) return 'section';
    if (/^\d+\.\d+\s/.test(line)) return 'subsection';
    return 'paragraph';
  }
  if (privacySections.has(line)) return 'section';
  if (privacySubsections.has(line) || definitionLabels.has(line)) return 'subsection';
  return 'paragraph';
}

function renderDocument(kind, text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const toc = [];
  const body = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const type = classify(kind, line);
    if (type === 'section') {
      const id = slug(line);
      toc.push({ id, label: line });
      body.push(`<section class="legal-section" aria-labelledby="${id}"><h2 id="${id}">${inline(line)}</h2></section>`);
      continue;
    }
    if (type === 'subsection') {
      body.push(`<h3 id="${slug(line)}">${inline(line)}</h3>`);
      const count = listsAfterHeading.get(line);
      if (count) {
        const items = lines.slice(index + 1, index + 1 + count);
        body.push(`<ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
        index += count;
      }
      continue;
    }

    const count = listLengths.get(line);
    if (count) {
      const items = lines.slice(index + 1, index + 1 + count);
      body.push(`<p>${inline(line)}</p><ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
      index += count;
      continue;
    }

    const caps = line.length > 30 && line === line.toUpperCase();
    body.push(`<p${caps ? ' class="legal-caps"' : ''}>${inline(line)}</p>`);
  }

  return {
    body: body.join('\n'),
    toc: toc.map(item => `<li><a href="#${item.id}">${esc(item.label)}</a></li>`).join('')
  };
}

function renderLegalPage(kind) {
  const doc = documents[kind];
  if (!doc) throw new Error('Unknown legal document');
  const baseUrl = String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/+$/, '');
  const canonical = `${baseUrl}${doc.path}`;
  const rendered = renderDocument(kind, doc.text);
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: doc.title,
    description: doc.description,
    url: canonical,
    publisher: {
      '@type': 'Organization',
      name: 'Silver Glider Entertainment Inc.',
      url: baseUrl
    }
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(doc.title)} — Silver Glider Events</title>
  <meta name="description" content="${esc(doc.description)}">
  <meta name="robots" content="index,follow">
  <meta name="theme-color" content="#0e0e0e">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(doc.title)} — Silver Glider Events">
  <meta property="og:description" content="${esc(doc.description)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${esc(baseUrl)}/logo.png">
  <link rel="stylesheet" href="/css/brand.css">
  <link rel="stylesheet" href="/css/legal.css">
  <script type="application/ld+json">${schema}</script>
  <script src="/js/legal-footer.js" defer></script>
</head>
<body class="legal-page">
  <div class="legal-backdrop" aria-hidden="true"></div>
  <header class="legal-nav">
    <a class="legal-brand" href="/" aria-label="Silver Glider Events home">
      <img src="/logo.png" alt="">
      <span>Silver Glider <b>Events</b></span>
    </a>
    <a class="legal-home-link" href="/">Back to home</a>
  </header>
  <main>
    <header class="legal-hero">
      <p class="sg-label">Silver Glider Entertainment Inc.</p>
      <h1>${esc(doc.title)}</h1>
      <p>${esc(doc.description)}</p>
    </header>
    <div class="legal-layout">
      <aside>
        <details class="legal-toc" open>
          <summary>On this page</summary>
          <ol>${rendered.toc}</ol>
        </details>
      </aside>
      <article class="legal-article">
        ${rendered.body}
      </article>
    </div>
  </main>
  <script>
    if (window.matchMedia('(max-width: 760px)').matches) {
      document.querySelector('.legal-toc')?.removeAttribute('open');
    }
  </script>
</body>
</html>`;
}

module.exports = { renderLegalPage };
