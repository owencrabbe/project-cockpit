/*
 * Project Cockpit storage adapters.
 *
 * Adapter contract (see docs/STORAGE.md):
 *   name                          short label shown in the UI
 *   isAvailable(): boolean        whether the backing store works right now
 *   load(): Promise<string|null>  the saved document as JSON text, or null
 *   save(text): Promise<void>     persist JSON text; reject on failure
 *   clear(): Promise<void>        remove the saved document
 *   subscribe(fn): () => void     optional; call fn() when another tab or
 *                                 process changed the data. Returns unsubscribe.
 *
 * Adapters move opaque JSON text only. The app validates everything it loads
 * with the same schema checks used for imports, so an adapter never has to.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CockpitStorage = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_KEY = 'project-cockpit:v1';

  class StorageError extends Error {
    constructor(message, cause) {
      super(message);
      this.name = 'StorageError';
      this.cause = cause;
    }
  }

  function isQuotaError(err) {
    return Boolean(err) && (err.name === 'QuotaExceededError'
      || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || err.code === 22 || err.code === 1014);
  }

  /** Persists to window.localStorage (or any object with the Web Storage API). */
  class LocalStorageAdapter {
    constructor(options) {
      const opts = options || {};
      this.key = opts.key || DEFAULT_KEY;
      this.name = 'This browser (localStorage)';
      this._storage = opts.storage;
      this._window = opts.window || (typeof window !== 'undefined' ? window : null);
    }

    _store() {
      if (this._storage) return this._storage;
      // Accessing window.localStorage itself can throw when storage is blocked.
      return this._window ? this._window.localStorage : null;
    }

    isAvailable() {
      try {
        const store = this._store();
        if (!store) return false;
        const probe = `${this.key}:probe`;
        store.setItem(probe, '1');
        store.removeItem(probe);
        return true;
      } catch (err) {
        return false;
      }
    }

    async load() {
      try {
        const store = this._store();
        return store ? store.getItem(this.key) : null;
      } catch (err) {
        throw new StorageError('Could not read saved data from this browser.', err);
      }
    }

    async save(text) {
      if (typeof text !== 'string') throw new StorageError('Only JSON text can be saved.');
      let store;
      try {
        store = this._store();
      } catch (err) {
        throw new StorageError('Browser storage is blocked, so changes cannot be saved.', err);
      }
      if (!store) throw new StorageError('Browser storage is not available.');
      try {
        store.setItem(this.key, text);
      } catch (err) {
        if (isQuotaError(err)) {
          throw new StorageError('Browser storage is full. Export your data, then remove unused projects.', err);
        }
        throw new StorageError('Browser storage refused the save.', err);
      }
    }

    async clear() {
      try {
        const store = this._store();
        if (store) store.removeItem(this.key);
      } catch (err) {
        throw new StorageError('Could not clear saved data.', err);
      }
    }

    subscribe(callback) {
      const win = this._window;
      if (!win || typeof win.addEventListener !== 'function') return () => {};
      const handler = (event) => {
        if (event.key === this.key || event.key === null) callback();
      };
      win.addEventListener('storage', handler);
      return () => win.removeEventListener('storage', handler);
    }
  }

  /** Keeps data in memory only. Used for tests and when browser storage is blocked. */
  class MemoryAdapter {
    constructor(initialText) {
      this.name = 'Memory only (not saved)';
      this._text = typeof initialText === 'string' ? initialText : null;
    }

    isAvailable() {
      return true;
    }

    async load() {
      return this._text;
    }

    async save(text) {
      if (typeof text !== 'string') throw new StorageError('Only JSON text can be saved.');
      this._text = text;
    }

    async clear() {
      this._text = null;
    }

    subscribe() {
      return () => {};
    }
  }

  /** Picks localStorage when it works, otherwise an in-memory fallback. */
  function createDefaultAdapter(options) {
    const local = new LocalStorageAdapter(options);
    if (local.isAvailable()) return { adapter: local, durable: true };
    return { adapter: new MemoryAdapter(), durable: false };
  }

  function assertAdapter(adapter) {
    const missing = ['isAvailable', 'load', 'save', 'clear'].filter((m) => typeof adapter[m] !== 'function');
    if (missing.length) throw new TypeError(`Storage adapter is missing: ${missing.join(', ')}`);
    return adapter;
  }

  return Object.freeze({
    DEFAULT_KEY,
    StorageError,
    LocalStorageAdapter,
    MemoryAdapter,
    createDefaultAdapter,
    assertAdapter,
  });
});
