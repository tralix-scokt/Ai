#!/usr/bin/env node
/* ==========================================================================
   tools/check.mjs — static validation ("build" step for a buildless app).

     1. syntax-check every JavaScript module                  (node --check)
     2. validate manifest.webmanifest and JSON files
     3. verify every asset referenced by index.html exists
     4. verify the service-worker shell list matches real files
     5. scan for leaked API keys and forbidden vendor calls
     6. confirm every element id the JS depends on exists in index.html

   Run: npm run check
   ========================================================================== */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;

const ok = (label, extra = '') => { checks++; console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`); };
const bad = (label, detail = '') => { checks++; failures++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); };

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.arena'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const exists = async (file) => {
  try { await stat(file); return true; } catch { return false; }
};

/* 1 ─ syntax ---------------------------------------------------------------- */
console.log('\n— syntax —');
const allFiles = await walk(root);
const jsFiles = allFiles.filter(f => /\.(m?js)$/.test(f) && !f.includes('node_modules'));

for (const file of jsFiles) {
  const rel = path.relative(root, file);
  try {
    await run(process.execPath, ['--check', file]);
    ok(rel);
  } catch (err) {
    bad(rel, String(err.stderr || err.message).trim().split('\n').slice(0, 4).join('\n      '));
  }
}

/* 2 ─ JSON ----------------------------------------------------------------- */
console.log('\n— json —');
for (const file of ['manifest.webmanifest', 'package.json']) {
  const full = path.join(root, file);
  if (!(await exists(full))) { bad(file, 'missing'); continue; }
  try {
    JSON.parse(await readFile(full, 'utf8'));
    ok(file);
  } catch (err) {
    bad(file, err.message);
  }
}

/* 3 ─ referenced assets ---------------------------------------------------- */
console.log('\n— index.html asset references —');
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
  .map(m => m[1])
  .filter(url => !/^(https?:|data:|#|mailto:)/.test(url));

for (const ref of new Set(refs)) {
  const target = path.join(root, ref.replace(/^\.\//, ''));
  if (await exists(target)) ok(ref);
  else bad(ref, 'referenced by index.html but not found');
}

/* 4 ─ service worker shell ------------------------------------------------- */
console.log('\n— service worker shell —');
const sw = await readFile(path.join(root, 'sw.js'), 'utf8');
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1] || '';
const shell = [...shellBlock.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(p => p !== './');

for (const entry of shell) {
  const target = path.join(root, entry.replace(/^\.\//, ''));
  if (await exists(target)) ok(entry);
  else bad(entry, 'listed in sw.js SHELL but missing');
}

// every module on disk should be cached, otherwise the PWA loads them from network
const moduleFiles = allFiles
  .map(f => `./${path.relative(root, f).split(path.sep).join('/')}`)
  .filter(f => f.startsWith('./assets/') && f.endsWith('.js'));
for (const file of moduleFiles) {
  if (!shell.includes(file)) bad(file, 'module not listed in sw.js SHELL (offline shell would break)');
}
if (moduleFiles.every(f => shell.includes(f))) ok('every assets/js module is in the shell list');

/* 5 ─ secrets & forbidden calls ------------------------------------------- */
console.log('\n— security scan —');
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9_-]{24,}/g, label: 'OpenAI-style key' },
  { re: /AIza[0-9A-Za-z_-]{30,}/g, label: 'Google API key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: 'private key' },
  { re: /(OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/g, label: 'hardcoded key assignment' },
];

const scannable = allFiles.filter(f =>
  /\.(m?js|html|css|json|webmanifest|md|txt|yml|toml|example)$/.test(f)
  && !f.includes('node_modules')
);

/*
 * Two narrow exemptions, and no others:
 *   1. `.example` env templates may hold placeholders.
 *   2. test files may hold a marker-obviously-fake key (sk-test-*, sk-fake-*)
 *      so the harness can drive the backend without a real credential.
 * Everything that ships to a browser is scanned unconditionally — a key-shaped
 * literal in assets/, index.html, sw.js or the manifest is always a failure.
 */
const FAKE_KEY = /^sk-(test|fake|dummy|not-?real|placeholder|xxx|example)/i;
const isTestFixture = (rel) => rel.startsWith(`tests${path.sep}`) || rel.startsWith('tests/');

let leaks = 0;
for (const file of scannable) {
  const text = await readFile(file, 'utf8');
  const rel = path.relative(root, file);
  const isTemplate = rel.endsWith('.example');
  for (const { re, label } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const hit = match[0];
      if (isTemplate && /your-key|sk-\.\.\.|sk-your|example/i.test(hit)) continue;
      if (isTemplate || isTestFixture(rel)) {
        const value = hit.split(/[:=]\s*/).pop().replace(/^["']/, '');
        if (FAKE_KEY.test(value)) continue;
      }
      leaks++;
      bad(`${rel}: possible ${label}`, hit.slice(0, 24) + '…');
    }
  }
}
if (!leaks) ok('no API keys or private keys committed (browser-shipped files are always scanned)');

// the test fixture must never look like a usable credential
{
  const fixture = await readFile(path.join(root, 'tests', 'backend.test.mjs'), 'utf8');
  const used = fixture.match(/OPENAI_API_KEY:\s*'([^']+)'/)?.[1] || '';
  if (FAKE_KEY.test(used)) ok('the backend test uses an obviously-fake key, not a real one');
  else bad('tests/backend.test.mjs', 'the test key is not marked as a fake');
}

// the frontend must not call a vendor API except in the opt-in local transport
for (const file of scannable.filter(f => f.includes(path.sep + 'assets' + path.sep))) {
  const text = await readFile(file, 'utf8');
  const rel = path.relative(root, file);
  if (/api\.openai\.com/.test(text) && !rel.endsWith('api/local.js')) {
    bad(rel, 'calls api.openai.com — only assets/js/api/local.js may do that');
  }
  if (/chatgpt\.com/.test(text)) bad(rel, 'references chatgpt.com — not allowed');
}
if (!failures) ok('no frontend file calls a provider API directly (except the opt-in local transport)');

// the key must never be written into local storage under a "public" name
const keyStorage = scannable.filter(f => f.includes(path.sep + 'assets' + path.sep));
let storageLeak = 0;
for (const file of keyStorage) {
  const text = await readFile(file, 'utf8');
  if (/localStorage\.setItem\(['"][^'"]*(key|token|secret)/i.test(text)) {
    const rel = path.relative(root, file);
    // the single allowed case is the user's own device-only provider key
    const allowed = rel.endsWith('api/local.js') || rel.endsWith('store.js');
    if (!allowed) { storageLeak++; bad(rel, 'writes something key-like to localStorage'); }
  }
}
if (!storageLeak) ok('no unexpected key material in localStorage code paths');

/* 6 ─ DOM contract --------------------------------------------------------- */
console.log('\n— DOM contract —');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const jsSources = await Promise.all(
  moduleFiles.filter(f => f.includes('/assets/')).map(f => readFile(path.join(root, f.replace(/^\.\//, '')), 'utf8'))
);
const usedIds = new Set();
for (const source of jsSources) {
  for (const match of source.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) usedIds.add(match[1]);
  for (const match of source.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) usedIds.add(match[1]);
}

const missing = [...usedIds].filter(id => !htmlIds.has(id));
if (missing.length) {
  for (const id of missing) bad(`#${id}`, 'queried by JavaScript but not present in index.html');
} else {
  ok(`${usedIds.size} element ids referenced by the app all exist in index.html`);
}

/* summary ------------------------------------------------------------------ */
console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
