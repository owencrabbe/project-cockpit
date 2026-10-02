#!/usr/bin/env node
/* Builds dist/project-cockpit-<version>.zip from the committed source (git archive). */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `project-cockpit-${version}.zip`);
execFileSync('git', ['archive', '--format=zip', `--prefix=project-cockpit-${version}/`, '-o', out, 'HEAD'], { cwd: root, stdio: 'inherit' });
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
