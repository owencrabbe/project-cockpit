# Project Cockpit

A local-first project dashboard that reports progress only from verified evidence. It is a static site: three script files, one stylesheet, no build step, no backend, no tracking. Your data stays in your browser until you export it.

Everything in this repository (sample projects, people, teams and links) is fictional. Evidence links in the examples point at the reserved `example.com` and `example.org` domains.

## What it does

- **Projects:** list with search, status, priority, tag and "needs attention" filters, plus sorting by next deadline, progress, name or last update. Filters live in the URL, so a filtered view can be bookmarked.
- **Project detail:** weighted milestones with evidence links, blockers, next actions and decisions, each with add, edit and delete.
- **Evidence-based progress:** completion shown as `numerator / denominator` of milestone weight, a percentage, a confidence rating with its reasons, and the last verification time.
- **Timeline:** every open dated item across projects (milestones, next actions, decisions, project due dates), grouped into Overdue, Next 7 days, 8 to 30 days and Later.
- **Decisions:** questions waiting on you across all projects. Recording a decision keeps the choice, rationale and timestamp.
- **JSON import and export** with strict validation, and durable local storage behind a small, documented storage adapter interface.

## How completion is calculated

```
completion = sum(weight of eligible milestones) / sum(weight of all milestones)
```

A milestone is **eligible** only when all of these hold:

1. its status is `complete`,
2. it has a verification timestamp (`verifiedAt`),
3. it has at least one `http://` or `https://` evidence link, and
4. no open blocker is linked to it.

`blocked` and `untested` milestones never count, whatever else is true. Weights are summed as integer hundredths, so `0.1 + 0.2` is exactly `0.3`, and the percentage is rounded **down** so progress is never overstated (2 of 3 equal milestones shows 66%, not 67%). A project with no milestones shows "Not measurable" instead of 0%.

In the editor, changing a milestone's status to Complete clears any older verification unless you tick "Record verification now" in the same save. "Verify now" asks for confirmation because it records that you checked the evidence.

**Confidence** rates how far the completion figure can be relied on right now:

| Level | When |
| --- | --- |
| Low | A milestone says Complete but does not count (unverified, no evidence, or an open linked blocker), or a counted milestone was last verified more than 30 days ago. |
| Medium | A counted milestone was verified 15 to 30 days ago, or there are untested or blocked milestones, open blockers, or overdue milestones. |
| High | None of the above. |
| Not measurable | No weighted milestones. |

Cards show the level; the project page lists the specific reasons, so a rating is never a black box. The rules live in `computeProgress` and `computeConfidence` in [`src/core.js`](src/core.js).

## Run it

You need nothing beyond a modern browser.

- **Open the file directly:** double-click `index.html`. Tested in Chromium-based browsers. If your browser restricts pages opened from disk, use the next option.
- **Local server:** `npm start` (Node 18+, no dependencies needed) serves the folder at `http://127.0.0.1:8080/`.
- **Private hosting:** copy `index.html`, `src/` and `styles/` to any static web server or internal file host and put it behind whatever access control you already use. There is nothing to configure and no server code to run.

On first run the dashboard is empty. Choose **New project**, **Import JSON** or **Load sample data** (fictional).

## Data, privacy and limits

- Data is saved to `localStorage` under the key `project-cockpit:v1` after every change. If browser storage is blocked (some private windows), the app says so and keeps data in memory for that tab only.
- Changes made in another tab of the same browser appear automatically.
- If saved data ever fails validation, the app does not overwrite it. It shows the problem and offers to download the raw data or discard it.
- The page sends no network requests. The Content Security Policy sets `default-src 'none'`, so it cannot.
- Limits: 2 MiB per document, 200 projects, 100 milestones per project, 20 evidence links per milestone, 200 blockers, actions or decisions per project. Every saved state stays under the import limit, so any export can be re-imported.

The JSON format is documented in [`docs/DATA-FORMAT.md`](docs/DATA-FORMAT.md). [`examples/minimal.json`](examples/minimal.json) is a small template; [`examples/sample-cockpit.json`](examples/sample-cockpit.json) is the full fictional sample at a fixed date.

## Storage adapters

