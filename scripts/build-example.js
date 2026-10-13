#!/usr/bin/env node
/* Regenerates examples/sample-cockpit.json from the fictional sample data at a fixed date. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Core = require('../src/core.js');
const Sample = require('../src/sample-data.js');

const FIXED_NOW = new Date('2026-10-01T12:00:00Z');
const doc = Sample.buildSampleDocument(FIXED_NOW);
const result = Core.validateDocument(doc, { now: FIXED_NOW });
if (!result.ok) {
  console.error(result.errors.map(Core.formatIssue).join('\n'));
  process.exit(1);
}
const out = path.join(__dirname, '..', 'examples', 'sample-cockpit.json');
fs.writeFileSync(out, Core.serializeDocument(result.data, FIXED_NOW));
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
