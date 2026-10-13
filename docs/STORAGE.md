# Storage adapters

Project Cockpit keeps one JSON document. Where that document lives is decided by a storage adapter, a small object the app calls through a fixed contract. The built-in default is the browser's `localStorage`.

## Contract

```js
const adapter = {
  name: 'Shown in the page footer',
  isAvailable() { return true; },          // can the backing store be used right now?
  async load() { return textOrNull; },     // the saved document as JSON text, or null if none
  async save(text) { /* persist */ },      // reject (throw) if the save did not happen
  async clear() { /* remove */ },
  subscribe(onChange) {                    // optional: call onChange() when data changed elsewhere
    return () => { /* unsubscribe */ };
  },
};
```

Rules the app relies on:

- Adapters move **opaque JSON text**. They do not need to understand or validate the schema. The app validates everything returned by `load()` with the same checks used for imports and never overwrites data that fails validation; it shows a recovery notice instead.
- `save()` must reject when data was not stored. The app then shows "Your last change was not saved" with the reason (use a `StorageError` from `src/storage.js` for a clear message).
- Saves are issued in order, one after another, so an asynchronous adapter never sees overlapping writes from one tab.
- Every document the app saves is under the 2 MiB import limit, so whatever an adapter stores can always be exported and re-imported.

## Built-in adapters (`src/storage.js`)

| Adapter | Use |
| --- | --- |
| `LocalStorageAdapter({ key, storage, window })` | Default. Key `project-cockpit:v1`. Detects blocked storage, reports quota errors clearly, and syncs between tabs via the `storage` event. |
| `MemoryAdapter(initialText)` | Keeps data for the current tab only. Used automatically when browser storage is blocked, and in tests. |
| `createDefaultAdapter()` | Returns `{ adapter, durable }`: localStorage when it works, otherwise memory with `durable: false`, which makes the app show a warning. |

## Using your own adapter

1. Create a script in `src/`, for example `src/my-adapter.js`, that sets a global config:

   ```js
   window.CockpitConfig = { storageAdapter: new MyAdapter(), durable: true };
   ```

2. Load it in `index.html` **before** `src/app.js`:

   ```html
   <script src="src/my-adapter.js"></script>
   <script src="src/app.js"></script>
   ```

The page's Content Security Policy only allows scripts from the same origin, so keep the file next to the others. Inline scripts are blocked on purpose.

### Example: IndexedDB

IndexedDB holds much more than `localStorage` and works with the existing CSP.

```js
// src/indexeddb-adapter.js
(function () {
  'use strict';
  const DB = 'project-cockpit';
  const STORE = 'documents';
  const KEY = 'current';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function run(mode, action) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  window.CockpitConfig = {
    storageAdapter: {
      name: 'This browser (IndexedDB)',
      isAvailable: () => typeof indexedDB !== 'undefined',
      load: () => run('readonly', (s) => s.get(KEY)).then((v) => (typeof v === 'string' ? v : null)),
      save: (text) => run('readwrite', (s) => s.put(text, KEY)).then(() => undefined),
      clear: () => run('readwrite', (s) => s.delete(KEY)).then(() => undefined),
    },
  };
}());
```

### Example: your own private server

An adapter can `fetch()` from a server you control. Two things to change:

- Add that origin to the CSP in `index.html`, for example `connect-src https://cockpit.internal.example`. The default policy blocks every network request.
- Handle authentication on that server. Project Cockpit has no accounts and never stores credentials, so do not put tokens in the page source.

```js
window.CockpitConfig = {
  storageAdapter: {
    name: 'Team server',
    isAvailable: () => true,
    async load() {
      const res = await fetch('https://cockpit.internal.example/document', { credentials: 'include' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      return res.text();
    },
    async save(text) {
      const res = await fetch('https://cockpit.internal.example/document', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: text,
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
    },
    async clear() {
      await fetch('https://cockpit.internal.example/document', { method: 'DELETE', credentials: 'include' });
    },
  },
};
```

Project Cockpit ships no server. This example only shows the shape an adapter would take.