Storage is pluggable. An adapter is any object with `isAvailable()`, `load()`, `save(text)` and `clear()` (plus optional `subscribe()`), moving JSON text only. The app validates everything it loads, so adapters stay simple. Built in: `LocalStorageAdapter` and `MemoryAdapter`. To use your own, load a script before `src/app.js` that sets `window.CockpitConfig = { storageAdapter: yourAdapter }`. Details and an IndexedDB example: [`docs/STORAGE.md`](docs/STORAGE.md).

## Security model

- **No HTML parsing of data.** All user text is rendered with `textContent` and text nodes through one small DOM helper. A unit test fails the build if `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function` appear in the source.
- **Links:** evidence URLs must be absolute `http:` or `https:` URLs without embedded credentials. `javascript:`, `data:`, `file:`, relative and protocol-relative URLs are rejected on import and in the editor. Links open in a new tab with `rel="noopener noreferrer"` and no referrer.
- **Strict CSP:** `default-src 'none'; script-src 'self'; style-src 'self'`, no inline scripts, styles or handlers.
- **Import validation:** size checked before parsing (UTF-8 bytes), JSON parsed in a guarded step, then a strict schema check: required fields, types, enums, real calendar dates, ISO timestamps, weight range and precision, unique ids, linked-milestone references, length and count limits, and control characters. Unknown fields are reported as warnings and dropped. Verification times in the future are rejected. Imports replace data only after you confirm.

## Accessibility

Keyboard operable throughout, with a skip link, visible focus, focus moved to the page heading on navigation, native modal dialogs that return focus to the control that opened them, labelled form fields with announced error summaries, a polite live region for status changes, and text labels on every colored status. Touch targets are at least 44 px for buttons and form controls. Light and dark themes follow the system setting. Layout reflows to 320 px wide without horizontal scrolling.

## Development

```sh
npm install          # test tooling only: Playwright and axe-core
npm test             # unit tests, then browser tests
npm run test:unit    # node --test, no browser needed
npm run test:e2e     # Playwright: mobile (Pixel 7) and desktop Chromium
npm run build:example  # regenerate examples/sample-cockpit.json
npm run zip          # dist/project-cockpit-<version>.zip from the committed tree
```

If Playwright's Chromium is not installed yet, run `npx playwright install chromium` once.

A GitHub Actions workflow that runs both suites is included as [`docs/ci/test.yml`](docs/ci/test.yml). To enable it, copy it to `.github/workflows/test.yml`.

| Test file | Covers |
| --- | --- |
| `tests/unit/progress.test.js` | Hand-computed progress fixture (`tests/fixtures/progress-fixture.json`): numerators, denominators, percentages, eligibility reasons, confidence and last-verified time; a seeded randomized check that blocked or untested milestones never count; timeline and filters. |
| `tests/unit/import-validation.test.js` | Size limits, malformed JSON, schema and version, weights, statuses, dates and timestamps, duplicates, references, limits, unknown fields, round-trip export and import. |
| `tests/unit/security.test.js` | URL allow-list, unsafe evidence on import, prototype pollution, forbidden DOM sinks, CSP and inline-script checks, fictional-only sample links. |
| `tests/unit/storage.test.js` | Adapters: round-trip, key isolation, quota errors, blocked storage fallback, cross-tab events. |
| `tests/e2e/mobile-a11y.spec.js` | axe-core WCAG 2.2 AA and best-practice scans of every view and dialog in light and dark mode, 320 px reflow, touch target sizes, landmarks, keyboard and focus behavior, error announcements. |
| `tests/e2e/progress-ui.spec.js` | The same fixture through the real UI with a frozen clock, verification and status-change rules, blocker resolution. |
| `tests/e2e/security.spec.js` | Script payloads render as inert text, unsafe and oversized imports rejected without changes, link attributes, persistence, cross-tab sync, corrupted-storage recovery, export, custom adapter, `file://` use. |

## What it deliberately does not do

No accounts, server, database, analytics or third-party requests. No integrations with other tools, and no automated or agent-run actions: every status, verification and decision is something a person recorded. Progress is never inferred from anything other than the milestone records you enter.

## License

[MIT](LICENSE). Project Cockpit is an independent open-source project. It is not affiliated with, endorsed by or sponsored by OpenAI or any other company.
