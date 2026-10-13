'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../src/storage.js');
const Core = require('../../src/core.js');
const Sample = require('../../src/sample-data.js');

class FakeStorage {
  constructor(opts) {
    this.map = new Map();
    this.quota = (opts && opts.quota) || Infinity;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    const used = Array.from(this.map.entries()).filter(([k]) => k !== key).reduce((n, [, v]) => n + v.length, 0);
    if (used + String(value).length > this.quota) {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

class FakeWindow {
  constructor(storage) {
    this.listeners = [];
    this._storage = storage;
  }

  get localStorage() {
    if (this._storage === 'blocked') {
      const err = new Error('The operation is insecure.');
      err.name = 'SecurityError';
      throw err;
    }
    return this._storage;
  }

  addEventListener(type, fn) {
    if (type === 'storage') this.listeners.push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  fire(key) {
    this.listeners.forEach((fn) => fn({ key }));
  }
}

const NOW = new Date('2026-06-15T12:00:00Z');
const sampleText = Core.serializeDocument(Core.validateDocument(Sample.buildSampleDocument(NOW), { now: NOW }).data, NOW);

test('MemoryAdapter round-trips and clears', async () => {
  const adapter = Storage.assertAdapter(new Storage.MemoryAdapter());
  assert.equal(await adapter.load(), null);
  await adapter.save(sampleText);
  assert.equal(await adapter.load(), sampleText);
  await adapter.clear();
  assert.equal(await adapter.load(), null);
  await assert.rejects(adapter.save({ not: 'text' }), Storage.StorageError);
});

test('LocalStorageAdapter round-trips saved documents through validation', async () => {
  const store = new FakeStorage();
  const adapter = new Storage.LocalStorageAdapter({ storage: store });
  assert.equal(adapter.isAvailable(), true);
  await adapter.save(sampleText);
  assert.equal(store.getItem(Storage.DEFAULT_KEY), sampleText);
  const loaded = Core.parseDocumentText(await adapter.load(), { now: NOW });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.projects.length, 5);
  assert.equal(store.map.size, 1, 'availability probe leaves no keys behind');
});

test('LocalStorageAdapter keys are isolated', async () => {
  const store = new FakeStorage();
  const a = new Storage.LocalStorageAdapter({ storage: store, key: 'cockpit:a' });
  const b = new Storage.LocalStorageAdapter({ storage: store, key: 'cockpit:b' });
  await a.save('{"a":1}');
  assert.equal(await b.load(), null);
  await b.clear();
  assert.equal(await a.load(), '{"a":1}');
});

test('quota errors surface as a clear StorageError and keep the previous save', async () => {
  const store = new FakeStorage({ quota: 50 });
  const adapter = new Storage.LocalStorageAdapter({ storage: store });
  await adapter.save('{"ok":true}');
  await assert.rejects(adapter.save('x'.repeat(100)), (err) => {
    assert.equal(err.name, 'StorageError');
    assert.match(err.message, /storage is full/);
    return true;
  });
  assert.equal(await adapter.load(), '{"ok":true}');
});

test('blocked storage falls back to memory and reports non-durable', async () => {
  const win = new FakeWindow('blocked');
  const local = new Storage.LocalStorageAdapter({ window: win });
  assert.equal(local.isAvailable(), false);
  await assert.rejects(local.save('{}'), Storage.StorageError);
  const picked = Storage.createDefaultAdapter({ window: win });
  assert.equal(picked.durable, false);
  assert.ok(picked.adapter instanceof Storage.MemoryAdapter);
  const working = Storage.createDefaultAdapter({ window: new FakeWindow(new FakeStorage()) });
  assert.equal(working.durable, true);
  assert.ok(working.adapter instanceof Storage.LocalStorageAdapter);
});

test('subscribe fires only for this key (or a full clear) and can unsubscribe', () => {
  const win = new FakeWindow(new FakeStorage());
  const adapter = new Storage.LocalStorageAdapter({ window: win });
  let calls = 0;
  const off = adapter.subscribe(() => { calls += 1; });
  win.fire('some-other-key');
  win.fire(Storage.DEFAULT_KEY);
  win.fire(null);
  assert.equal(calls, 2);
  off();
  win.fire(Storage.DEFAULT_KEY);
  assert.equal(calls, 2);
});

test('assertAdapter rejects incomplete adapters', () => {
  assert.throws(() => Storage.assertAdapter({ load() {}, save() {} }), /missing: isAvailable, clear/);
});

test('a corrupted saved value is detected, not silently replaced', () => {
  const result = Core.parseDocumentText('{"schema":"project-cockpit","version":1,"projects":[{"id":"p"}', { now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /not valid JSON/);
});
