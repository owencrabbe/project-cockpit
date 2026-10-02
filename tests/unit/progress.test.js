'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../../src/core.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'progress-fixture.json'), 'utf8'));
const NOW = new Date(fixture.now);

test('progress fixture document passes validation', () => {
  const result = Core.validateDocument(fixture.document, { now: NOW });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

const validated = Core.validateDocument(fixture.document, { now: NOW }).data;

for (const project of validated.projects) {
  test(`progress fixture: ${project.id}`, () => {
    const expected = fixture.expected[project.id];
    assert.ok(expected, `missing expectation for ${project.id}`);
    const progress = Core.computeProgress(project, NOW);
    assert.equal(progress.numeratorText, expected.numeratorText, 'numerator');
    assert.equal(progress.denominatorText, expected.denominatorText, 'denominator');
    assert.equal(progress.percent, expected.percent, 'percent');
    assert.deepEqual(progress.countedIds, expected.counted, 'counted ids');
    const reasons = Object.fromEntries(progress.milestones.map((m) => [m.id, m.reason]));
    assert.deepEqual(reasons, expected.reasons, 'eligibility reasons');
    assert.equal(progress.confidence.level, expected.confidence, 'confidence level');
    assert.deepEqual(progress.confidence.reasons, expected.confidenceReasons, 'confidence reasons');
    assert.equal(progress.lastVerifiedAt, expected.lastVerifiedAt, 'last verified');
  });
}

test('every fixture expectation maps to a project', () => {
  const ids = validated.projects.map((p) => p.id).sort();
  assert.deepEqual(Object.keys(fixture.expected).sort(), ids);
});

test('decimal weights do not drift (0.1 + 0.2 is exactly 0.3)', () => {
  const project = validated.projects.find((p) => p.id === 'decimals');
  const progress = Core.computeProgress(project, NOW);
  assert.equal(progress.numerator, 0.3);
  assert.equal(progress.ratio, 0.3);
});

// Small seeded PRNG so the randomized check is reproducible.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized: blocked/untested never count and numerator never exceeds denominator', () => {
  const rand = mulberry32(20261002);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let run = 0; run < 500; run += 1) {
    const milestones = [];
    const count = Math.floor(rand() * 12);
    for (let i = 0; i < count; i += 1) {
      milestones.push({
        id: `m${i}`,
        title: `Milestone ${i}`,
        weight: Math.max(0.01, Math.round(rand() * 100000) / 100),
        status: pick(Core.MILESTONE_STATUSES),
        dueDate: null,
        verifiedAt: rand() < 0.7 ? '2026-06-10T00:00:00.000Z' : null,
        evidence: rand() < 0.7 ? [{ label: 'E', url: 'https://example.com/e' }] : [],
        notes: '',
      });
    }
    const blockers = milestones.filter(() => rand() < 0.2).map((m, i) => ({
      id: `b${i}`, description: 'x', owner: '', since: null, milestoneId: m.id, resolved: rand() < 0.5,
    }));
    const project = { id: 'p', name: 'P', milestones, blockers, nextActions: [], decisions: [], status: 'active' };
    const progress = Core.computeProgress(project, NOW);
    assert.ok(progress.numerator <= progress.denominator);
    for (const m of progress.milestones) {
      const source = milestones.find((x) => x.id === m.id);
      if (source.status === 'blocked' || source.status === 'untested') assert.equal(m.counted, false);
      const openLinked = blockers.some((b) => !b.resolved && b.milestoneId === m.id);
      if (openLinked) assert.equal(m.counted, false);
      if (m.counted) {
        assert.equal(source.status, 'complete');
        assert.ok(source.verifiedAt);
        assert.ok(source.evidence.length > 0);
      }
    }
    if (progress.denominator > 0) {
      assert.ok(progress.percent >= 0 && progress.percent <= 100);
      assert.equal(progress.percent === 100, progress.numerator === progress.denominator);
    } else {
      assert.equal(progress.percent, null);
      assert.equal(progress.confidence.level, 'none');
    }
  }
});

test('timeline groups and excludes settled items', () => {
  const doc = {
    projects: [{
      id: 'p1', name: 'P1', status: 'active', dueDate: '2026-06-20', tags: [],
      milestones: [
        { id: 'm1', title: 'Overdue', weight: 1, status: 'in_progress', dueDate: '2026-06-10', verifiedAt: null, evidence: [] },
        { id: 'm2', title: 'Counted', weight: 1, status: 'complete', dueDate: '2026-06-16', verifiedAt: '2026-06-14T00:00:00Z', evidence: [{ label: 'e', url: 'https://example.com' }] },
      ],
      blockers: [],
      nextActions: [
        { id: 'a1', text: 'Today', dueDate: '2026-06-15', done: false },
        { id: 'a2', text: 'Done', dueDate: '2026-06-15', done: true },
      ],
      decisions: [
        { id: 'd1', question: 'Later', neededBy: '2026-08-01', status: 'open', options: [] },
        { id: 'd2', question: 'Decided', neededBy: '2026-06-16', status: 'decided', options: [] },
      ],
    }],
  };
  const items = Core.buildTimeline(doc.projects, NOW);
  assert.deepEqual(items.map((i) => [i.itemId, i.group]), [
    ['m1', 'overdue'],
    ['a1', 'week'],
    ['p1', 'week'],
    ['d1', 'later'],
  ]);
  assert.equal(items[0].daysUntil, -5);
});

test('project snapshot flags "done" projects that are not fully verified', () => {
  const project = validated.projects.find((p) => p.id === 'stale');
  const snap = Core.projectSnapshot({ ...project, status: 'done' }, NOW);
  assert.deepEqual(snap.warnings, ['Marked done, but only 50% is verified complete']);
});

test('filterProjects filters by status, text and attention and sorts', () => {
  const rows = Core.filterProjects(validated.projects, { status: 'planned' }, NOW);
  assert.deepEqual(rows.map((r) => r.project.id).sort(), ['empty', 'nothing-claimed']);
  const text = Core.filterProjects(validated.projects, { q: 'DECIMAL' }, NOW);
  assert.deepEqual(text.map((r) => r.project.id), ['decimals']);
  const attention = Core.filterProjects(validated.projects, { attention: true }, NOW);
  assert.deepEqual(attention.map((r) => r.project.id).sort(), ['exclusions', 'overdue']);
  const byProgress = Core.filterProjects(validated.projects, { sort: 'progress_desc' }, NOW);
  assert.equal(byProgress[0].snapshot.progress.percent, 100);
  assert.equal(byProgress[byProgress.length - 1].project.id, 'empty');
});
