# Data format (schema version 1)

Project Cockpit imports and exports one JSON document. Validation lives in `validateDocument` in [`src/core.js`](../src/core.js); this page describes the same rules.

```json
{
  "schema": "project-cockpit",
  "version": 1,
  "exportedAt": "2026-10-01T12:00:00.000Z",
  "projects": [ ]
}
```

| Field | Type | Rules |
| --- | --- | --- |
| `schema` | string | Required. Must be `"project-cockpit"`. |
| `version` | number | Required. Must be `1`. |
| `exportedAt` | timestamp | Optional. Written on export, ignored on import. |
| `projects` | array | Required. Up to 200 projects. |
| `agentSlots` | AgentSlot[] | Optional. Up to 5, one per slot id. Missing slots are filled with empty defaults, and slots are always returned in the order studio, security, research, hackathon, qa. |

Unknown fields anywhere are reported as warnings and dropped; they never block an import.

## Common rules

- **id:** 1 to 64 characters: letters, digits, `-` and `_`, starting with a letter or digit. Unique within its list (project ids across the document; milestone, blocker, action and decision ids within their project).
- **Short text** (names, titles, owners, labels, options): up to 120 characters. **Long text** (summaries, notes, descriptions, questions, context, decisions): up to 2,000. Text is trimmed. Control characters other than tab and newline are rejected.
- **Dates** (`startDate`, `dueDate`, `since`, `neededBy`): real calendar dates as `YYYY-MM-DD`, or `null`.
- **Timestamps** (`updatedAt`, `verifiedAt`, `decidedAt`): ISO 8601 with a time zone, for example `2026-01-31T09:30:00Z`, or `null`. `verifiedAt` may not be in the future (5 minutes of clock skew is allowed).
- The whole file may be at most 2 MiB, measured in UTF-8 bytes, checked before parsing.

## Project

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required. |
| `name` | short text | Required, not empty. |
| `summary`, `owner` | text | Optional. |
| `status` | enum | Required: `planned`, `active`, `blocked`, `on_hold`, `done`. |
| `priority` | enum | Optional, default `medium`: `high`, `medium`, `low`. |
| `tags` | string[] | Optional. Up to 20, each up to 40 characters, lower-cased and de-duplicated. |
| `startDate`, `dueDate` | date | Optional. A due date before the start date is a warning. |
| `updatedAt` | timestamp | Optional. Set by the app on every change. |
| `milestones` | Milestone[] | Optional. Up to 100. |
| `blockers` | Blocker[] | Optional. Up to 200. |
| `nextActions` | NextAction[] | Optional. Up to 200. |
| `decisions` | Decision[] | Optional. Up to 200. |

## Milestone

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required. |
| `title` | short text | Required. |
| `weight` | number | Required. Greater than 0, at most 1000, at most 2 decimal places. |
| `status` | enum | Required: `not_started`, `in_progress`, `blocked`, `untested`, `complete`. |
| `dueDate` | date | Optional. |
| `verifiedAt` | timestamp | Optional. When someone last checked the evidence. |
| `evidence` | Evidence[] | Optional. Up to 20. |
| `notes` | long text | Optional. |

**Evidence:** `{ "label": "Test report", "url": "https://example.com/report" }`. `url` must be an absolute `http:` or `https:` URL without a username or password, at most 2,048 characters. A missing label defaults to the link's host name.

A milestone counts toward completion only when it is `complete`, has `verifiedAt`, has at least one evidence link and has no open blocker linked to it. See the README for the formula and the confidence rules.

## Blocker

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required. |
| `description` | long text | Required. |
| `owner` | short text | Optional. |
| `since` | date | Optional. |
| `milestoneId` | id or null | Optional. Must match a milestone in the same project. While the blocker is open, that milestone cannot count as complete. |
| `resolved` | boolean | Optional, default `false`. |

## Next action

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required. |
| `text` | long text | Required. |
| `owner` | short text | Optional. |
| `dueDate` | date | Optional. |
| `done` | boolean | Optional, default `false`. |

## Decision

| Field | Type | Rules |
| --- | --- | --- |
| `id` | id | Required. |
| `question` | long text | Required. |
| `context` | long text | Optional. |
| `options` | string[] | Optional. Up to 10 short strings. |
| `status` | enum | Optional, default `open`: `open`, `decided`, `deferred`. |
| `decision` | long text | Required when `status` is `decided`. |
| `neededBy` | date | Optional. |
| `decidedAt` | timestamp | Optional. Set by the app when a decision is recorded. |

## Agent slot

A record of an externally managed agent session. Project Cockpit never contacts the session; every field is entered by a person.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | enum | Required: `studio`, `security`, `research`, `hackathon`, `qa`. Unique. |
| `name` | string | Optional and ignored: names are fixed by id (Studio, Security, Research, Hackathon, QA). |
| `sessionUrl` | string or null | Optional. Absolute `https://` URL, no username or password, at most 2,048 characters, and no query or fragment parameter whose name looks like a secret (`token`, `access_token`, `api_key`, `apiKey`, `key`, `sig`, `signature`, `code`, `password`, `secret`, `auth`, `credential` and `*_`/`*-` variants). |
| `provider` | enum or null | Optional: `claude`, `codex`, `other`. |
| `model` | string | Optional. Up to 80 characters. |
| `branch` | string | Optional. Letters, digits, `.`, `_`, `-` and `/`; no leading `-` or `/`, no `..` or `//`, no trailing `/`, `.` or `.lock`, no path part starting with `.`. Up to 200 characters. |
| `status` | enum | Optional, default `offline`: `running`, `queued`, `waiting`, `offline`. Without a `sessionUrl` only `queued` or `offline` are allowed. |
| `statusNote` | short text | Optional. |
| `verifiedAt` | timestamp | Optional. When someone last checked the recorded status against the session. Not in the future. |
| `milestones` | Milestone[] | Optional. Up to 50, same rules and same counting rule as project milestones. |
| `handoff` | text | Optional. Up to 10,000 characters. Never put secrets here: it is exported with everything else. |
| `handoffUpdatedAt` | timestamp | Optional. Set by the app when the handoff text changes. |
| `updatedAt` | timestamp | Optional. Set by the app on every change. |

## Error reporting

Errors carry a JSON path such as `$.projects[2].milestones[0].weight` and a message. The first 50 are reported. An import with any error changes nothing.
