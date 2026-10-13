'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../../src/core.js');
const Sample = require('../../src/sample-data.js');

const ROOT = path.join(__dirname, '..', '..');
const NOW = new Date('2026-06-15T12:00:00Z');

test('safeHttpUrl accepts only absolute http(s) URLs', () => {
  assert.equal(Core.safeHttpUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(Core.safeHttpUrl('HTTP://EXAMPLE.COM'), 'http://example.com/');
  assert.equal(Core.safeHttpUrl('  https://example.org/x  '), 'https://example.org/x');
  const rejected = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'blob:https://example.com/uuid',
    'mailto:someone@example.com',
    '/relative/path',
    '//example.com/protocol-relative',
    'example.com',
    'https://user:secret@example.com/',
    'https://user@example.com/',
    'https://',
    'https://exa mple.com',
    `https://example.com/${'a'.repeat(Core.LIMITS.urlLength)}`,
    '',
    null,
    42,
  ];
  for (const value of rejected) {
    assert.equal(Core.safeHttpUrl(value), null, `should reject ${JSON.stringify(value)}`);
  }
});

test('imports with unsafe evidence URLs are rejected', () => {
  for (const url of ['javascript:alert(document.cookie)', 'data:text/html;base64,PHNjcmlwdD4=', 'https://a:b@example.com']) {
    const input = {
      schema: 'project-cockpit',
      version: 1,
      projects: [{
        id: 'p', name: 'P', status: 'active',
        milestones: [{ id: 'm', title: 'M', weight: 1, status: 'complete', evidence: [{ label: 'x', url }] }],
      }],
    };
    const result = Core.validateDocument(input, { now: NOW });
    assert.equal(result.ok, false, url);
    assert.match(Core.formatIssue(result.errors[0]), /evidence\[0\]\.url: must be an absolute http:\/\/ or https:\/\/ URL/);
  }
});

test('__proto__ keys in imports cannot pollute prototypes', () => {
  const text = `{
    "schema": "project-cockpit", "version": 1,
    "__proto__": { "polluted": "doc" },
    "projects": [{
      "id": "p", "name": "P", "status": "active",
      "__proto__": { "polluted": "project" },
      "constructor": { "prototype": { "polluted": "ctor" } },
      "milestones": [{ "id": "m", "title": "M", "weight": 1, "status": "complete",
        "__proto__": { "polluted": "milestone" },
        "evidence": [{ "label": "x", "url": "https://example.com", "__proto__": { "polluted": "evidence" } }] }]
    }]
  }`;
  const result = Core.parseDocumentText(text, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const p = result.data.projects[0];
  assert.equal(Object.getPrototypeOf(p), Object.prototype);
  assert.equal(p.polluted, undefined);
  assert.equal(p.milestones[0].polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(p, '__proto__'), false);
  assert.ok(result.warnings.some((w) => w.path.endsWith('.__proto__')));
});

test('HTML-like text is kept as plain data (rendering escapes it)', () => {
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const input = { schema: 'project-cockpit', version: 1, projects: [{ id: 'p', name: payload.slice(0, 120), status: 'active' }] };
  const result = Core.validateDocument(input, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.data.projects[0].name, payload.slice(0, 120));
});

test('browser source never uses HTML-parsing or code-evaluating sinks', () => {
  const sinks = [
    /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/,
    /new\s+Function\s*\(/, /setTimeout\(\s*['"`]/, /setInterval\(\s*['"`]/, /setAttribute\(\s*['"]on/i,
    /setAttribute\(\s*['"]style/i, /\.srcdoc\b/, /createContextualFragment/, /DOMParser/,
  ];
  for (const file of ['core.js', 'storage.js', 'sample-data.js', 'app.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    for (const sink of sinks) {
      assert.equal(sink.test(source), false, `${file} matches ${sink}`);
    }
  }
});

test('index.html ships a strict CSP and no inline script or handlers', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, 'CSP meta tag present');
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp[1], /unsafe-inline|unsafe-eval/);
  assert.match(csp[1], /object-src 'none'/);
  assert.match(csp[1], /base-uri 'none'/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  assert.ok(scripts.length > 0);
  for (const tag of scripts) assert.match(tag, /\ssrc="src\/[a-z-]+\.js"/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
});

test('sample data is fictional: evidence links use reserved example domains only', () => {
  const sample = Sample.buildSampleDocument(NOW);
  const urls = sample.projects.flatMap((p) => p.milestones.flatMap((m) => m.evidence.map((e) => e.url)));
  assert.ok(urls.length > 0);
  for (const url of urls) {
    const host = new URL(url).hostname;
    assert.ok(/(^|\.)example\.(com|org)$/.test(host), `${url} is not on a reserved example domain`);
  }
  for (const p of sample.projects) assert.match(p.summary, /\(fictional example\)/);
});
