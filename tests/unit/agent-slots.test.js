'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../src/core.js');
const Storage = require('../../src/storage.js');
const Sample = require('../../src/sample-data.js');

const NOW = new Date('2026-06-15T12:00:00Z');
const SLOT_IDS = ['studio', 'security', 'research', 'hackathon', 'qa'];
const HOUR = 60 * 60 * 1000;

function doc(agentSlots) {
  const out = { schema: 'project-cockpit', version: 1, projects: [] };
  if (agentSlots !== undefined) out.agentSlots = agentSlots;
  return out;
}

function errorsFor(input) {
  const result = Core.validateDocument(input, { now: NOW });
  assert.equal(result.ok, false, 'expected validation to fail');
  return result.errors.map(Core.formatIssue);
}

function assertError(input, pattern) {
  const errors = errorsFor(input);
  assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in:\n${errors.join('\n')}`);
}

function valid(input) {
  const result = Core.validateDocument(input, { now: NOW });
  assert.deepEqual(result.errors, []);
  return result.data;
}

const hoursAgo = (n) => new Date(NOW.getTime() - n * HOUR).toISOString();

test('files without agentSlots get five default slots: unbound, offline, no session connected', () => {
  const result = Core.validateDocument(doc(), { now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.data.agentSlots.map((s) => s.id), SLOT_IDS);
  assert.deepEqual(result.data.agentSlots.map((s) => s.name), ['Studio', 'Security', 'Research', 'Hackathon', 'QA']);
  for (const slot of result.data.agentSlots) {
    assert.equal(slot.sessionUrl, null);
    assert.equal(slot.status, 'offline');
    assert.equal(slot.verifiedAt, null);
    assert.deepEqual(slot.milestones, []);
    const view = Core.agentSlotView(slot, NOW);
    assert.equal(view.bound, false);
    assert.equal(view.connection, 'No session connected');
    assert.equal(view.stale, false);
  }
  assert.deepEqual(Core.createEmptyDocument().agentSlots, result.data.agentSlots);
});

test('slots come back in fixed order with missing ones filled in', () => {
  const data = valid(doc([{ id: 'qa', status: 'queued', statusNote: 'Next up' }, { id: 'studio' }]));
  assert.deepEqual(data.agentSlots.map((s) => s.id), SLOT_IDS);
  assert.equal(data.agentSlots[4].status, 'queued');
  assert.equal(data.agentSlots[4].statusNote, 'Next up');
  assert.equal(data.agentSlots[1].status, 'offline');
});

test('slot names are fixed by id', () => {
  const data = valid(doc([{ id: 'studio', name: 'Renamed' }]));
  assert.equal(data.agentSlots[0].name, 'Studio');
});

test('rejects unknown, duplicate, non-array or too many slots', () => {
  assertError(doc([{ id: 'ops' }]), /\$\.agentSlots\[0\]\.id: must be one of: studio, security, research, hackathon, qa/);
  assertError(doc([{ id: 'studio' }, { id: 'studio' }]), /agentSlots\[1\]\.id: duplicate id "studio"/);
  assertError(doc({}), /\$\.agentSlots: must be an array/);
  assertError(doc(SLOT_IDS.concat('studio').map((id) => ({ id }))), /agentSlots: has 6 items; the limit is 5/);
});

test('session links must be https without credentials or secret-looking parameters', () => {
  const accepted = [
    'https://agents.example.com/sessions/abc123',
    'https://agents.example.com/s?page=2&view=log',
    'https://agents.example.com/s#summary',
    'HTTPS://AGENTS.EXAMPLE.COM/s',
  ];
  for (const url of accepted) assert.ok(Core.checkSessionUrl(url).url, url);
  const notHttps = [
    'http://agents.example.com/s', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pw@agents.example.com/s',
    'https://user@agents.example.com/s', '/sessions/abc', '//agents.example.com/s', 'ftp://agents.example.com/s', '', null,
  ];
  for (const url of notHttps) {
    assert.equal(Core.checkSessionUrl(url).url, null, String(url));
    assert.match(Core.checkSessionUrl(url).problem, /https:\/\//);
  }
  const secrets = [
    'https://agents.example.com/s?token=abc',
    'https://agents.example.com/s?access_token=abc',
    'https://agents.example.com/s?api_key=abc',
    'https://agents.example.com/s?apiKey=abc',
    'https://agents.example.com/s?key=abc',
    'https://agents.example.com/s?sig=abc',
    'https://agents.example.com/s?X-Amz-Signature=abc',
    'https://agents.example.com/s?code=abc',
    'https://agents.example.com/s?password=abc',
    'https://agents.example.com/s#access_token=abc&state=x',
    'https://agents.example.com/s#id_token=abc',
  ];
  for (const url of secrets) {
    assert.equal(Core.checkSessionUrl(url).url, null, url);
    assert.match(Core.checkSessionUrl(url).problem, /must not include tokens/);
  }
  assertError(doc([{ id: 'studio', sessionUrl: 'http://agents.example.com/s', status: 'offline' }]),
    /\$\.agentSlots\[0\]\.sessionUrl: must be an absolute https:\/\/ URL/);
  assertError(doc([{ id: 'studio', sessionUrl: 'https://agents.example.com/s?token=1', status: 'offline' }]),
    /\$\.agentSlots\[0\]\.sessionUrl: must not include tokens/);
});

test('slots without a session link can only be queued or offline', () => {
  assertError(doc([{ id: 'studio', status: 'running' }]), /agentSlots\[0\]\.status: must be "queued" or "offline" when no session link is recorded/);
  assertError(doc([{ id: 'studio', status: 'waiting' }]), /agentSlots\[0\]\.status: must be "queued" or "offline"/);
  valid(doc([{ id: 'studio', status: 'queued' }]));
  valid(doc([{ id: 'studio', status: 'offline' }]));
  valid(doc([{ id: 'studio', status: 'running', sessionUrl: 'https://agents.example.com/s' }]));
  assertError(doc([{ id: 'studio', status: 'busy', sessionUrl: 'https://agents.example.com/s' }]), /status: must be one of: running, queued, waiting, offline/);
});

test('validates provider, model, branch, handoff and timestamps', () => {
  assertError(doc([{ id: 'studio', provider: 'acme' }]), /provider: must be one of: claude, codex, other/);
  assert.equal(valid(doc([{ id: 'studio', provider: null }])).agentSlots[0].provider, null);
  assert.equal(valid(doc([{ id: 'studio', provider: 'codex' }])).agentSlots[0].provider, 'codex');
  assertError(doc([{ id: 'studio', model: 'm'.repeat(81) }]), /model: must be at most 80 characters/);
  for (const branch of ['feature/signup-form', 'release-1.2', 'fix_x', 'a/b/c', 'main']) {
    assert.equal(Core.isValidBranchName(branch), true, branch);
    assert.equal(valid(doc([{ id: 'studio', branch }])).agentSlots[0].branch, branch);
  }
  for (const branch of ['-x', 'a..b', 'a b', 'x.lock', 'a//b', '/a', 'a/', '.hidden', 'a/.b', 'a@{1}', 'a~1', 'a^', 'a:b', 'end.']) {
    assert.equal(Core.isValidBranchName(branch), false, branch);
    assertError(doc([{ id: 'studio', branch }]), /branch: is not a valid git branch name/);
  }
  valid(doc([{ id: 'studio', handoff: 'h'.repeat(Core.LIMITS.handoff) }]));
  assertError(doc([{ id: 'studio', handoff: 'h'.repeat(Core.LIMITS.handoff + 1) }]), /handoff: must be at most 10000 characters/);
  assertError(doc([{ id: 'studio', handoff: 'bad\u0000byte' }]), /handoff: contains control characters/);
  assertError(doc([{ id: 'studio', verifiedAt: '2026-06-16T12:00:00Z' }]), /agentSlots\[0\]\.verifiedAt: must not be in the future/);
  assertError(doc([{ id: 'studio', handoffUpdatedAt: 'yesterday' }]), /handoffUpdatedAt: must be an ISO 8601 timestamp/);
});

test('slot milestones are validated and counted with the project eligibility rule', () => {
  const evidence = [{ label: 'E', url: 'https://example.com/e' }];
  const data = valid(doc([{
    id: 'hackathon',
    milestones: [
      { id: 'h1', title: 'Demo recorded', weight: 40, status: 'complete', verifiedAt: hoursAgo(1), evidence },
      { id: 'h2', title: 'Judging feedback', weight: 30, status: 'untested', verifiedAt: hoursAgo(1), evidence },
      { id: 'h3', title: 'Slides', weight: 30, status: 'blocked', verifiedAt: hoursAgo(1), evidence },
    ],
  }]));
  const view = Core.agentSlotView(data.agentSlots[3], NOW);
  assert.equal(view.progress.numeratorText, '40');
  assert.equal(view.progress.denominatorText, '100');
  assert.equal(view.progress.percent, 40);
  assert.deepEqual(view.progress.milestones.map((m) => m.reason), ['counted', 'untested', 'blocked']);
  assertError(doc([{ id: 'studio', milestones: [{ id: 'm', title: 'M', weight: 0, status: 'complete' }] }]),
    /\$\.agentSlots\[0\]\.milestones\[0\]\.weight: must be greater than 0/);
  assertError(doc([{ id: 'studio', milestones: [{ id: 'm', title: 'M', weight: 1, status: 'complete' }, { id: 'm', title: 'N', weight: 1, status: 'complete' }] }]),
    /agentSlots\[0\]\.milestones\[1\]\.id: duplicate id "m"/);
});

test('slot view reports staleness honestly and never claims a live connection', () => {
  const bound = { sessionUrl: 'https://agents.example.com/s', milestones: [] };
  const view = (slot) => Core.agentSlotView(slot, NOW);
  const stale = view({ ...bound, status: 'running', verifiedAt: hoursAgo(25) });
  assert.equal(stale.stale, true);
  assert.match(stale.freshness, /may be out of date/);
  assert.equal(view({ ...bound, status: 'waiting', verifiedAt: hoursAgo(23) }).stale, false);
  assert.equal(view({ ...bound, status: 'offline', verifiedAt: hoursAgo(500) }).stale, false);
  const never = view({ ...bound, status: 'running', verifiedAt: null });
  assert.equal(never.freshness, 'Recorded status has never been checked against the session');
  assert.equal(never.connection, 'Session link recorded manually (not monitored)');
  for (const v of [stale, never]) assert.doesNotMatch(v.connection, /(^|[^n] )connected/i);
  assert.equal(view({ sessionUrl: null, status: 'queued', verifiedAt: null, milestones: [] }).connection, 'No session connected');
});

test('slots round-trip through export, import and the storage adapter', async () => {
  const original = valid(Sample.buildSampleDocument(NOW));
  const text = Core.serializeDocument(original, NOW);
  assert.match(text, /"agentSlots"/);
  const again = Core.parseDocumentText(text, { now: NOW });
  assert.equal(again.ok, true);
  assert.deepEqual(again.data.agentSlots, original.agentSlots);
  const store = new Map();
  const adapter = new Storage.LocalStorageAdapter({
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  });
  await adapter.save(text);
  const loaded = Core.parseDocumentText(await adapter.load(), { now: NOW, futureCheck: false });
  assert.deepEqual(loaded.data.agentSlots, original.agentSlots);
});

test('sample slots are fictional placeholders', () => {
  const sample = Sample.buildSampleDocument(NOW);
  assert.deepEqual(sample.agentSlots.map((s) => s.id), SLOT_IDS);
  for (const slot of sample.agentSlots) {
    if (slot.sessionUrl) assert.match(new URL(slot.sessionUrl).hostname, /(^|\.)example\.(com|org)$/);
    assert.match(slot.model, /^(placeholder-[a-z0-9-]+)?$/);
    for (const m of slot.milestones) {
      for (const e of m.evidence) assert.match(new URL(e.url).hostname, /(^|\.)example\.(com|org)$/);
    }
  }
  assert.ok(sample.agentSlots.some((s) => !s.sessionUrl), 'at least one unbound slot');
});
