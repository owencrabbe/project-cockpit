'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../../src/core.js');
const Sample = require('../../src/sample-data.js');

const NOW = new Date('2026-06-15T12:00:00Z');

function doc(projects) {
  return { schema: 'project-cockpit', version: 1, projects };
}

function project(overrides) {
  return { id: 'p1', name: 'Project', status: 'active', ...overrides };
}

function milestone(overrides) {
  return { id: 'm1', title: 'Milestone', weight: 10, status: 'not_started', ...overrides };
}

function errorsFor(input) {
  const result = Core.validateDocument(input, { now: NOW });
  assert.equal(result.ok, false, 'expected validation to fail');
  assert.equal(result.data, null);
  return result.errors.map(Core.formatIssue);
}

function assertError(input, pattern) {
  const errors = errorsFor(input);
  assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in:\n${errors.join('\n')}`);
}

test('sample data and shipped examples are valid', () => {
  assert.equal(Core.validateDocument(Sample.buildSampleDocument(NOW), { now: NOW }).ok, true);
  for (const file of ['sample-cockpit.json', 'minimal.json']) {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', 'examples', file), 'utf8');
    const result = Core.parseDocumentText(text);
    assert.deepEqual(result.errors, [], file);
    assert.deepEqual(result.warnings, [], file);
  }
});

test('export then import round-trips exactly', () => {
  const original = Core.validateDocument(Sample.buildSampleDocument(NOW), { now: NOW }).data;
  const text = Core.serializeDocument(original, NOW);
  const again = Core.parseDocumentText(text, { now: NOW });
  assert.equal(again.ok, true);
  assert.deepEqual(again.data, original);
});

test('rejects files over the size limit before parsing', () => {
  const padded = `${JSON.stringify(doc([]))}${' '.repeat(Core.LIMITS.importBytes)}`;
  const result = Core.parseDocumentText(padded, { now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /limit is 2\.00 MiB/);
});

test('size limit counts UTF-8 bytes, not characters', () => {
  const name = 'é'.repeat(100);
  const text = JSON.stringify(doc([project({ name })]));
  const result = Core.parseDocumentText(text, { now: NOW, maxBytes: text.length + 10 });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /limit/);
});

test('accepts a file just under the size limit', () => {
  const base = JSON.stringify(doc([]));
  const padded = base + ' '.repeat(Core.LIMITS.importBytes - base.length - 1);
  assert.equal(Core.parseDocumentText(padded, { now: NOW }).ok, true);
});

test('rejects empty input, invalid JSON and non-objects', () => {
  assert.match(Core.parseDocumentText('', { now: NOW }).errors[0].message, /empty/);
  assert.match(Core.parseDocumentText('{"schema":', { now: NOW }).errors[0].message, /not valid JSON/);
  assert.match(Core.parseDocumentText('[]', { now: NOW }).errors[0].message, /JSON object/);
  assert.match(Core.parseDocumentText('null', { now: NOW }).errors[0].message, /JSON object/);
  assert.equal(Core.parseDocumentText('﻿{"schema":"project-cockpit","version":1,"projects":[]}').ok, true);
});

test('rejects wrong schema id, version and projects type', () => {
  assertError({ schema: 'other', version: 1, projects: [] }, /\$\.schema: must be "project-cockpit"/);
  assertError({ schema: 'project-cockpit', version: 2, projects: [] }, /\$\.version: must be 1/);
  assertError({ schema: 'project-cockpit', version: '1', projects: [] }, /\$\.version/);
  assertError({ schema: 'project-cockpit', version: 1, projects: {} }, /\$\.projects: must be an array/);
});

test('validates milestone weights', () => {
  const bad = [0, -5, '10', null, 1001, 0.001, true];
  for (const weight of bad) {
    assertError(doc([project({ milestones: [milestone({ weight })] })]), /weight/);
  }
  // 1e309 overflows to Infinity during JSON parsing.
  const overflow = Core.parseDocumentText('{"schema":"project-cockpit","version":1,"projects":[{"id":"p","name":"P","status":"active","milestones":[{"id":"m","title":"M","weight":1e309,"status":"complete"}]}]}', { now: NOW });
  assert.equal(overflow.ok, false);
  assert.match(Core.formatIssue(overflow.errors[0]), /weight: is required and must be a finite number/);
  for (const weight of [0.01, 1, 33.33, 1000]) {
    assert.equal(Core.validateDocument(doc([project({ milestones: [milestone({ weight })] })]), { now: NOW }).ok, true, String(weight));
  }
});

test('validates statuses', () => {
  assertError(doc([project({ status: 'finished' })]), /\.status: must be one of: planned/);
  assertError(doc([project({ status: undefined })]), /\.status: is required/);
  assertError(doc([project({ milestones: [milestone({ status: 'done' })] })]), /milestones\[0\]\.status: must be one of: not_started/);
  assertError(doc([project({ milestones: [milestone({ status: undefined })] })]), /milestones\[0\]\.status: is required/);
  assertError(doc([project({ priority: 'urgent' })]), /priority/);
  assertError(doc([project({ decisions: [{ id: 'd', question: 'Q', status: 'maybe' }] })]), /decisions\[0\]\.status/);
});

test('decided decisions must record the decision', () => {
  assertError(doc([project({ decisions: [{ id: 'd', question: 'Q', status: 'decided' }] })]), /decision: is required when status is "decided"/);
});

test('validates dates and timestamps', () => {
  assertError(doc([project({ dueDate: '2026-02-30' })]), /dueDate: must be a calendar date/);
  assertError(doc([project({ dueDate: '2026-13-01' })]), /dueDate/);
  assertError(doc([project({ dueDate: 'tomorrow' })]), /dueDate/);
  assertError(doc([project({ updatedAt: '2026-06-01' })]), /updatedAt: must be an ISO 8601 timestamp/);
  assertError(doc([project({ milestones: [milestone({ verifiedAt: '2026-06-01T10:00:00' })] })]), /verifiedAt: must be an ISO 8601/);
});

test('rejects verification timestamps in the future', () => {
  assertError(doc([project({ milestones: [milestone({ verifiedAt: '2026-06-16T12:00:00Z' })] })]), /verifiedAt: must not be in the future/);
  // Small clock skew (under 5 minutes) is tolerated.
  const skew = doc([project({ milestones: [milestone({ verifiedAt: '2026-06-15T12:03:00Z' })] })]);
  assert.equal(Core.validateDocument(skew, { now: NOW }).ok, true);
  // Stored data can opt out so a device clock change never locks a user out.
  const future = doc([project({ milestones: [milestone({ verifiedAt: '2026-06-16T12:00:00Z' })] })]);
  assert.equal(Core.validateDocument(future, { now: NOW, futureCheck: false }).ok, true);
});

test('rejects duplicate ids and dangling milestone references', () => {
  assertError(doc([project(), project()]), /\$\.projects\[1\]\.id: duplicate id "p1"/);
  assertError(doc([project({ milestones: [milestone(), milestone()] })]), /milestones\[1\]\.id: duplicate id "m1"/);
  assertError(doc([project({ milestones: [milestone()], blockers: [{ id: 'b', description: 'x', milestoneId: 'nope' }] })]), /milestoneId: refers to unknown milestone "nope"/);
  assertError(doc([project({ id: 'has space' })]), /\.id: must be/);
  assertError(doc([project({ id: 'x'.repeat(65) })]), /\.id: must be/);
});

test('enforces collection and text limits', () => {
  const many = Array.from({ length: Core.LIMITS.projects + 1 }, (_, i) => project({ id: `p${i}` }));
  assertError(doc(many), /projects: has 201 items; the limit is 200/);
  assertError(doc([project({ name: 'x'.repeat(121) })]), /name: must be at most 120 characters/);
  assertError(doc([project({ summary: 'x'.repeat(2001) })]), /summary: must be at most 2000 characters/);
  assertError(doc([project({ name: 'bad\u0007bell' })]), /name: contains control characters/);
  assertError(doc([project({ name: '   ' })]), /name: must not be empty/);
  const milestones = Array.from({ length: 101 }, (_, i) => milestone({ id: `m${i}` }));
  assertError(doc([project({ milestones })]), /milestones: has 101 items/);
});

test('ignores unknown fields with a warning and drops them', () => {
  const input = { ...doc([project({ extra: 1, milestones: [milestone({ color: 'red' })] })]), meta: {} };
  const result = Core.validateDocument(input, { now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((w) => w.path).sort(), ['$.meta', '$.projects[0].extra', '$.projects[0].milestones[0].color']);
  assert.equal('extra' in result.data.projects[0], false);
  assert.equal('meta' in result.data, false);
  assert.equal('color' in result.data.projects[0].milestones[0], false);
});

test('normalizes optional fields to explicit defaults', () => {
  const result = Core.validateDocument(doc([project({ tags: ['Web', 'web', ' ops '] })]), { now: NOW });
  const p = result.data.projects[0];
  assert.deepEqual(p.tags, ['web', 'ops']);
  assert.equal(p.priority, 'medium');
  assert.equal(p.summary, '');
  assert.equal(p.dueDate, null);
  assert.deepEqual(p.milestones, []);
});

test('caps the number of reported errors', () => {
  const bad = Array.from({ length: 120 }, (_, i) => project({ id: `p${i}`, status: 'nope' }));
  const result = Core.validateDocument(doc(bad), { now: NOW });
  assert.equal(result.errors.length, Core.LIMITS.errorsReported);
  assert.equal(result.truncated, true);
});
