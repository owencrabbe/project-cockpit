/*
 * Project Cockpit core: schema validation, weighted progress, confidence,
 * timeline and filtering. Pure functions only (no DOM, no storage), so the
 * same file runs in the browser (as window.CockpitCore) and in Node tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CockpitCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_ID = 'project-cockpit';
  const SCHEMA_VERSION = 1;

  const LIMITS = Object.freeze({
    importBytes: 2 * 1024 * 1024,
    projects: 200,
    milestones: 100,
    evidence: 20,
    listItems: 200,
    tags: 20,
    options: 10,
    idLength: 64,
    shortText: 120,
    longText: 2000,
    urlLength: 2048,
    weightMax: 1000,
    errorsReported: 50,
    slotMilestones: 50,
    handoff: 10000,
    model: 80,
    branch: 200,
  });

  const PROJECT_STATUSES = Object.freeze(['planned', 'active', 'blocked', 'on_hold', 'done']);
  const MILESTONE_STATUSES = Object.freeze(['not_started', 'in_progress', 'blocked', 'untested', 'complete']);
  const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
  const DECISION_STATUSES = Object.freeze(['open', 'decided', 'deferred']);

  // Agent slots are user-maintained records of externally managed sessions.
  // Nothing here connects to, starts or monitors a session.
  const AGENT_SLOTS = Object.freeze([
    Object.freeze({ id: 'studio', name: 'Studio' }),
    Object.freeze({ id: 'security', name: 'Security' }),
    Object.freeze({ id: 'research', name: 'Research' }),
    Object.freeze({ id: 'hackathon', name: 'Hackathon' }),
    Object.freeze({ id: 'qa', name: 'QA' }),
  ]);
  const AGENT_STATUSES = Object.freeze(['running', 'queued', 'waiting', 'offline']);
  const UNBOUND_AGENT_STATUSES = Object.freeze(['queued', 'offline']);
  const AGENT_PROVIDERS = Object.freeze(['claude', 'codex', 'other']);
  // A recorded "running" or "waiting" status older than this is flagged as possibly out of date.
  const STATUS_STALE_HOURS = 24;
  const SECRET_PARAM = /^(?:.*[_-])?(?:token|secret|password|passwd|pwd|auth|authorization|apikey|api[_-]?key|key|sig|signature|code|credentials?)$/i;

  const LABELS = Object.freeze({
    planned: 'Planned',
    active: 'Active',
    blocked: 'Blocked',
    on_hold: 'On hold',
    done: 'Done',
    not_started: 'Not started',
    in_progress: 'In progress',
    untested: 'Untested',
    complete: 'Complete',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    open: 'Open',
    decided: 'Decided',
    deferred: 'Deferred',
    running: 'Running',
    queued: 'Queued',
    waiting: 'Waiting',
    offline: 'Offline',
    claude: 'Claude',
    codex: 'Codex',
    other: 'Other',
  });

  // A counted milestone verified within FRESH_DAYS keeps confidence high;
  // older than STALE_DAYS drops it to low.
  const FRESH_DAYS = 14;
  const STALE_DAYS = 30;
  const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const ELIGIBILITY = Object.freeze({
    counted: 'Counted: complete, verified and backed by evidence',
    not_complete: 'Not complete yet',
    blocked: 'Blocked: never counts as complete',
    untested: 'Untested: never counts as complete',
    open_blocker: 'Marked complete, but an open blocker is linked to it',
    unverified: 'Marked complete, but not verified',
    no_evidence: 'Marked complete, but has no http(s) evidence link',
  });
  const UNPROVEN_REASONS = ['open_blocker', 'unverified', 'no_evidence'];

  const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
  // C0 controls except tab, newline and carriage return, plus DEL.
  const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

  const KEYS = Object.freeze({
    document: ['schema', 'version', 'exportedAt', 'projects', 'agentSlots'],
    agentSlot: ['id', 'name', 'sessionUrl', 'provider', 'model', 'branch', 'status', 'statusNote', 'verifiedAt',
      'milestones', 'handoff', 'handoffUpdatedAt', 'updatedAt'],
    project: ['id', 'name', 'summary', 'owner', 'status', 'priority', 'tags', 'startDate', 'dueDate',
      'updatedAt', 'milestones', 'blockers', 'nextActions', 'decisions'],
    milestone: ['id', 'title', 'weight', 'status', 'dueDate', 'verifiedAt', 'evidence', 'notes'],
    evidence: ['label', 'url'],
    blocker: ['id', 'description', 'owner', 'since', 'milestoneId', 'resolved'],
    nextAction: ['id', 'text', 'owner', 'dueDate', 'done'],
    decision: ['id', 'question', 'context', 'options', 'status', 'decision', 'neededBy', 'decidedAt'],
  });

  /* ---------- small utilities ---------- */

  function toDate(value) {
    if (value instanceof Date) return value;
    if (value === undefined || value === null) return new Date();
    return new Date(value);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function own(obj, key) {
    return hasOwn(obj, key) ? obj[key] : undefined;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Local calendar date (YYYY-MM-DD) for a Date. */
  function localDateString(dateInput) {
    const d = toDate(dateInput);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function isValidDateString(value) {
    if (typeof value !== 'string') return false;
    const m = DATE_PATTERN.exec(value);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  }

  function isValidTimestamp(value) {
    return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
  }

  /** Whole calendar days from date string a to date string b. */
  function daysBetweenDates(a, b) {
    const pa = DATE_PATTERN.exec(a);
    const pb = DATE_PATTERN.exec(b);
    const ua = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
    const ub = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
    return Math.round((ub - ua) / DAY_MS);
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function toHundredths(weight) {
    return Math.round(weight * 100);
  }

  /** Formats an amount of weight stored as integer hundredths: 3550 -> "35.5". */
  function formatHundredths(hundredths) {
    return String(Number((hundredths / 100).toFixed(2)));
  }

  function plural(n, word, pluralWord) {
    return `${n} ${n === 1 ? word : (pluralWord || `${word}s`)}`;
  }

  /**
   * Returns a normalized absolute http(s) URL string, or null when the value
   * is not a safe evidence link (other schemes, relative URLs, embedded
   * credentials, whitespace or control characters, or over-long input).
   */
  function safeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > LIMITS.urlLength) return null;
    if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) return null;
    let url;
    try {
      url = new URL(trimmed);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return url.href;
  }

  /**
   * Checks a link to an externally managed agent session. Returns
   * { url, problem }: url is the normalized https URL when acceptable.
   * Links must be https, carry no username/password, and carry no
   * token-like query or fragment parameters (exports are often shared).
   */
  function checkSessionUrl(value) {
    const href = safeHttpUrl(value);
    if (!href || new URL(href).protocol !== 'https:') {
      return { url: null, problem: 'must be an absolute https:// URL without a username or password' };
    }
    const url = new URL(href);
    const names = Array.from(url.searchParams.keys());
    const fragment = url.hash.slice(1);
    if (fragment.includes('=')) names.push(...new URLSearchParams(fragment).keys());
    if (names.some((name) => SECRET_PARAM.test(name))) {
      return { url: null, problem: 'must not include tokens, keys or other secrets in the query or fragment' };
    }
    return { url: href, problem: null };
  }

  /** Conservative subset of git's branch-name rules. */
  function isValidBranchName(name) {
    if (typeof name !== 'string' || !name || name.length > LIMITS.branch) return false;
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
    if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
    if (name.endsWith('.lock') || name.includes('..') || name.includes('//')) return false;
    return !name.split('/').some((part) => part.startsWith('.'));
  }

  function defaultAgentSlot(def) {
    return {
      id: def.id,
      name: def.name,
      sessionUrl: null,
      provider: null,
      model: '',
      branch: '',
      status: 'offline',
      statusNote: '',
      verifiedAt: null,
      milestones: [],
      handoff: '',
      handoffUpdatedAt: null,
      updatedAt: null,
    };
  }

  function defaultAgentSlots() {
    return AGENT_SLOTS.map(defaultAgentSlot);
  }

  function newId(prefix) {
    const bytes = new Uint8Array(8);
    const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      cryptoObj.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}-${hex}`;
  }

  function createEmptyDocument() {
    return { schema: SCHEMA_ID, version: SCHEMA_VERSION, projects: [], agentSlots: defaultAgentSlots() };
  }

  /* ---------- validation ---------- */

  function createContext(now, futureCheck) {
    return { errors: [], warnings: [], truncated: false, nowMs: toDate(now).getTime(), futureCheck };
  }

  function addError(ctx, path, message) {
    if (ctx.errors.length < LIMITS.errorsReported) ctx.errors.push({ path, message });
    else ctx.truncated = true;
  }

  function addWarning(ctx, path, message) {
    if (ctx.warnings.length < LIMITS.errorsReported) ctx.warnings.push({ path, message });
  }

  function checkKeys(ctx, obj, allowed, path) {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        addWarning(ctx, `${path}.${key}`, 'unknown field ignored');
      }
    }
  }

  function readString(ctx, obj, key, path, opts) {
    const options = opts || {};
    const max = options.max || LIMITS.shortText;
    const value = own(obj, key);
    const fieldPath = `${path}.${key}`;
    if (value === undefined || value === null) {
      if (options.required) addError(ctx, fieldPath, 'is required');
      return '';
    }
    if (typeof value !== 'string') {
      addError(ctx, fieldPath, 'must be a string');
      return '';
    }
    const text = value.trim();
    if (options.required && text === '') {
      addError(ctx, fieldPath, 'must not be empty');
      return '';
    }
    if (text.length > max) {
      addError(ctx, fieldPath, `must be at most ${max} characters (got ${text.length})`);
      return '';
    }
    if (CONTROL_CHARS.test(text)) {
      addError(ctx, fieldPath, 'contains control characters');
      return '';
    }
    return text;
  }

  function readId(ctx, obj, path) {
    const value = own(obj, 'id');
    const fieldPath = `${path}.id`;
    if (typeof value !== 'string' || value === '') {
      addError(ctx, fieldPath, 'is required and must be a string');
      return '';
    }
    if (value.length > LIMITS.idLength || !ID_PATTERN.test(value)) {
      addError(ctx, fieldPath, `must be 1-${LIMITS.idLength} letters, digits, "-" or "_"`);
      return '';
    }
    return value;
  }

  function readEnum(ctx, obj, key, path, allowed, fallback) {
    const value = own(obj, key);
    const fieldPath = `${path}.${key}`;
    if (value === undefined || value === null) {
      if (fallback === undefined) {
        addError(ctx, fieldPath, `is required (one of: ${allowed.join(', ')})`);
        return allowed[0];
      }
      return fallback;
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
      addError(ctx, fieldPath, `must be one of: ${allowed.join(', ')}`);
      return fallback === undefined ? allowed[0] : fallback;
    }
    return value;
  }

  function readDate(ctx, obj, key, path) {
    const value = own(obj, key);
    if (value === undefined || value === null || value === '') return null;
    if (!isValidDateString(value)) {
      addError(ctx, `${path}.${key}`, 'must be a calendar date in YYYY-MM-DD format');
      return null;
    }
    return value;
  }

  function readTimestamp(ctx, obj, key, path, opts) {
    const options = opts || {};
    const value = own(obj, key);
    const fieldPath = `${path}.${key}`;
    if (value === undefined || value === null || value === '') return null;
    if (!isValidTimestamp(value)) {
      addError(ctx, fieldPath, 'must be an ISO 8601 timestamp with time zone, e.g. 2026-01-31T09:30:00Z');
      return null;
    }
    const ms = Date.parse(value);
    if (options.notFuture && ctx.futureCheck && ms > ctx.nowMs + FUTURE_TOLERANCE_MS) {
      addError(ctx, fieldPath, 'must not be in the future');
      return null;
    }
    return new Date(ms).toISOString();
  }

  function readBool(ctx, obj, key, path) {
    const value = own(obj, key);
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') {
      addError(ctx, `${path}.${key}`, 'must be true or false');
      return false;
    }
    return value;
  }

  function readWeight(ctx, obj, path) {
    const value = own(obj, 'weight');
    const fieldPath = `${path}.weight`;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      addError(ctx, fieldPath, 'is required and must be a finite number');
      return 0;
    }
    if (value <= 0 || value > LIMITS.weightMax) {
      addError(ctx, fieldPath, `must be greater than 0 and at most ${LIMITS.weightMax}`);
      return 0;
    }
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      addError(ctx, fieldPath, 'must have at most 2 decimal places');
      return 0;
    }
    return value;
  }

  function readArray(ctx, obj, key, path, max, readItem) {
    const value = own(obj, key);
    const fieldPath = `${path}.${key}`;
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      addError(ctx, fieldPath, 'must be an array');
      return [];
    }
    if (value.length > max) {
      addError(ctx, fieldPath, `has ${value.length} items; the limit is ${max}`);
      return [];
    }
    const out = [];
    value.forEach((item, i) => {
      const itemPath = `${fieldPath}[${i}]`;
      const read = readItem(item, itemPath);
      if (read !== undefined) out.push(read);
    });
    return out;
  }

  function readObject(ctx, value, path, keys) {
    if (!isPlainObject(value)) {
      addError(ctx, path, 'must be an object');
      return null;
    }
    checkKeys(ctx, value, keys, path);
    return value;
  }

  function checkUniqueIds(ctx, items, path) {
    const seen = new Set();
    items.forEach((item, i) => {
      if (!item.id) return;
      if (seen.has(item.id)) addError(ctx, `${path}[${i}].id`, `duplicate id "${item.id}"`);
      seen.add(item.id);
    });
  }

  function readEvidence(ctx, raw, path) {
    const obj = readObject(ctx, raw, path, KEYS.evidence);
    if (!obj) return undefined;
    const rawUrl = own(obj, 'url');
    const url = safeHttpUrl(rawUrl);
    if (!url) {
      addError(ctx, `${path}.url`, 'must be an absolute http:// or https:// URL without credentials');
      return undefined;
    }
    let label = readString(ctx, obj, 'label', path, { max: LIMITS.shortText });
    if (!label) label = new URL(url).hostname;
    return { label, url };
  }

  function readMilestone(ctx, raw, path) {
    const obj = readObject(ctx, raw, path, KEYS.milestone);
    if (!obj) return undefined;
    return {
      id: readId(ctx, obj, path),
      title: readString(ctx, obj, 'title', path, { required: true }),
      weight: readWeight(ctx, obj, path),
      status: readEnum(ctx, obj, 'status', path, MILESTONE_STATUSES),
      dueDate: readDate(ctx, obj, 'dueDate', path),
      verifiedAt: readTimestamp(ctx, obj, 'verifiedAt', path, { notFuture: true }),
      evidence: readArray(ctx, obj, 'evidence', path, LIMITS.evidence, (item, p) => readEvidence(ctx, item, p)),
      notes: readString(ctx, obj, 'notes', path, { max: LIMITS.longText }),
    };
  }

  function readBlocker(ctx, raw, path) {
    const obj = readObject(ctx, raw, path, KEYS.blocker);
    if (!obj) return undefined;
    const milestoneId = own(obj, 'milestoneId');
    let linked = null;
    if (milestoneId !== undefined && milestoneId !== null && milestoneId !== '') {
      if (typeof milestoneId !== 'string' || !ID_PATTERN.test(milestoneId) || milestoneId.length > LIMITS.idLength) {
        addError(ctx, `${path}.milestoneId`, 'must be a milestone id');
      } else {
        linked = milestoneId;
      }
    }
    return {
      id: readId(ctx, obj, path),
      description: readString(ctx, obj, 'description', path, { required: true, max: LIMITS.longText }),
      owner: readString(ctx, obj, 'owner', path),
      since: readDate(ctx, obj, 'since', path),
      milestoneId: linked,
      resolved: readBool(ctx, obj, 'resolved', path),
    };
  }

  function readNextAction(ctx, raw, path) {
    const obj = readObject(ctx, raw, path, KEYS.nextAction);
    if (!obj) return undefined;
    return {
      id: readId(ctx, obj, path),
      text: readString(ctx, obj, 'text', path, { required: true, max: LIMITS.longText }),
      owner: readString(ctx, obj, 'owner', path),
      dueDate: readDate(ctx, obj, 'dueDate', path),
      done: readBool(ctx, obj, 'done', path),
    };
  }

  function readDecision(ctx, raw, path) {
    const obj = readObject(ctx, raw, path, KEYS.decision);
    if (!obj) return undefined;
    const decision = {
      id: readId(ctx, obj, path),
      question: readString(ctx, obj, 'question', path, { required: true, max: LIMITS.longText }),
      context: readString(ctx, obj, 'context', path, { max: LIMITS.longText }),
      options: readArray(ctx, obj, 'options', path, LIMITS.options, (item, p) => {
        if (typeof item !== 'string' || !item.trim()) {
          addError(ctx, p, 'must be a non-empty string');
          return undefined;
        }
        const text = item.trim();
        if (text.length > LIMITS.shortText || CONTROL_CHARS.test(text)) {
          addError(ctx, p, `must be at most ${LIMITS.shortText} characters without control characters`);
          return undefined;
        }
        return text;
      }),
      status: readEnum(ctx, obj, 'status', path, DECISION_STATUSES, 'open'),
      decision: readString(ctx, obj, 'decision', path, { max: LIMITS.longText }),
      neededBy: readDate(ctx, obj, 'neededBy', path),
      decidedAt: readTimestamp(ctx, obj, 'decidedAt', path),
    };
    if (decision.status === 'decided' && !decision.decision) {
      addError(ctx, `${path}.decision`, 'is required when status is "decided"');
    }
    return decision;
  }

  function readAgentSlot(ctx, raw, path) {
    const obj = readObject(ctx, raw, path, KEYS.agentSlot);
    if (!obj) return undefined;
    const id = own(obj, 'id');
    const def = AGENT_SLOTS.find((d) => d.id === id);
    if (!def) {
      addError(ctx, `${path}.id`, `must be one of: ${AGENT_SLOTS.map((d) => d.id).join(', ')}`);
      return undefined;
    }
    let sessionUrl = null;
    const rawUrl = own(obj, 'sessionUrl');
    if (rawUrl !== undefined && rawUrl !== null && rawUrl !== '') {
      const check = checkSessionUrl(rawUrl);
      if (check.problem) addError(ctx, `${path}.sessionUrl`, check.problem);
      else sessionUrl = check.url;
    }
    const rawProvider = own(obj, 'provider');
    const provider = rawProvider === undefined || rawProvider === null || rawProvider === ''
      ? null : readEnum(ctx, obj, 'provider', path, AGENT_PROVIDERS, null);
    const branch = readString(ctx, obj, 'branch', path, { max: LIMITS.branch });
    if (branch && !isValidBranchName(branch)) addError(ctx, `${path}.branch`, 'is not a valid git branch name');
    const status = readEnum(ctx, obj, 'status', path, AGENT_STATUSES, 'offline');
    if (!sessionUrl && !rawUrl && !UNBOUND_AGENT_STATUSES.includes(status)) {
      addError(ctx, `${path}.status`, 'must be "queued" or "offline" when no session link is recorded');
    }
    const slot = {
      id: def.id,
      name: def.name,
      sessionUrl,
      provider,
      model: readString(ctx, obj, 'model', path, { max: LIMITS.model }),
      branch: branch && isValidBranchName(branch) ? branch : '',
      status,
      statusNote: readString(ctx, obj, 'statusNote', path),
      verifiedAt: readTimestamp(ctx, obj, 'verifiedAt', path, { notFuture: true }),
      milestones: readArray(ctx, obj, 'milestones', path, LIMITS.slotMilestones, (item, p) => readMilestone(ctx, item, p)),
      handoff: readString(ctx, obj, 'handoff', path, { max: LIMITS.handoff }),
      handoffUpdatedAt: readTimestamp(ctx, obj, 'handoffUpdatedAt', path),
      updatedAt: readTimestamp(ctx, obj, 'updatedAt', path),
    };
    checkUniqueIds(ctx, slot.milestones, `${path}.milestones`);
    return slot;
  }

  function readTags(ctx, obj, path) {
    const tags = readArray(ctx, obj, 'tags', path, LIMITS.tags, (item, p) => {
      if (typeof item !== 'string' || !item.trim()) {
        addError(ctx, p, 'must be a non-empty string');
        return undefined;
      }
      const tag = item.trim().toLowerCase();
      if (tag.length > 40 || CONTROL_CHARS.test(tag)) {
        addError(ctx, p, 'must be at most 40 characters without control characters');
        return undefined;
      }
      return tag;
    });
    return Array.from(new Set(tags));
  }

  function readProject(ctx, raw, path) {
    const obj = readObject(ctx, raw, path, KEYS.project);
    if (!obj) return undefined;
    const project = {
      id: readId(ctx, obj, path),
      name: readString(ctx, obj, 'name', path, { required: true }),
      summary: readString(ctx, obj, 'summary', path, { max: LIMITS.longText }),
      owner: readString(ctx, obj, 'owner', path),
      status: readEnum(ctx, obj, 'status', path, PROJECT_STATUSES),
      priority: readEnum(ctx, obj, 'priority', path, PRIORITIES, 'medium'),
      tags: readTags(ctx, obj, path),
      startDate: readDate(ctx, obj, 'startDate', path),
      dueDate: readDate(ctx, obj, 'dueDate', path),
      updatedAt: readTimestamp(ctx, obj, 'updatedAt', path),
      milestones: readArray(ctx, obj, 'milestones', path, LIMITS.milestones, (item, p) => readMilestone(ctx, item, p)),
      blockers: readArray(ctx, obj, 'blockers', path, LIMITS.listItems, (item, p) => readBlocker(ctx, item, p)),
      nextActions: readArray(ctx, obj, 'nextActions', path, LIMITS.listItems, (item, p) => readNextAction(ctx, item, p)),
      decisions: readArray(ctx, obj, 'decisions', path, LIMITS.listItems, (item, p) => readDecision(ctx, item, p)),
    };
    checkUniqueIds(ctx, project.milestones, `${path}.milestones`);
    checkUniqueIds(ctx, project.blockers, `${path}.blockers`);
    checkUniqueIds(ctx, project.nextActions, `${path}.nextActions`);
    checkUniqueIds(ctx, project.decisions, `${path}.decisions`);
    const milestoneIds = new Set(project.milestones.map((m) => m.id));
    project.blockers.forEach((b, i) => {
      if (b.milestoneId && !milestoneIds.has(b.milestoneId)) {
        addError(ctx, `${path}.blockers[${i}].milestoneId`, `refers to unknown milestone "${b.milestoneId}"`);
      }
    });
    if (project.startDate && project.dueDate && project.startDate > project.dueDate) {
      addWarning(ctx, `${path}.dueDate`, 'is before startDate');
    }
    return project;
  }

  /**
   * Validates an already-parsed value against the Project Cockpit schema.
   * Returns { ok, errors, warnings, truncated, data } where data is a fresh,
   * normalized document (only known fields) when ok is true.
   * options.now: reference time. options.futureCheck (default true): reject
   * verification times in the future; stored data passes false so a changed
   * device clock can never lock a user out of their own data.
   */
  function validateDocument(input, options) {
    const opts = options || {};
    const ctx = createContext(opts.now, opts.futureCheck !== false);
    const finish = (data) => ({
      ok: ctx.errors.length === 0,
      errors: ctx.errors,
      warnings: ctx.warnings,
      truncated: ctx.truncated,
      data: ctx.errors.length === 0 ? data : null,
    });
    if (!isPlainObject(input)) {
      addError(ctx, '$', 'must be a JSON object');
      return finish(null);
    }
    if (own(input, 'schema') !== SCHEMA_ID) {
      addError(ctx, '$.schema', `must be "${SCHEMA_ID}"`);
    }
    if (own(input, 'version') !== SCHEMA_VERSION) {
      addError(ctx, '$.version', `must be ${SCHEMA_VERSION}`);
    }
    if (ctx.errors.length) return finish(null);
    checkKeys(ctx, input, KEYS.document, '$');
    readTimestamp(ctx, input, 'exportedAt', '$');
    const rawProjects = own(input, 'projects');
    if (!Array.isArray(rawProjects)) {
      addError(ctx, '$.projects', 'must be an array');
      return finish(null);
    }
    const projects = readArray(ctx, input, 'projects', '$', LIMITS.projects, (item, p) => readProject(ctx, item, p));
    checkUniqueIds(ctx, projects, '$.projects');
    // agentSlots is optional so files written before slots existed still import;
    // missing slots get defaults and the result is always in the fixed order.
    const slots = readArray(ctx, input, 'agentSlots', '$', AGENT_SLOTS.length, (item, p) => readAgentSlot(ctx, item, p));
    checkUniqueIds(ctx, slots, '$.agentSlots');
    const agentSlots = AGENT_SLOTS.map((def) => slots.find((slot) => slot.id === def.id) || defaultAgentSlot(def));
    return finish({ schema: SCHEMA_ID, version: SCHEMA_VERSION, projects, agentSlots });
  }

  /** Size-checks, parses and validates JSON text (an import file or stored state). */
  function parseDocumentText(text, options) {
    const opts = options || {};
    const maxBytes = opts.maxBytes || LIMITS.importBytes;
    const fail = (message) => ({
      ok: false, errors: [{ path: '$', message }], warnings: [], truncated: false, data: null,
    });
    if (typeof text !== 'string') return fail('input must be text');
    const bytes = utf8ByteLength(text);
    if (bytes > maxBytes) return fail(`file is ${formatBytes(bytes)}; the limit is ${formatBytes(maxBytes)}`);
    let body = text;
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
    if (!body.trim()) return fail('file is empty');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      const detail = String(err && err.message ? err.message : err).slice(0, 160);
      return fail(`is not valid JSON (${detail})`);
    }
    return validateDocument(parsed, opts);
  }

  function serializeDocument(doc, nowInput) {
    const out = {
      schema: SCHEMA_ID,
      version: SCHEMA_VERSION,
      exportedAt: toDate(nowInput).toISOString(),
      projects: doc.projects,
      agentSlots: doc.agentSlots || defaultAgentSlots(),
    };
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  function formatIssue(issue) {
    return `${issue.path}: ${issue.message}`;
  }

  /* ---------- progress and confidence ---------- */

  function openBlockerMilestoneIds(project) {
    return new Set(project.blockers.filter((b) => !b.resolved && b.milestoneId).map((b) => b.milestoneId));
  }

  /**
   * Why a milestone does or does not count toward completion. Only a
   * "complete" milestone that is verified, has an http(s) evidence link and
   * no open linked blocker is eligible. Blocked and untested never count.
   */
  function milestoneEligibility(milestone, blockedIds) {
    if (milestone.status === 'blocked') return 'blocked';
    if (milestone.status === 'untested') return 'untested';
    if (milestone.status !== 'complete') return 'not_complete';
    if (blockedIds && blockedIds.has(milestone.id)) return 'open_blocker';
    if (!milestone.verifiedAt) return 'unverified';
    if (!milestone.evidence.some((e) => safeHttpUrl(e.url))) return 'no_evidence';
    return 'counted';
  }

  /**
   * Completion = sum(weights of eligible complete milestones) / sum(all weights).
   * Weights are summed as integer hundredths to avoid floating-point drift,
   * and the percentage is rounded down so progress is never overstated.
   */
  function computeProgress(project, nowInput) {
    const now = toDate(nowInput);
    const nowMs = now.getTime();
    const today = localDateString(now);
    const blockedIds = openBlockerMilestoneIds(project);
    let numerator = 0;
    let denominator = 0;
    let lastVerifiedAt = null;
    const milestones = project.milestones.map((m) => {
      const reason = milestoneEligibility(m, blockedIds);
      const weight = toHundredths(m.weight);
      denominator += weight;
      if (reason === 'counted') numerator += weight;
      if (m.verifiedAt && (!lastVerifiedAt || Date.parse(m.verifiedAt) > Date.parse(lastVerifiedAt))) {
        lastVerifiedAt = m.verifiedAt;
      }
      const ageDays = m.verifiedAt ? (nowMs - Date.parse(m.verifiedAt)) / DAY_MS : null;
      const overdue = Boolean(m.dueDate && m.dueDate < today && reason !== 'counted');
      return { id: m.id, title: m.title, weight: m.weight, reason, counted: reason === 'counted', ageDays, overdue };
    });
    const ratio = denominator > 0 ? numerator / denominator : null;
    const percent = denominator > 0 ? Math.floor((numerator * 100) / denominator) : null;
    return {
      numerator: numerator / 100,
      denominator: denominator / 100,
      numeratorText: formatHundredths(numerator),
      denominatorText: formatHundredths(denominator),
      ratio,
      percent,
      countedIds: milestones.filter((m) => m.counted).map((m) => m.id),
      milestones,
      lastVerifiedAt,
      confidence: computeConfidence(project, milestones, denominator),
    };
  }

  /**
   * Confidence rates how far the completion figure can be relied on now.
   * low: a milestone claims "complete" but is not counted, or a counted
   *      milestone was last verified more than STALE_DAYS ago.
   * medium: verification is 15-30 days old, or untested/blocked work,
   *      open blockers or overdue milestones make the remainder uncertain.
   * high: none of the above. none: no milestones to measure.
   */
  function computeConfidence(project, milestones, denominator) {
    if (denominator === 0) {
      return { level: 'none', label: 'Not measurable', reasons: ['No weighted milestones yet'] };
    }
    const major = [];
    const minor = [];
    const unproven = milestones.filter((m) => UNPROVEN_REASONS.includes(m.reason)).length;
    if (unproven) major.push(`${plural(unproven, 'milestone')} marked complete but not counted`);
    const counted = milestones.filter((m) => m.counted);
    const stale = counted.filter((m) => m.ageDays > STALE_DAYS).length;
    if (stale) major.push(`${plural(stale, 'counted milestone')} last verified over ${STALE_DAYS} days ago`);
    const aging = counted.filter((m) => m.ageDays > FRESH_DAYS && m.ageDays <= STALE_DAYS).length;
    if (aging) minor.push(`${plural(aging, 'counted milestone')} last verified ${FRESH_DAYS + 1}-${STALE_DAYS} days ago`);
    const untested = milestones.filter((m) => m.reason === 'untested').length;
    if (untested) minor.push(`${plural(untested, 'milestone')} awaiting testing`);
    const blockedMilestones = milestones.filter((m) => m.reason === 'blocked').length;
    if (blockedMilestones) minor.push(`${plural(blockedMilestones, 'blocked milestone')}`);
    const openBlockers = project.blockers.filter((b) => !b.resolved).length;
    if (openBlockers) minor.push(`${plural(openBlockers, 'open blocker')}`);
    const overdue = milestones.filter((m) => m.overdue).length;
    if (overdue) minor.push(`${plural(overdue, 'overdue milestone')}`);
    if (major.length) return { level: 'low', label: 'Low', reasons: major.concat(minor) };
    if (minor.length) return { level: 'medium', label: 'Medium', reasons: minor };
    return {
      level: 'high',
      label: 'High',
      reasons: [counted.length ? 'All counted milestones verified recently with evidence' : 'No milestone claims completion yet'],
    };
  }

  /* ---------- project snapshot, timeline, filters ---------- */

  function projectSnapshot(project, nowInput) {
    const now = toDate(nowInput);
    const progress = computeProgress(project, now);
    const openBlockers = project.blockers.filter((b) => !b.resolved);
    const openDecisions = project.decisions.filter((d) => d.status === 'open');
    const openActions = project.nextActions.filter((a) => !a.done);
    const timeline = buildTimeline([project], now);
    const upcoming = timeline.filter((item) => item.daysUntil >= 0);
    const warnings = [];
    if (project.status === 'done' && progress.percent !== 100) {
      warnings.push(progress.denominator === 0
        ? 'Marked done, but has no milestones to verify it'
        : `Marked done, but only ${progress.percent}% is verified complete`);
    }
    return {
      progress,
      openBlockers,
      openDecisions,
      openActions,
      overdueCount: timeline.filter((item) => item.overdue).length,
      nextDue: upcoming.length ? upcoming[0] : null,
      warnings,
      needsAttention: openBlockers.length > 0 || openDecisions.length > 0 || timeline.some((i) => i.overdue),
    };
  }

  const KIND_ORDER = { project: 0, milestone: 1, decision: 2, action: 3 };

  function timelineGroup(daysUntil) {
    if (daysUntil < 0) return 'overdue';
    if (daysUntil <= 7) return 'week';
    if (daysUntil <= 30) return 'month';
    return 'later';
  }

  /** Open dated items across projects, soonest first. */
  function buildTimeline(projects, nowInput) {
    const now = toDate(nowInput);
    const today = localDateString(now);
    const items = [];
    const push = (project, kind, itemId, title, date, status) => {
      const daysUntil = daysBetweenDates(today, date);
      items.push({
        key: `${project.id}:${kind}:${itemId}`,
        projectId: project.id,
        projectName: project.name,
        kind,
        itemId,
        title,
        date,
        status,
        daysUntil,
        overdue: daysUntil < 0,
        group: timelineGroup(daysUntil),
      });
    };
    for (const project of projects) {
      const blockedIds = openBlockerMilestoneIds(project);
      if (project.dueDate && project.status !== 'done') {
        push(project, 'project', project.id, `${project.name} due`, project.dueDate, project.status);
      }
      for (const m of project.milestones) {
        if (m.dueDate && milestoneEligibility(m, blockedIds) !== 'counted') {
          push(project, 'milestone', m.id, m.title, m.dueDate, m.status);
        }
      }
      for (const d of project.decisions) {
        if (d.neededBy && d.status === 'open') push(project, 'decision', d.id, d.question, d.neededBy, d.status);
      }
      for (const a of project.nextActions) {
        if (a.dueDate && !a.done) push(project, 'action', a.id, a.text, a.dueDate, 'open');
      }
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      || a.title.localeCompare(b.title));
    return items;
  }

  function summarize(doc, nowInput) {
    const now = toDate(nowInput);
    const timeline = buildTimeline(doc.projects, now);
    let openBlockers = 0;
    let openDecisions = 0;
    for (const p of doc.projects) {
      openBlockers += p.blockers.filter((b) => !b.resolved).length;
      openDecisions += p.decisions.filter((d) => d.status === 'open').length;
    }
    return {
      projects: doc.projects.length,
      activeProjects: doc.projects.filter((p) => p.status === 'active').length,
      openBlockers,
      openDecisions,
      overdue: timeline.filter((i) => i.overdue).length,
      dueThisWeek: timeline.filter((i) => i.group === 'week').length,
    };
  }

  function allTags(projects) {
    const set = new Set();
    projects.forEach((p) => p.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }

  const SORTS = Object.freeze({
    due: 'Next deadline',
    progress_asc: 'Least complete first',
    progress_desc: 'Most complete first',
    name: 'Name',
    updated: 'Recently updated',
  });

  /**
   * filters: { q, status, priority, tag, attention, sort }. Empty values
   * mean "any". Returns [{ project, snapshot }] in the requested order.
   */
  function filterProjects(projects, filters, nowInput) {
    const f = filters || {};
    const now = toDate(nowInput);
    const q = (f.q || '').trim().toLowerCase();
    const rows = projects.map((project) => ({ project, snapshot: projectSnapshot(project, now) }))
      .filter(({ project, snapshot }) => {
        if (f.status && project.status !== f.status) return false;
        if (f.priority && project.priority !== f.priority) return false;
        if (f.tag && !project.tags.includes(f.tag)) return false;
        if (f.attention && !snapshot.needsAttention) return false;
        if (q) {
          const haystack = [project.name, project.summary, project.owner, project.tags.join(' ')].join(' ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      });
    const byName = (a, b) => a.project.name.localeCompare(b.project.name);
    const pct = (row) => (row.snapshot.progress.percent === null ? -1 : row.snapshot.progress.percent);
    const comparators = {
      name: byName,
      progress_asc: (a, b) => pct(a) - pct(b) || byName(a, b),
      progress_desc: (a, b) => pct(b) - pct(a) || byName(a, b),
      updated: (a, b) => (b.project.updatedAt || '').localeCompare(a.project.updatedAt || '') || byName(a, b),
      due: (a, b) => {
        const da = a.snapshot.nextDue ? a.snapshot.nextDue.date : '9999-12-31';
        const db = b.snapshot.nextDue ? b.snapshot.nextDue.date : '9999-12-31';
        const oa = a.snapshot.overdueCount > 0 ? 0 : 1;
        const ob = b.snapshot.overdueCount > 0 ? 0 : 1;
        return oa - ob || da.localeCompare(db) || byName(a, b);
      },
    };
    return rows.sort(comparators[f.sort] || comparators.due);
  }

  /**
   * Honest presentation of a slot: whether a session link is recorded,
   * whether the recorded status may be out of date, and milestone progress
   * under the same eligibility rule as projects.
   */
  function agentSlotView(slot, nowInput) {
    const now = toDate(nowInput);
    const bound = Boolean(slot.sessionUrl);
    const ageHours = slot.verifiedAt ? (now.getTime() - Date.parse(slot.verifiedAt)) / 3600000 : null;
    let freshness = null;
    if (bound && !slot.verifiedAt) {
      freshness = 'Recorded status has never been checked against the session';
    } else if ((slot.status === 'running' || slot.status === 'waiting') && ageHours > STATUS_STALE_HOURS) {
      freshness = `Recorded status was last checked ${relativeTime(slot.verifiedAt, now)} and may be out of date`;
    }
    return {
      bound,
      connection: bound ? 'Session link recorded manually (not monitored)' : 'No session connected',
      ageHours,
      stale: Boolean(freshness),
      freshness,
      progress: computeProgress({ milestones: slot.milestones, blockers: [] }, now),
    };
  }

  /* ---------- display helpers ---------- */

  function relativeDays(days) {
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    return days > 0 ? `in ${days} days` : `${-days} days ago`;
  }

  function relativeTime(iso, nowInput) {
    if (!iso) return 'never';
    const diff = toDate(nowInput).getTime() - Date.parse(iso);
    const minutes = Math.round(diff / 60000);
    if (Math.abs(minutes) < 1) return 'just now';
    if (Math.abs(minutes) < 60) return minutes > 0 ? `${minutes} min ago` : `in ${-minutes} min`;
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return hours > 0 ? `${plural(hours, 'hour')} ago` : `in ${plural(-hours, 'hour')}`;
    const days = Math.round(hours / 24);
    return days > 0 ? `${plural(days, 'day')} ago` : `in ${plural(-days, 'day')}`;
  }

  function label(value) {
    return hasOwn(LABELS, value) ? LABELS[value] : String(value);
  }

  return Object.freeze({
    SCHEMA_ID,
    SCHEMA_VERSION,
    LIMITS,
    PROJECT_STATUSES,
    MILESTONE_STATUSES,
    PRIORITIES,
    DECISION_STATUSES,
    AGENT_SLOTS,
    AGENT_STATUSES,
    UNBOUND_AGENT_STATUSES,
    AGENT_PROVIDERS,
    STATUS_STALE_HOURS,
    ELIGIBILITY,
    FRESH_DAYS,
    STALE_DAYS,
    SORTS,
    localDateString,
    isValidDateString,
    isValidTimestamp,
    daysBetweenDates,
    safeHttpUrl,
    checkSessionUrl,
    isValidBranchName,
    defaultAgentSlots,
    agentSlotView,
    newId,
    createEmptyDocument,
    validateDocument,
    parseDocumentText,
    serializeDocument,
    formatIssue,
    formatBytes,
    utf8ByteLength,
    milestoneEligibility,
    computeProgress,
    projectSnapshot,
    buildTimeline,
    summarize,
    allTags,
    filterProjects,
    relativeDays,
    relativeTime,
    label,
    plural,
  });
});
