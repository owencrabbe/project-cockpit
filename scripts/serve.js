#!/usr/bin/env node
/*
 * Minimal static file server for local use and tests. No dependencies.
 * Serves the project folder on 127.0.0.1 only. Usage: node scripts/serve.js [port]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const SERVED_DIRS = ['', 'src', 'styles', 'examples'];
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};

function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch (err) {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(ROOT, relative);
  if (!full.startsWith(ROOT + path.sep)) return null;
  const dir = path.relative(ROOT, path.dirname(full));
  if (!SERVED_DIRS.includes(dir)) return null;
  if (!TYPES[path.extname(full)]) return null;
  return full;
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...HEADERS });
      res.end();
      return;
    }
    const file = resolveFile(req.url || '/');
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS });
      res.end('Not found');
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], ...HEADERS });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Project Cockpit running at http://127.0.0.1:${port}/`);
  });
}

module.exports = { createServer };
