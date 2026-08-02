const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const failures = [];

function walk(relativeDir) {
  const absoluteDir = path.join(ROOT, relativeDir);
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(relativeDir, entry.name);
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fail(message) {
  failures.push(message);
}

const projectFiles = ['src', 'public', 'test', 'scripts'].flatMap(walk);
const javascriptFiles = projectFiles.filter(file => file.endsWith('.js'));

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
  if (result.status !== 0) fail(`${file}: ${String(result.stderr || result.stdout).trim()}`);
}

for (const file of javascriptFiles.filter(file => file.startsWith('src/'))) {
  const source = read(file);
  for (const match of source.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
    const target = path.resolve(ROOT, path.dirname(file), match[1]);
    if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`) && !fs.existsSync(path.join(target, 'index.js'))) {
      fail(`${file}: missing local require ${match[1]}`);
    }
  }
}

for (const file of projectFiles.filter(file => /\.(?:css|html|js)$/.test(file))) {
  const source = read(file);
  const references = [
    ...source.matchAll(/(?:src|href)=["']\/(css|js|images)\/([^"'?#]+)["']/g),
    ...source.matchAll(/url\(["']?\/(images)\/([^"')?#]+)["']?\)/g)
  ];
  for (const match of references) {
    const asset = path.join('public', match[1], match[2]);
    if (!fs.existsSync(path.join(ROOT, asset))) fail(`${file}: missing local asset /${match[1]}/${match[2]}`);
  }
}

const publicRoute = read('src/routes/public.js');
const hostRoute = read('src/routes/public-hosts.js');
for (const [templatePath, renderer] of [
  ['src/views/event-public.html', publicRoute],
  ['src/views/event-public-flyer.html', publicRoute],
  ['src/views/host-public.html', hostRoute]
]) {
  const replacedPlaceholders = new Set(
    [...renderer.matchAll(/\.replace\(\/\{\{([A-Z0-9_]+)\}\}\/g/g)].map(match => match[1])
  );
  const placeholders = new Set([...read(templatePath).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(match => match[1]));
  for (const placeholder of placeholders) {
    if (!replacedPlaceholders.has(placeholder)) fail(`${templatePath}: placeholder {{${placeholder}}} has no renderer replacement`);
  }
}

const eventJsonBlock = publicRoute.match(/const eventJson = \{([\s\S]*?)\n    \};/)?.[1] || '';
const eventJsonKeys = [...eventJsonBlock.matchAll(/^\s*([A-Za-z_$][\w$]*)(?::|,)/gm)].map(match => match[1]);
const publicClient = read('public/js/public-event.js');
for (const key of eventJsonKeys) {
  if (!new RegExp(`\\bEVENT\\.${key}\\b`).test(publicClient)) {
    fail(`src/routes/public.js: event-data field ${key} is not read by public/js/public-event.js`);
  }
}

if (failures.length) {
  console.error(`Static checks failed (${failures.length}):`);
  failures.forEach(message => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(`Static checks passed (${javascriptFiles.length} JavaScript files, ${projectFiles.length} project files).`);
}
