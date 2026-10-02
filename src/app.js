/*
 * Project Cockpit UI. Everything is rendered with DOM APIs: user-supplied
 * text only ever reaches the page as text nodes or attribute values, never
 * through HTML parsing, and links are limited to in-app "#/" routes and
 * validated http(s) URLs.
 */
(function () {
  'use strict';

  const Core = window.CockpitCore;
  const Store = window.CockpitStorage;
  const Sample = window.CockpitSample;
  const { plural } = Core;

  const DEFAULT_FILTERS = Object.freeze({ q: '', status: '', priority: '', tag: '', attention: false, sort: 'due' });
  const INTERNAL_CHECK = { futureCheck: false };

  const state = {
    doc: Core.createEmptyDocument(),
    adapter: null,
    durable: false,
    recovery: null,
    saveError: null,
    loadError: null,
    filters: { ...DEFAULT_FILTERS },
    timelineKind: '',
    saveChain: Promise.resolve(),
    dialogReturnKey: null,
  };

  const now = () => new Date();
  const $ = (selector) => document.querySelector(selector);

  /* ---------- safe DOM builder ---------- */

  const FORBIDDEN_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'style']);

  function safeHref(value) {
    const text = String(value);
    if (text.startsWith('#')) return text;
    const safe = Core.safeHttpUrl(text);
    if (!safe) throw new Error('Refusing to render a link that is not http(s)');
    return safe;
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (FORBIDDEN_PROPS.has(key)) throw new Error(`h(): "${key}" is not allowed`);
        if (key === 'class') el.className = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else if (key === 'href') el.setAttribute('href', safeHref(value));
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  const sr = (text) => h('span', { class: 'sr-only' }, text);

  function button(content, onClick, opts) {
    const o = opts || {};
    return h('button', {
      type: o.type || 'button',
      class: `btn${o.variant ? ` btn-${o.variant}` : ''}`,
      'data-key': o.key,
      'aria-describedby': o.describedBy,
      onclick: onClick,
    }, content);
  }

  /* ---------- formatting ---------- */

  const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  function parseLocalDate(value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  const dateEl = (value) => h('time', { datetime: value }, dateFormat.format(parseLocalDate(value)));
  const timestampEl = (iso) => h('time', { datetime: iso }, dateTimeFormat.format(new Date(iso)));

  function relativeDate(value) {
    return Core.relativeDays(Core.daysBetweenDates(Core.localDateString(now()), value));
  }

  const TONES = {
    planned: 'neutral', active: 'info', blocked: 'bad', on_hold: 'warn', done: 'ok',
    not_started: 'neutral', in_progress: 'info', untested: 'warn', complete: 'ok',
    open: 'warn', decided: 'ok', deferred: 'neutral',
  };

  const badge = (text, tone) => h('span', { class: `badge tone-${tone}` }, text);
  const statusBadge = (status) => badge(Core.label(status), TONES[status] || 'neutral');
  const priorityBadge = (priority) => badge(`${Core.label(priority)} priority`, priority === 'high' ? 'bad' : 'neutral');
  const KIND_LABELS = { project: 'Project due', milestone: 'Milestone', decision: 'Decision', action: 'Next action' };

  function confidenceChip(confidence) {
    const tone = { high: 'ok', medium: 'warn', low: 'bad', none: 'neutral' }[confidence.level];
    return badge(`Confidence: ${confidence.label}`, tone);
  }

  function lastVerifiedText(iso) {
    if (!iso) return h('span', {}, 'Never verified');
    return h('span', {}, 'Last verified ', timestampEl(iso), ` (${Core.relativeTime(iso, now())})`);
  }

  function progressBar(percent) {
    const fill = h('div', { class: 'bar-fill' });
    fill.style.width = `${percent || 0}%`;
    return h('div', { class: 'bar', 'aria-hidden': 'true' }, fill);
  }

  function progressSummary(p) {
    if (p.denominator === 0) {
      return h('div', { class: 'progress' },
        h('p', { class: 'progress-text' }, 'No weighted milestones yet'), progressBar(0));
    }
    return h('div', { class: 'progress' },
      h('p', { class: 'progress-text' },
        h('strong', { class: 'progress-pct' }, `${p.percent}%`), ' ',
        h('span', { class: 'progress-fraction' }, `${p.numeratorText} / ${p.denominatorText} weight verified complete`)),
      progressBar(p.percent));
  }

  function evidenceLink(evidence) {
    const url = Core.safeHttpUrl(evidence.url);
    if (!url) return h('span', { class: 'muted' }, `${evidence.label} (link removed: not http or https)`);
    return h('span', {},
      h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' },
        evidence.label, sr(' (opens in a new tab)')),
      ' ', h('span', { class: 'muted host' }, `(${new URL(url).hostname})`));
  }

  function friendlyIssue(issue) {
    const match = /\.([A-Za-z]+)(\[\d+\])?$/.exec(issue.path);
    return match ? `${match[1]} ${issue.message}` : Core.formatIssue(issue);
  }

  /* ---------- announcements and notices ---------- */

  function announce(message) {
    const live = $('#live');
    live.textContent = '';
    window.setTimeout(() => { live.textContent = message; }, 60);
  }

  function notice(tone, content, role) {
    return h('div', { class: `notice tone-${tone}`, role }, content);
  }

  function renderNotices() {
    const box = $('#notices');
    clear(box);
    if (!state.durable) {
      box.append(notice('warn', h('p', {},
        'Browser storage is unavailable here (some private windows block it). Changes last only until this tab closes. Use Data, then Export JSON, to keep a copy.')));
    }
    if (state.loadError) box.append(notice('bad', h('p', {}, state.loadError), 'alert'));
    if (state.saveError) {
      box.append(notice('bad', h('p', {}, `Your last change was not saved: ${state.saveError}`), 'alert'));
    }
    if (state.recovery) {
      const first = state.recovery.errors[0];
      box.append(notice('bad', [
        h('p', {}, h('strong', {}, 'Saved data could not be loaded. '),
          `${plural(state.recovery.errors.length, 'problem')} found${first ? ` (first: ${Core.formatIssue(first)})` : ''}. `,
          'It has not been changed or overwritten. Download it to repair it by hand, import a valid file, or discard it.'),
        h('div', { class: 'notice-actions' },
          button('Download saved data', () => downloadText(state.recovery.raw, 'project-cockpit-unreadable.json'), { key: 'recovery-download' }),
          button('Discard saved data', discardRecovery, { variant: 'danger', key: 'recovery-discard' })),
      ], 'alert'));
    }
  }

  /* ---------- persistence ---------- */

  function persist(text) {
    state.saveChain = state.saveChain
      .then(() => state.adapter.save(text))
      .then(() => {
        if (state.saveError) {
          state.saveError = null;
          renderNotices();
        }
      })
      .catch((err) => {
        state.saveError = err && err.message ? err.message : 'Unknown storage error.';
        renderNotices();
      });
    return state.saveChain;
  }

  /**
   * Applies a change to a copy of the document, re-validates the whole
   * document, saves it and re-renders. Returns { errors } when rejected.
   */
  function commit(mutator, message, renderOptions) {
    if (state.recovery) {
      return { errors: ['Saved data needs attention first: see the notice at the top of the page.'] };
    }
    const draft = structuredClone(state.doc);
    const problems = mutator(draft);
    if (Array.isArray(problems) && problems.length) return { errors: problems };
    const check = Core.validateDocument(draft, { now: now(), ...INTERNAL_CHECK });
    if (!check.ok) return { errors: check.errors.map(friendlyIssue) };
    const text = Core.serializeDocument(check.data, now());
    if (Core.utf8ByteLength(text) > Core.LIMITS.importBytes) {
      return { errors: [`This change would push your data past the ${Core.formatBytes(Core.LIMITS.importBytes)} limit. Export a backup and remove old projects first.`] };
    }
    state.doc = check.data;
    persist(text);
    render(renderOptions);
    if (message) announce(message);
    return { ok: true };
  }

  function replaceDocument(doc, message) {
    state.doc = doc;
    state.recovery = null;
    persist(Core.serializeDocument(doc, now()));
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else render();
    announce(message);
  }

  async function loadFromAdapter() {
    let raw;
    try {
      raw = await state.adapter.load();
      state.loadError = null;
    } catch (err) {
      state.loadError = err && err.message ? err.message : 'Could not read saved data.';
      return;
    }
    if (raw === null || raw === undefined) {
      state.doc = Core.createEmptyDocument();
      state.recovery = null;
      return;
    }
    const result = Core.parseDocumentText(raw, { now: now(), ...INTERNAL_CHECK });
    if (result.ok) {
      state.doc = result.data;
      state.recovery = null;
    } else {
      state.doc = Core.createEmptyDocument();
      state.recovery = { raw, errors: result.errors };
    }
  }

  function findProject(doc, id) {
    return doc.projects.find((p) => p.id === id) || null;
  }

  function findSlot(doc, id) {
    return (doc.agentSlots || []).find((s) => s.id === id) || null;
  }

  /** Milestones belong to a project or an agent slot: owner is { kind, id }. */
  function findOwner(doc, owner) {
    return owner.kind === 'slot' ? findSlot(doc, owner.id) : findProject(doc, owner.id);
  }

  function touch(project) {
    project.updatedAt = now().toISOString();
  }

  /* ---------- dialogs ---------- */

  function rememberInvoker() {
    const active = document.activeElement;
    state.dialogReturnKey = active && active.dataset ? active.dataset.key || null : null;
  }

  function restoreFocus() {
    const key = state.dialogReturnKey;
    state.dialogReturnKey = null;
    const target = key ? document.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
    if (target) target.focus();
    else {
      const heading = $('#page-title');
      if (heading) heading.focus();
    }
  }

  function openDialog(build) {
    const dialog = $('#dialog');
    if (dialog.open) dialog.close();
    rememberInvoker();
    clear(dialog);
    build(dialog);
    dialog.showModal();
    const first = dialog.querySelector('[autofocus], input:not([type=hidden]), select, textarea, button');
    if (first) first.focus();
  }

  function closeDialog() {
    const dialog = $('#dialog');
    if (dialog.open) dialog.close();
  }

  function errorList(box, messages) {
    clear(box);
    box.hidden = false;
    box.append(h('p', {}, h('strong', {}, 'Please fix the following:')),
      h('ul', {}, messages.map((m) => h('li', {}, m))));
    box.focus();
  }

  /**
   * Opens a modal form. onSubmit(formData, form) returns { errors } to keep
   * the dialog open, or anything else to close it.
   */
  function formDialog({ title, description, fields, submitLabel, onSubmit, variant }) {
    openDialog((dialog) => {
      const errors = h('div', { class: 'form-errors', tabindex: '-1', hidden: true, role: 'alert' });
      const form = h('form', { class: 'dialog-form', method: 'dialog', novalidate: true },
        h('h2', { id: 'dialog-title' }, title),
        description ? h('p', { class: 'dialog-desc', id: 'dialog-desc' }, description) : null,
        errors,
        fields,
        h('div', { class: 'dialog-actions' },
          button('Cancel', closeDialog),
          h('button', { type: 'submit', class: `btn btn-${variant || 'primary'}` }, submitLabel)));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const seenGroups = new Set();
        const invalid = Array.from(form.elements).filter((el) => el.willValidate && !el.checkValidity())
          .filter((el) => el.type !== 'radio' || (!seenGroups.has(el.name) && seenGroups.add(el.name)));
        form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
        if (invalid.length) {
          invalid.forEach((el) => el.setAttribute('aria-invalid', 'true'));
          errorList(errors, invalid.map((el) => `${fieldLabel(el)}: ${el.validationMessage}`));
          return;
        }
        const result = onSubmit(new FormData(form), form);
        if (result && result.errors && result.errors.length) {
          errorList(errors, result.errors);
          return;
        }
        closeDialog();
      });
      dialog.setAttribute('aria-labelledby', 'dialog-title');
      if (description) dialog.setAttribute('aria-describedby', 'dialog-desc');
      else dialog.removeAttribute('aria-describedby');
      dialog.append(form);
    });
  }

  function fieldLabel(el) {
    if (el.type === 'radio') {
      const legend = el.closest('fieldset') && el.closest('fieldset').querySelector('legend');
      if (legend) return legend.textContent;
    }
    const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return labelEl ? labelEl.textContent.replace(/\s*\(required\)\s*$/, '') : el.name;
  }

  function confirmDialog({ title, body, confirmLabel, variant }) {
    return new Promise((resolve) => {
      let answered = false;
      formDialog({
        title,
        fields: h('div', { class: 'confirm-body' }, body),
        submitLabel: confirmLabel,
        variant: variant || 'primary',
        onSubmit: () => {
          answered = true;
          resolve(true);
        },
      });
      const dialog = $('#dialog');
      const onClose = () => {
        if (dialog.open) return;
        dialog.removeEventListener('close', onClose);
        if (!answered) resolve(false);
      };
      dialog.addEventListener('close', onClose);
    });
  }

  function infoDialog(title, body) {
    openDialog((dialog) => {
      dialog.setAttribute('aria-labelledby', 'dialog-title');
      dialog.removeAttribute('aria-describedby');
      dialog.append(h('div', { class: 'dialog-form' },
        h('h2', { id: 'dialog-title' }, title),
        body,
        h('div', { class: 'dialog-actions' }, button('Close', closeDialog, { variant: 'primary' }))));
    });
  }

  let fieldCounter = 0;

  function field(spec) {
    fieldCounter += 1;
    const id = `f-${spec.name}-${fieldCounter}`;
    const hintId = spec.hint ? `${id}-hint` : null;
    const common = {
      id,
      name: spec.name,
      required: spec.required,
      'aria-describedby': hintId,
      'aria-required': spec.required ? 'true' : null,
    };
    let control;
    if (spec.type === 'textarea') {
      control = h('textarea', { ...common, rows: spec.rows || 3, maxlength: spec.maxlength || Core.LIMITS.longText }, spec.value || '');
    } else if (spec.type === 'select') {
      control = h('select', common, spec.options.map(([value, text]) => (
        h('option', { value, selected: value === spec.value }, text))));
    } else if (spec.type === 'checkbox') {
      return h('div', { class: 'field field-check' },
        h('input', { ...common, type: 'checkbox', value: 'on', checked: Boolean(spec.value) }),
        h('label', { for: id }, spec.label),
        spec.hint ? h('p', { class: 'hint', id: hintId }, spec.hint) : null);
    } else {
      control = h('input', {
        ...common,
        type: spec.type || 'text',
        value: spec.value === undefined || spec.value === null ? '' : String(spec.value),
        maxlength: spec.type === 'number' || spec.type === 'date' ? null : (spec.maxlength || Core.LIMITS.shortText),
        min: spec.min,
        max: spec.max,
        step: spec.step,
        inputmode: spec.inputmode,
        autocomplete: 'off',
      });
    }
    return h('div', { class: 'field' },
      h('label', { for: id }, spec.label, spec.required ? h('span', { class: 'req' }, ' (required)') : null),
      spec.hint ? h('p', { class: 'hint', id: hintId }, spec.hint) : null,
      control);
  }

  const str = (fd, name) => String(fd.get(name) || '').trim();
  const dateOrNull = (fd, name) => str(fd, name) || null;
  const checked = (fd, name) => fd.get(name) === 'on';
  const enumOptions = (values) => values.map((v) => [v, Core.label(v)]);

  /* ---------- forms ---------- */

  function projectForm(existing) {
    const p = existing || { status: 'active', priority: 'medium', tags: [] };
    formDialog({
      title: existing ? 'Edit project' : 'New project',
      submitLabel: existing ? 'Save project' : 'Create project',
      fields: [
        field({ name: 'name', label: 'Name', required: true, value: p.name }),
        field({ name: 'summary', label: 'Summary', type: 'textarea', value: p.summary }),
        field({ name: 'owner', label: 'Owner', value: p.owner }),
        field({ name: 'status', label: 'Status', type: 'select', value: p.status, options: enumOptions(Core.PROJECT_STATUSES) }),
        field({ name: 'priority', label: 'Priority', type: 'select', value: p.priority, options: enumOptions(Core.PRIORITIES) }),
        field({ name: 'tags', label: 'Tags', value: p.tags.join(', '), hint: 'Separate tags with commas.' }),
        field({ name: 'startDate', label: 'Start date', type: 'date', value: p.startDate }),
        field({ name: 'dueDate', label: 'Due date', type: 'date', value: p.dueDate }),
      ],
      onSubmit: (fd) => {
        const values = {
          name: str(fd, 'name'),
          summary: str(fd, 'summary'),
          owner: str(fd, 'owner'),
          status: str(fd, 'status'),
          priority: str(fd, 'priority'),
          tags: str(fd, 'tags').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
          startDate: dateOrNull(fd, 'startDate'),
          dueDate: dateOrNull(fd, 'dueDate'),
        };
        let createdId = null;
        const result = commit((doc) => {
          if (existing) {
            const target = findProject(doc, existing.id);
            if (!target) return ['This project no longer exists.'];
            Object.assign(target, values);
            touch(target);
          } else {
            createdId = Core.newId('p');
            doc.projects.push({
              id: createdId, ...values, updatedAt: null, milestones: [], blockers: [], nextActions: [], decisions: [],
            });
            touch(doc.projects[doc.projects.length - 1]);
          }
          return null;
        }, existing ? 'Project saved' : 'Project created');
        if (result.ok && createdId) location.hash = `#/project/${encodeURIComponent(createdId)}`;
        return result;
      },
    });
  }

  function evidenceRow(evidence) {
    fieldCounter += 1;
    const n = fieldCounter;
    const row = h('div', { class: 'evidence-row' },
      h('div', { class: 'field' },
        h('label', { for: `ev-label-${n}` }, 'Link label'),
        h('input', { id: `ev-label-${n}`, name: 'evidenceLabel', type: 'text', maxlength: Core.LIMITS.shortText, value: evidence ? evidence.label : '' })),
      h('div', { class: 'field' },
        h('label', { for: `ev-url-${n}` }, 'URL (http or https)'),
        h('input', {
          id: `ev-url-${n}`, name: 'evidenceUrl', type: 'url', inputmode: 'url', maxlength: Core.LIMITS.urlLength,
          value: evidence ? evidence.url : '', placeholder: 'https://',
        })));
    row.append(button(['Remove', sr(' this evidence link')], () => {
      const list = row.parentElement;
      row.remove();
      const next = list.querySelector('input');
      if (next) next.focus();
      else list.parentElement.querySelector('.add-evidence').focus();
    }, { variant: 'quiet' }));
    return row;
  }

  function milestoneForm(owner, existing) {
    const m = existing || { status: 'not_started', evidence: [], weight: '' };
    const rows = h('div', { class: 'evidence-rows' }, m.evidence.map((e) => evidenceRow(e)));
    const evidenceSet = h('fieldset', { class: 'fieldset' },
      h('legend', {}, 'Evidence links'),
      h('p', { class: 'hint' }, 'Only absolute http:// or https:// links are accepted. A milestone needs at least one to count as complete.'),
      rows,
      h('button', {
        type: 'button',
        class: 'btn btn-quiet add-evidence',
        onclick: () => {
          const row = evidenceRow(null);
          rows.append(row);
          row.querySelector('input').focus();
        },
      }, 'Add evidence link'));
    const verification = existing && existing.verifiedAt
      ? [h('p', { class: 'hint' }, 'Last verified ', timestampEl(existing.verifiedAt), '.'),
        field({ name: 'clearVerification', label: 'Clear the existing verification', type: 'checkbox' })]
      : [];
    formDialog({
      title: existing ? 'Edit milestone' : 'Add milestone',
      submitLabel: existing ? 'Save milestone' : 'Add milestone',
      fields: [
        field({ name: 'title', label: 'Title', required: true, value: m.title }),
        field({
          name: 'weight', label: 'Weight', type: 'number', required: true, value: m.weight, min: '0.01', max: String(Core.LIMITS.weightMax),
          step: '0.01', inputmode: 'decimal', hint: `How much this milestone counts toward completion: more than 0, up to ${Core.LIMITS.weightMax}.`,
        }),
        field({
          name: 'status', label: 'Status', type: 'select', value: m.status, options: enumOptions(Core.MILESTONE_STATUSES),
          hint: 'Blocked and Untested never count. Switching to Complete clears an older verification unless you record one now.',
        }),
        field({ name: 'dueDate', label: 'Due date', type: 'date', value: m.dueDate }),
        evidenceSet,
        verification,
        field({ name: 'verifyNow', label: 'Record verification now (I checked the evidence)', type: 'checkbox' }),
        field({ name: 'notes', label: 'Notes', type: 'textarea', value: m.notes }),
      ],
      onSubmit: (fd, form) => {
        const labels = fd.getAll('evidenceLabel').map((v) => String(v).trim());
        const urls = fd.getAll('evidenceUrl').map((v) => String(v).trim());
        const problems = [];
        const evidence = [];
        const urlInputs = form.querySelectorAll('input[name="evidenceUrl"]');
        urls.forEach((url, i) => {
          if (!url && !labels[i]) return;
          const safe = Core.safeHttpUrl(url);
          if (!safe) {
            problems.push(`Evidence link ${i + 1}: "${url || '(empty)'}" is not an absolute http or https URL.`);
            urlInputs[i].setAttribute('aria-invalid', 'true');
            return;
          }
          evidence.push({ label: labels[i] || new URL(safe).hostname, url: safe });
        });
        if (problems.length) return { errors: problems };
        const weight = Number(str(fd, 'weight'));
        const status = str(fd, 'status');
        const verifyNow = checked(fd, 'verifyNow');
        return commit((doc) => {
          const target = findOwner(doc, owner);
          if (!target) return ['This project or slot no longer exists.'];
          let item = existing ? target.milestones.find((x) => x.id === existing.id) : null;
          if (existing && !item) return ['This milestone no longer exists.'];
          if (!item) {
            item = { id: Core.newId('m'), verifiedAt: null };
            target.milestones.push(item);
          }
          const becameComplete = status === 'complete' && (!existing || existing.status !== 'complete');
          Object.assign(item, {
            title: str(fd, 'title'), weight, status, dueDate: dateOrNull(fd, 'dueDate'), evidence, notes: str(fd, 'notes'),
          });
          if (checked(fd, 'clearVerification') || becameComplete) item.verifiedAt = null;
          if (verifyNow) item.verifiedAt = now().toISOString();
          touch(target);
          return null;
        }, existing ? 'Milestone saved' : 'Milestone added');
      },
    });
  }

  function blockerForm(project, existing) {
    const b = existing || { since: Core.localDateString(now()), milestoneId: null };
    formDialog({
      title: existing ? 'Edit blocker' : 'Add blocker',
      submitLabel: existing ? 'Save blocker' : 'Add blocker',
      fields: [
        field({ name: 'description', label: 'What is blocking progress?', type: 'textarea', required: true, value: b.description }),
        field({ name: 'owner', label: 'Who can unblock it?', value: b.owner }),
        field({ name: 'since', label: 'Blocked since', type: 'date', value: b.since }),
        field({
          name: 'milestoneId', label: 'Blocks milestone', type: 'select', value: b.milestoneId || '',
          options: [['', 'No specific milestone']].concat(project.milestones.map((m) => [m.id, m.title])),
          hint: 'A linked milestone cannot count as complete while this blocker is open.',
        }),
        existing ? field({ name: 'resolved', label: 'Resolved', type: 'checkbox', value: b.resolved }) : null,
      ],
      onSubmit: (fd) => commit((doc) => {
        const target = findProject(doc, project.id);
        if (!target) return ['This project no longer exists.'];
        const values = {
          description: str(fd, 'description'),
          owner: str(fd, 'owner'),
          since: dateOrNull(fd, 'since'),
          milestoneId: str(fd, 'milestoneId') || null,
          resolved: existing ? checked(fd, 'resolved') : false,
        };
        if (existing) {
          const item = target.blockers.find((x) => x.id === existing.id);
          if (!item) return ['This blocker no longer exists.'];
          Object.assign(item, values);
        } else {
          target.blockers.push({ id: Core.newId('b'), ...values });
        }
        touch(target);
        return null;
      }, existing ? 'Blocker saved' : 'Blocker added'),
    });
  }

  function actionForm(project, existing) {
    const a = existing || {};
    formDialog({
      title: existing ? 'Edit next action' : 'Add next action',
      submitLabel: existing ? 'Save action' : 'Add action',
      fields: [
        field({ name: 'text', label: 'Next action', type: 'textarea', rows: 2, required: true, value: a.text }),
        field({ name: 'owner', label: 'Owner', value: a.owner }),
        field({ name: 'dueDate', label: 'Due date', type: 'date', value: a.dueDate }),
      ],
      onSubmit: (fd) => commit((doc) => {
        const target = findProject(doc, project.id);
        if (!target) return ['This project no longer exists.'];
        const values = { text: str(fd, 'text'), owner: str(fd, 'owner'), dueDate: dateOrNull(fd, 'dueDate') };
        if (existing) {
          const item = target.nextActions.find((x) => x.id === existing.id);
          if (!item) return ['This action no longer exists.'];
          Object.assign(item, values);
        } else {
          target.nextActions.push({ id: Core.newId('a'), ...values, done: false });
        }
        touch(target);
        return null;
      }, existing ? 'Action saved' : 'Action added'),
    });
  }

  function decisionForm(project, existing) {
    const d = existing || { status: 'open', options: [] };
    formDialog({
      title: existing ? 'Edit decision' : 'Add decision',
      submitLabel: existing ? 'Save decision' : 'Add decision',
      fields: [
        field({ name: 'question', label: 'Question to decide', type: 'textarea', rows: 2, required: true, value: d.question }),
        field({ name: 'context', label: 'Context', type: 'textarea', value: d.context }),
        field({
          name: 'options', label: 'Options', type: 'textarea', value: d.options.join('\n'),
          hint: `One option per line, up to ${Core.LIMITS.options}.`,
        }),
        field({ name: 'neededBy', label: 'Needed by', type: 'date', value: d.neededBy }),
        field({ name: 'status', label: 'Status', type: 'select', value: d.status, options: enumOptions(Core.DECISION_STATUSES) }),
        field({
          name: 'decision', label: 'Decision and rationale', type: 'textarea', value: d.decision,
          hint: 'Required when the status is Decided.',
        }),
      ],
      onSubmit: (fd) => {
        const status = str(fd, 'status');
        if (status === 'decided' && !str(fd, 'decision')) {
          return { errors: ['Decision and rationale: write down what was decided before marking it Decided.'] };
        }
        return commit((doc) => {
          const target = findProject(doc, project.id);
          if (!target) return ['This project no longer exists.'];
          const values = {
            question: str(fd, 'question'),
            context: str(fd, 'context'),
            options: str(fd, 'options').split('\n').map((o) => o.trim()).filter(Boolean),
            neededBy: dateOrNull(fd, 'neededBy'),
            status,
            decision: str(fd, 'decision'),
          };
          let item = existing ? target.decisions.find((x) => x.id === existing.id) : null;
          if (existing && !item) return ['This decision no longer exists.'];
          if (!item) {
            item = { id: Core.newId('d'), decidedAt: null };
            target.decisions.push(item);
          }
          const wasDecided = item.status === 'decided';
          Object.assign(item, values);
          if (status === 'decided' && (!wasDecided || !item.decidedAt)) item.decidedAt = now().toISOString();
          if (status !== 'decided') item.decidedAt = null;
          touch(target);
          return null;
        }, existing ? 'Decision saved' : 'Decision added');
      },
    });
  }

  function recordDecisionForm(project, decision) {
    fieldCounter += 1;
    const group = `choice-${fieldCounter}`;
    const choices = decision.options.length
      ? h('fieldset', { class: 'fieldset' },
        h('legend', {}, 'Chosen option'),
        decision.options.map((option, i) => h('div', { class: 'field-check' },
          h('input', { type: 'radio', id: `${group}-${i}`, name: 'choice', value: option, required: true }),
          h('label', { for: `${group}-${i}` }, option))))
      : null;
    formDialog({
      title: 'Record decision',
      description: decision.question,
      submitLabel: 'Record decision',
      fields: [
        choices,
        field({
          name: 'rationale', label: decision.options.length ? 'Rationale (optional)' : 'Decision and rationale',
          type: 'textarea', required: !decision.options.length,
        }),
      ],
      onSubmit: (fd) => {
        const choice = str(fd, 'choice');
        const rationale = str(fd, 'rationale');
        const text = choice && rationale ? `${choice}: ${rationale}` : (choice || rationale);
        return commit((doc) => {
          const target = findProject(doc, project.id);
          const item = target && target.decisions.find((x) => x.id === decision.id);
          if (!item) return ['This decision no longer exists.'];
          Object.assign(item, { status: 'decided', decision: text, decidedAt: now().toISOString() });
          touch(target);
          return null;
        }, 'Decision recorded');
      },
    });
  }

  async function confirmDelete(kind, name, remove, opts) {
    const o = opts || {};
    const ok = await confirmDialog({
      title: `Delete ${kind}?`,
      body: h('p', {}, `"${name}" will be removed from this browser. This cannot be undone unless you have an export.`),
      confirmLabel: `Delete ${kind}`,
      variant: 'danger',
    });
    if (!ok) return;
    const result = commit(remove, `${kind[0].toUpperCase()}${kind.slice(1)} deleted`, { fallback: o.fallback });
    if (result.errors) infoDialog('Could not delete', h('ul', {}, result.errors.map((e) => h('li', {}, e))));
    else if (o.after) o.after();
  }

  async function verifyMilestone(owner, milestone) {
    const ok = await confirmDialog({
      title: 'Record verification?',
      body: [
        h('p', {}, `Confirm that you checked the evidence for "${milestone.title}" just now.`),
        h('p', {}, 'Verification only counts toward completion when the milestone is Complete, has an http(s) evidence link and has no open linked blocker.'),
      ],
      confirmLabel: 'Record verification',
    });
    if (!ok) return;
    commit((doc) => {
      const target = findOwner(doc, owner);
      const item = target && target.milestones.find((x) => x.id === milestone.id);
      if (!item) return ['This milestone no longer exists.'];
      item.verifiedAt = now().toISOString();
      touch(target);
      return null;
    }, `Verification recorded for ${milestone.title}`);
  }

  function toggleListItem(project, listName, id, prop, message, fallback) {
    commit((doc) => {
      const target = findProject(doc, project.id);
      const item = target && target[listName].find((x) => x.id === id);
      if (!item) return ['This item no longer exists.'];
      item[prop] = !item[prop];
      touch(target);
      return null;
    }, message, { fallback });
  }

  /* ---------- import / export ---------- */

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportJson() {
    const text = Core.serializeDocument(state.doc, now());
    downloadText(text, `project-cockpit-${Core.localDateString(now())}.json`);
    announce(`Exported ${plural(state.doc.projects.length, 'project')} as JSON`);
  }

  function showImportErrors(errors, truncated) {
    infoDialog('Import failed: nothing was changed', [
      h('p', {}, 'The file did not pass validation:'),
      h('ul', { class: 'issue-list' }, errors.map((e) => h('li', {}, Core.formatIssue(e)))),
      truncated ? h('p', {}, `Only the first ${Core.LIMITS.errorsReported} problems are shown.`) : null,
    ]);
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > Core.LIMITS.importBytes) {
      showImportErrors([{ path: '$', message: `file is ${Core.formatBytes(file.size)}; the limit is ${Core.formatBytes(Core.LIMITS.importBytes)}` }]);
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (err) {
      showImportErrors([{ path: '$', message: 'could not be read' }]);
      return;
    }
    const result = Core.parseDocumentText(text, { now: now() });
    if (!result.ok) {
      showImportErrors(result.errors, result.truncated);
      return;
    }
    const projects = result.data.projects;
    const milestones = projects.reduce((n, p) => n + p.milestones.length, 0);
    const linkedSlots = result.data.agentSlots.filter((slot) => slot.sessionUrl).length;
    const current = state.doc.projects.length;
    const ok = await confirmDialog({
      title: 'Replace current data?',
      body: [
        h('p', {}, `The file contains ${plural(projects.length, 'project')}, ${plural(milestones, 'milestone')} and ${plural(linkedSlots, 'agent slot')} with a recorded session link.`),
        h('p', {}, state.recovery
          ? 'Importing replaces the unreadable saved data.'
          : `Importing replaces the ${plural(current, 'project')} saved in this browser. Export first if you want a backup.`),
        result.warnings.length ? [
          h('p', {}, `${plural(result.warnings.length, 'warning')}:`),
          h('ul', { class: 'issue-list' }, result.warnings.map((w) => h('li', {}, Core.formatIssue(w)))),
        ] : null,
      ],
      confirmLabel: 'Replace data',
    });
    if (ok) replaceDocument(result.data, `Imported ${plural(projects.length, 'project')}`);
  }

  async function loadSample() {
    if (state.doc.projects.length || state.recovery) {
      const ok = await confirmDialog({
        title: 'Load sample data?',
        body: h('p', {}, state.recovery
          ? 'Fictional sample projects will replace the unreadable saved data.'
          : `Fictional sample projects will replace the ${plural(state.doc.projects.length, 'project')} saved in this browser.`),
        confirmLabel: 'Load sample data',
      });
      if (!ok) return;
    }
    const check = Core.validateDocument(Sample.buildSampleDocument(now()), { now: now() });
    replaceDocument(check.data, 'Loaded fictional sample data');
  }

  async function deleteAll() {
    const ok = await confirmDialog({
      title: 'Delete all data?',
      body: h('p', {}, `All ${plural(state.doc.projects.length, 'project')} and every agent slot record will be removed from this browser. This cannot be undone unless you have an export.`),
      confirmLabel: 'Delete all data',
      variant: 'danger',
    });
    if (!ok) return;
    await clearStorage();
    state.doc = Core.createEmptyDocument();
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else render();
    announce('All data deleted');
  }

  async function discardRecovery() {
    const ok = await confirmDialog({
      title: 'Discard unreadable saved data?',
      body: h('p', {}, 'The saved data that failed to load will be deleted. Download it first if you may want to repair it.'),
      confirmLabel: 'Discard saved data',
      variant: 'danger',
    });
    if (!ok) return;
    await clearStorage();
    state.recovery = null;
    render();
    announce('Unreadable saved data discarded');
  }

  async function clearStorage() {
    try {
      await state.adapter.clear();
      state.saveError = null;
    } catch (err) {
      state.saveError = err.message;
    }
  }

  /* ---------- routing ---------- */

  function parseRoute() {
    const hash = location.hash || '#/';
    if (!hash.startsWith('#/')) return null;
    const [path, query] = hash.slice(1).split('?');
    let parts;
    try {
      parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    } catch (err) {
      parts = [];
    }
    if (parts[0] === 'project' && parts[1]) return { view: 'project', id: parts[1] };
    if (parts[0] === 'timeline') return { view: 'timeline' };
    if (parts[0] === 'decisions') return { view: 'decisions' };
    if (parts[0] === 'agents') return { view: 'agents' };
    if (parts[0] === 'agent' && parts[1]) return { view: 'agent', id: parts[1] };
    return { view: 'projects', params: new URLSearchParams(query || '') };
  }

  function filtersFromParams(params) {
    const pick = (key, allowed) => (allowed.includes(params.get(key)) ? params.get(key) : '');
    return {
      q: (params.get('q') || '').slice(0, 120),
      status: pick('status', Core.PROJECT_STATUSES),
      priority: pick('priority', Core.PRIORITIES),
      tag: (params.get('tag') || '').slice(0, 40),
      attention: params.get('attention') === '1',
      sort: Object.keys(Core.SORTS).includes(params.get('sort')) ? params.get('sort') : 'due',
    };
  }

  function syncFilterUrl() {
    const params = new URLSearchParams();
    const f = state.filters;
    if (f.q) params.set('q', f.q);
    if (f.status) params.set('status', f.status);
    if (f.priority) params.set('priority', f.priority);
    if (f.tag) params.set('tag', f.tag);
    if (f.attention) params.set('attention', '1');
    if (f.sort !== 'due') params.set('sort', f.sort);
    const query = params.toString();
    history.replaceState(null, '', query ? `#/?${query}` : '#/');
  }

  function updateNav(route) {
    document.querySelectorAll('[data-nav]').forEach((link) => {
      const parent = { project: 'projects', agent: 'agents' }[route.view] || route.view;
      const active = link.dataset.nav === parent;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function pageTitle(text) {
    return h('h1', { id: 'page-title', tabindex: '-1' }, text);
  }

  function render(options) {
    const route = parseRoute();
    if (!route) return;
    const main = $('#main');
    const active = document.activeElement;
    const focusKey = active && main.contains(active) && active.dataset ? active.dataset.key : null;
    clear(main);
    updateNav(route);
    renderNotices();
    $('#storage-name').textContent = state.adapter ? state.adapter.name : '';
    let title;
    if (route.view === 'project') title = renderProject(main, route.id);
    else if (route.view === 'timeline') title = renderTimeline(main);
    else if (route.view === 'decisions') title = renderDecisions(main);
    else if (route.view === 'agents') title = renderAgents(main);
    else if (route.view === 'agent') title = renderAgent(main, route.id);
    else title = renderProjects(main, route);
    document.title = `${title} · Project Cockpit`;
    if (options && options.focusHeading) {
      $('#page-title').focus();
    } else if (focusKey) {
      // Re-rendering replaces nodes; put focus back on the matching control,
      // or on a nearby heading when that control moved out of view or is gone.
      const target = main.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (target) target.focus();
      if (!target || document.activeElement !== target) {
        const fallback = (options && options.fallback && main.querySelector(options.fallback)) || $('#page-title');
        if (fallback) fallback.focus();
      }
    }
  }

  /* ---------- views: projects ---------- */

  function emptyState() {
    return h('section', { class: 'panel empty-state', 'aria-labelledby': 'empty-title' },
      h('h2', { id: 'empty-title' }, 'No projects yet'),
      h('p', {}, 'Create a project, import a Project Cockpit JSON file, or explore with fictional sample data. Everything stays in this browser.'),
      h('div', { class: 'button-row' },
        button('New project', () => projectForm(null), { variant: 'primary', key: 'empty-new' }),
        button('Import JSON', () => $('#import-file').click(), { key: 'empty-import' }),
        button('Load sample data', loadSample, { key: 'empty-sample' })));
  }

  function summaryStats() {
    const s = Core.summarize(state.doc, now());
    const stat = (value, text, href, tone) => h('li', { class: `stat${tone && value ? ` stat-${tone}` : ''}` },
      h('a', { href, class: 'stat-link' },
        h('span', { class: 'stat-value' }, String(value)),
        h('span', { class: 'stat-label' }, text)));
    return h('ul', { class: 'stats', 'aria-label': 'Summary' },
      stat(s.activeProjects, s.activeProjects === 1 ? 'Active project' : 'Active projects', '#/?status=active'),
      stat(s.openBlockers, s.openBlockers === 1 ? 'Open blocker' : 'Open blockers', '#/?attention=1', 'bad'),
      stat(s.openDecisions, s.openDecisions === 1 ? 'Decision waiting' : 'Decisions waiting', '#/decisions', 'warn'),
      stat(s.overdue, s.overdue === 1 ? 'Overdue item' : 'Overdue items', '#/timeline', 'bad'),
      stat(s.dueThisWeek, 'Due in 7 days', '#/timeline'));
  }

  function filterForm(onChange) {
    const f = state.filters;
    const tags = Core.allTags(state.doc.projects);
    const update = (key, value) => {
      state.filters = { ...state.filters, [key]: value };
      syncFilterUrl();
      onChange();
    };
    const select = (name, labelText, value, options) => {
      fieldCounter += 1;
      const id = `filter-${name}-${fieldCounter}`;
      return h('div', { class: 'field' },
        h('label', { for: id }, labelText),
        h('select', { id, name, 'data-key': `filter-${name}`, onchange: (e) => update(name, e.target.value) },
          options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
    };
    return h('form', { class: 'filters panel', role: 'search', 'aria-label': 'Filter projects', onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'field field-search' },
        h('label', { for: 'filter-q' }, 'Search'),
        h('input', {
          id: 'filter-q', type: 'search', name: 'q', value: f.q, 'data-key': 'filter-q', autocomplete: 'off',
          placeholder: 'Name, owner, tag', oninput: (e) => update('q', e.target.value),
        })),
      select('status', 'Status', f.status, [['', 'Any status']].concat(enumOptions(Core.PROJECT_STATUSES))),
      select('priority', 'Priority', f.priority, [['', 'Any priority']].concat(enumOptions(Core.PRIORITIES))),
      tags.length ? select('tag', 'Tag', f.tag, [['', 'Any tag']].concat(tags.map((t) => [t, t]))) : null,
      select('sort', 'Sort by', f.sort, Object.entries(Core.SORTS)),
      h('div', { class: 'field-check filter-attention' },
        h('input', {
          type: 'checkbox', id: 'filter-attention', 'data-key': 'filter-attention', checked: f.attention,
          onchange: (e) => update('attention', e.target.checked),
        }),
        h('label', { for: 'filter-attention' }, 'Needs attention only')),
      h('button', {
        type: 'button', class: 'btn btn-quiet', 'data-key': 'filter-clear',
        onclick: () => {
          state.filters = { ...DEFAULT_FILTERS };
          syncFilterUrl();
          render();
          $('#filter-q').focus();
        },
      }, 'Clear filters'));
  }

  function projectCard(project, snap) {
    const p = snap.progress;
    const facts = [
      h('li', {}, confidenceChip(p.confidence)),
      h('li', {}, lastVerifiedText(p.lastVerifiedAt)),
      snap.openBlockers.length ? h('li', { class: 'fact-bad' }, plural(snap.openBlockers.length, 'open blocker')) : null,
      snap.openDecisions.length ? h('li', {}, `${plural(snap.openDecisions.length, 'decision')} waiting`) : null,
      snap.overdueCount ? h('li', { class: 'fact-bad' }, `${snap.overdueCount} overdue`) : null,
    ];
    return h('article', { class: 'card', 'aria-labelledby': `card-${project.id}` },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', id: `card-${project.id}` },
          h('a', { href: `#/project/${encodeURIComponent(project.id)}`, 'data-key': `card:${project.id}` }, project.name)),
        h('div', { class: 'badges' }, statusBadge(project.status), priorityBadge(project.priority))),
      project.summary ? h('p', { class: 'card-summary' }, project.summary) : null,
      progressSummary(p),
      h('ul', { class: 'facts-inline' }, facts),
      snap.nextDue ? h('p', { class: 'card-next' },
        h('span', { class: 'muted' }, 'Next: '), snap.nextDue.title, ' · ', dateEl(snap.nextDue.date),
        ` (${Core.relativeDays(snap.nextDue.daysUntil)})`) : null,
      snap.warnings.map((w) => h('p', { class: 'warning' }, w)));
  }

  function renderResults(container, countEl) {
    clear(container);
    const rows = Core.filterProjects(state.doc.projects, state.filters, now());
    countEl.textContent = `Showing ${rows.length} of ${plural(state.doc.projects.length, 'project')}`;
    if (!rows.length) {
      container.append(h('p', { class: 'empty' }, 'No projects match these filters.'));
      return;
    }
    container.append(h('ul', { class: 'card-grid', role: 'list' },
      rows.map(({ project, snapshot }) => h('li', {}, projectCard(project, snapshot)))));
  }

  function renderProjects(main, route) {
    if (route.params) state.filters = filtersFromParams(route.params);
    main.append(pageTitle('Projects'));
    if (!state.doc.projects.length) {
      if (!state.recovery) main.append(emptyState());
      return 'Projects';
    }
    const results = h('div', { class: 'results' });
    const count = h('p', { class: 'result-count', role: 'status' });
    main.append(summaryStats(), filterForm(() => renderResults(results, count)), count, results);
    renderResults(results, count);
    return 'Projects';
  }

  /* ---------- views: project detail ---------- */

  function sectionHead(id, title, addLabel, onAdd, key) {
    return h('div', { class: 'section-head' },
      h('h2', { id, tabindex: '-1' }, title),
      onAdd ? button(addLabel, onAdd, { key, variant: 'quiet' }) : null);
  }

  function itemActions(children) {
    return h('div', { class: 'item-actions' }, children);
  }

  function milestoneItem(owner, m, info, denominator) {
    const share = denominator > 0 ? Math.round((m.weight / denominator) * 1000) / 10 : 0;
    const k = `${owner.kind}:${owner.id}:${m.id}`;
    return h('li', { class: `item${info.counted ? ' is-counted' : ''}` },
      h('div', { class: 'item-head' },
        h('h3', { class: 'item-title' }, m.title),
        statusBadge(m.status)),
      h('p', { class: `eligibility ${info.counted ? 'counted' : 'not-counted'}` },
        h('span', { 'aria-hidden': 'true' }, info.counted ? '✓ ' : '○ '), Core.ELIGIBILITY[info.reason]),
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', {}, 'Weight'), h('dd', {}, `${m.weight} (${share}% of total)`)),
        m.dueDate ? h('div', {}, h('dt', {}, 'Due'), h('dd', {}, dateEl(m.dueDate), ` (${relativeDate(m.dueDate)})`,
          info.overdue ? [' ', badge('Overdue', 'bad')] : null)) : null,
        h('div', {}, h('dt', {}, 'Verified'), h('dd', {}, m.verifiedAt
          ? [timestampEl(m.verifiedAt), ` (${Core.relativeTime(m.verifiedAt, now())})`]
          : 'Not verified'))),
      m.evidence.length
        ? h('div', { class: 'evidence' }, h('p', { class: 'evidence-label' }, 'Evidence'),
          h('ul', {}, m.evidence.map((e) => h('li', {}, evidenceLink(e)))))
        : h('p', { class: 'muted' }, 'No evidence links'),
      m.notes ? h('p', { class: 'notes' }, m.notes) : null,
      itemActions([
        m.status === 'complete'
          ? button(['Verify now', sr(` (${m.title})`)], () => verifyMilestone(owner, m), { key: `verify:${k}` })
          : null,
        button(['Edit', sr(` milestone: ${m.title}`)], () => milestoneForm(owner, m), { key: `edit-m:${k}` }),
        button(['Delete', sr(` milestone: ${m.title}`)], () => confirmDelete('milestone', m.title, (doc) => {
          const target = findOwner(doc, owner);
          if (!target) return ['This project or slot no longer exists.'];
          target.milestones = target.milestones.filter((x) => x.id !== m.id);
          (target.blockers || []).forEach((b) => { if (b.milestoneId === m.id) b.milestoneId = null; });
          touch(target);
          return null;
        }, { fallback: '#sec-milestones' }), { key: `del-m:${k}`, variant: 'danger' }),
      ]));
  }

  function blockerItem(project, b) {
    const k = `${project.id}:${b.id}`;
    const linked = b.milestoneId ? project.milestones.find((m) => m.id === b.milestoneId) : null;
    return h('li', { class: `item${b.resolved ? ' is-resolved' : ''}` },
      h('p', { class: 'item-text' }, b.description),
      h('p', { class: 'muted small' },
        b.owner ? `Owner: ${b.owner}` : 'No owner',
        b.since ? [' · Since ', dateEl(b.since), ` (${relativeDate(b.since)})`] : null,
        linked ? ` · Blocks: ${linked.title}` : null),
      itemActions([
        button([b.resolved ? 'Reopen' : 'Resolve', sr(` blocker: ${b.description}`)],
          () => toggleListItem(project, 'blockers', b.id, 'resolved', b.resolved ? 'Blocker reopened' : 'Blocker resolved', '#sec-blockers'),
          { key: `toggle-b:${k}` }),
        button(['Edit', sr(` blocker: ${b.description}`)], () => blockerForm(project, b), { key: `edit-b:${k}` }),
        button(['Delete', sr(` blocker: ${b.description}`)], () => confirmDelete('blocker', b.description, (doc) => {
          const target = findProject(doc, project.id);
          if (!target) return ['This project no longer exists.'];
          target.blockers = target.blockers.filter((x) => x.id !== b.id);
          touch(target);
          return null;
        }, { fallback: '#sec-blockers' }), { key: `del-b:${k}`, variant: 'danger' }),
      ]));
  }

  function actionItem(project, a) {
    const k = `${project.id}:${a.id}`;
    const id = `act-${project.id}-${a.id}`;
    const overdue = !a.done && a.dueDate && a.dueDate < Core.localDateString(now());
    return h('li', { class: `item item-action${a.done ? ' is-done' : ''}` },
      h('div', { class: 'field-check' },
        h('input', {
          type: 'checkbox', id, checked: a.done, 'data-key': `toggle-a:${k}`,
          onchange: () => toggleListItem(project, 'nextActions', a.id, 'done', a.done ? 'Action reopened' : 'Action done', '#sec-actions'),
        }),
        h('label', { for: id }, a.text)),
      (a.owner || a.dueDate) ? h('p', { class: 'muted small' },
        a.owner ? `Owner: ${a.owner}` : null,
        a.owner && a.dueDate ? ' · ' : null,
        a.dueDate ? ['Due ', dateEl(a.dueDate), ` (${relativeDate(a.dueDate)})`] : null,
        overdue ? [' ', badge('Overdue', 'bad')] : null) : null,
      itemActions([
        button(['Edit', sr(` action: ${a.text}`)], () => actionForm(project, a), { key: `edit-a:${k}` }),
        button(['Delete', sr(` action: ${a.text}`)], () => confirmDelete('action', a.text, (doc) => {
          const target = findProject(doc, project.id);
          if (!target) return ['This project no longer exists.'];
          target.nextActions = target.nextActions.filter((x) => x.id !== a.id);
          touch(target);
          return null;
        }, { fallback: '#sec-actions' }), { key: `del-a:${k}`, variant: 'danger' }),
      ]));
  }

  function decisionItem(project, d, showProject) {
    const k = `${project.id}:${d.id}`;
    const late = d.status === 'open' && d.neededBy && d.neededBy < Core.localDateString(now());
    return h('li', { class: 'item' },
      h('div', { class: 'item-head' },
        h('h3', { class: 'item-title' }, d.question),
        statusBadge(d.status)),
      showProject ? h('p', { class: 'small' }, 'Project: ',
        h('a', { href: `#/project/${encodeURIComponent(project.id)}` }, project.name)) : null,
      d.neededBy ? h('p', { class: 'small' }, 'Needed by ', dateEl(d.neededBy), ` (${relativeDate(d.neededBy)})`,
        late ? [' ', badge('Overdue', 'bad')] : null) : null,
      d.context ? h('p', { class: 'notes' }, d.context) : null,
      d.options.length ? h('div', { class: 'options' }, h('p', { class: 'evidence-label' }, 'Options'),
        h('ul', {}, d.options.map((o) => h('li', {}, o)))) : null,
      d.status === 'decided' ? h('p', { class: 'decision-text' },
        h('strong', {}, 'Decision: '), d.decision,
        d.decidedAt ? [' ', h('span', { class: 'muted' }, '(', timestampEl(d.decidedAt), ')')] : null) : null,
      itemActions([
        d.status !== 'decided'
          ? button(['Record decision', sr(` (${d.question})`)], () => recordDecisionForm(project, d), { key: `decide:${k}`, variant: 'primary' })
          : null,
        button(['Edit', sr(` decision: ${d.question}`)], () => decisionForm(project, d), { key: `edit-d:${k}` }),
        button(['Delete', sr(` decision: ${d.question}`)], () => confirmDelete('decision', d.question, (doc) => {
          const target = findProject(doc, project.id);
          if (!target) return ['This project no longer exists.'];
          target.decisions = target.decisions.filter((x) => x.id !== d.id);
          touch(target);
          return null;
        }, { fallback: showProject ? '#dec-open' : '#sec-decisions' }), { key: `del-d:${k}`, variant: 'danger' }),
      ]));
  }

  function doneGroup(summaryText, items) {
    if (!items.length) return null;
    return h('details', { class: 'done-group' },
      h('summary', {}, summaryText),
      h('ul', { class: 'items', role: 'list' }, items));
  }

  function renderProject(main, id) {
    const project = findProject(state.doc, id);
    main.append(h('p', { class: 'crumb' }, h('a', { href: '#/' }, h('span', { 'aria-hidden': 'true' }, '← '), 'All projects')));
    if (!project) {
      main.append(pageTitle('Project not found'),
        h('p', {}, 'This project does not exist in the data saved in this browser.'));
      return 'Project not found';
    }
    const snap = Core.projectSnapshot(project, now());
    const p = snap.progress;
    const owner = { kind: 'project', id: project.id };
    const denominator = p.denominator;
    const openBlockers = project.blockers.filter((b) => !b.resolved);
    const resolvedBlockers = project.blockers.filter((b) => b.resolved);
    const openActions = project.nextActions.filter((a) => !a.done);
    const doneActions = project.nextActions.filter((a) => a.done);

    main.append(
      h('header', { class: 'project-head' },
        pageTitle(project.name),
        h('div', { class: 'badges' }, statusBadge(project.status), priorityBadge(project.priority),
          project.tags.map((t) => badge(`#${t}`, 'neutral'))),
        project.summary ? h('p', { class: 'lede' }, project.summary) : null,
        h('p', { class: 'muted small' },
          project.owner ? `Owner: ${project.owner}` : 'No owner',
          project.startDate ? [' · Start ', dateEl(project.startDate)] : null,
          project.dueDate ? [' · Due ', dateEl(project.dueDate), ` (${relativeDate(project.dueDate)})`] : null,
          project.updatedAt ? [' · Updated ', Core.relativeTime(project.updatedAt, now())] : null),
        snap.warnings.map((w) => h('p', { class: 'warning' }, w)),
        h('div', { class: 'button-row' },
          button('Edit project', () => projectForm(project), { key: `edit-p:${project.id}` }),
          button(['Delete project', sr(` (${project.name})`)], () => confirmDelete('project', project.name, (doc) => {
            doc.projects = doc.projects.filter((x) => x.id !== project.id);
            return null;
          }, { after: () => { location.hash = '#/'; } }), { key: `del-p:${project.id}`, variant: 'danger' }))));

    const progressPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-progress' },
      h('h2', { id: 'sec-progress' }, 'Progress'),
      denominator === 0
        ? h('p', {}, 'No weighted milestones yet. Add milestones to measure progress.')
        : h('div', { class: 'progress-big' },
          h('p', { class: 'big-figure' }, h('strong', {}, `${p.percent}%`)),
          h('p', { class: 'fraction' }, h('strong', {}, `${p.numeratorText} / ${p.denominatorText}`),
            ' weight verified complete'),
          progressBar(p.percent)),
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', {}, 'Confidence'), h('dd', {}, confidenceChip(p.confidence),
          h('ul', { class: 'reasons' }, p.confidence.reasons.map((r) => h('li', {}, r))))),
        h('div', {}, h('dt', {}, 'Last verified'), h('dd', {}, p.lastVerifiedAt
          ? [timestampEl(p.lastVerifiedAt), ` (${Core.relativeTime(p.lastVerifiedAt, now())})`]
          : 'Never'))),
      h('details', { class: 'rule' },
        h('summary', {}, 'How completion is calculated'),
        h('p', {}, 'Completion is the weight of eligible complete milestones divided by the weight of all milestones, rounded down. A milestone is eligible only when its status is Complete, it has a verification time, it has at least one http(s) evidence link and no open blocker is linked to it. Blocked and Untested milestones never count.'),
        h('p', {}, `Confidence is High when every counted milestone was verified in the last ${Core.FRESH_DAYS} days and nothing is untested, blocked or overdue; Low when a milestone claims Complete without counting or a counted one was verified more than ${Core.STALE_DAYS} days ago; otherwise Medium.`)));

    const milestonesPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-milestones' },
      sectionHead('sec-milestones', `Milestones (${project.milestones.length})`, 'Add milestone', () => milestoneForm(owner, null), `add-m:project:${project.id}`),
      project.milestones.length
        ? h('ol', { class: 'items', role: 'list' }, project.milestones.map((m, i) => milestoneItem(owner, m, p.milestones[i], denominator)))
        : h('p', { class: 'muted' }, 'No milestones yet.'));

    const blockersPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-blockers' },
      sectionHead('sec-blockers', `Open blockers (${openBlockers.length})`, 'Add blocker', () => blockerForm(project, null), `add-b:${project.id}`),
      openBlockers.length
        ? h('ul', { class: 'items', role: 'list' }, openBlockers.map((b) => blockerItem(project, b)))
        : h('p', { class: 'muted' }, 'Nothing is blocking this project.'),
      doneGroup(`Resolved (${resolvedBlockers.length})`, resolvedBlockers.map((b) => blockerItem(project, b))));

    const actionsPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-actions' },
      sectionHead('sec-actions', `Next actions (${openActions.length})`, 'Add action', () => actionForm(project, null), `add-a:${project.id}`),
      openActions.length
        ? h('ul', { class: 'items', role: 'list' }, openActions.map((a) => actionItem(project, a)))
        : h('p', { class: 'muted' }, 'No open next actions.'),
      doneGroup(`Done (${doneActions.length})`, doneActions.map((a) => actionItem(project, a))));

    const decisionsPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-decisions' },
      sectionHead('sec-decisions', `Decisions (${project.decisions.length})`, 'Add decision', () => decisionForm(project, null), `add-d:${project.id}`),
      project.decisions.length
        ? h('ul', { class: 'items', role: 'list' }, project.decisions.map((d) => decisionItem(project, d, false)))
        : h('p', { class: 'muted' }, 'No decisions recorded.'));

    main.append(h('div', { class: 'detail-grid' },
      h('div', { class: 'detail-main' }, progressPanel, milestonesPanel),
      h('div', { class: 'detail-side' }, blockersPanel, actionsPanel, decisionsPanel)));
    return project.name;
  }

  /* ---------- views: timeline ---------- */

  const TIMELINE_GROUPS = [['overdue', 'Overdue'], ['week', 'Next 7 days'], ['month', '8 to 30 days'], ['later', 'Later']];

  function renderTimelineList(container) {
    clear(container);
    const items = Core.buildTimeline(state.doc.projects, now())
      .filter((i) => !state.timelineKind || i.kind === state.timelineKind);
    if (!items.length) {
      container.append(h('p', { class: 'empty' }, 'Nothing scheduled. Add due dates to milestones, next actions or decisions to see them here.'));
      return;
    }
    for (const [group, title] of TIMELINE_GROUPS) {
      const groupItems = items.filter((i) => i.group === group);
      if (!groupItems.length) continue;
      container.append(h('section', { class: `panel timeline-group tl-${group}`, 'aria-labelledby': `tl-${group}` },
        h('h2', { id: `tl-${group}` }, `${title} (${groupItems.length})`),
        h('ol', { class: 'timeline', role: 'list' }, groupItems.map((item) => h('li', { class: 'tl-item' },
          h('p', { class: 'tl-date' }, dateEl(item.date), h('span', { class: 'muted' }, ` ${Core.relativeDays(item.daysUntil)}`)),
          h('div', { class: 'tl-body' },
            h('p', { class: 'tl-title' }, badge(KIND_LABELS[item.kind], item.kind === 'decision' ? 'warn' : 'neutral'), ' ', item.title),
            h('p', { class: 'small' }, h('a', { href: `#/project/${encodeURIComponent(item.projectId)}` }, item.projectName))))))));
    }
  }

  function renderTimeline(main) {
    main.append(pageTitle('Timeline'),
      h('p', { class: 'lede' }, 'Open dated items across all projects, soonest first. Counted milestones, finished actions and settled decisions drop off.'));
    const list = h('div', { class: 'timeline-groups' });
    main.append(h('form', { class: 'filters panel', role: 'search', 'aria-label': 'Filter timeline', onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'field' },
        h('label', { for: 'tl-kind' }, 'Show'),
        h('select', {
          id: 'tl-kind', 'data-key': 'tl-kind',
          onchange: (e) => { state.timelineKind = e.target.value; renderTimelineList(list); },
        }, [['', 'All items'], ['milestone', 'Milestones'], ['action', 'Next actions'], ['decision', 'Decisions'], ['project', 'Project due dates']]
          .map(([v, t]) => h('option', { value: v, selected: v === state.timelineKind }, t))))), list);
    renderTimelineList(list);
    return 'Timeline';
  }

  /* ---------- views: decisions ---------- */

  function renderDecisions(main) {
    const all = state.doc.projects.flatMap((project) => project.decisions.map((d) => ({ project, d })));
    const byNeeded = (a, b) => (a.d.neededBy || '9999-12-31').localeCompare(b.d.neededBy || '9999-12-31');
    const open = all.filter((x) => x.d.status === 'open').sort(byNeeded);
    const deferred = all.filter((x) => x.d.status === 'deferred').sort(byNeeded);
    const decided = all.filter((x) => x.d.status === 'decided')
      .sort((a, b) => (b.d.decidedAt || '').localeCompare(a.d.decidedAt || ''));
    main.append(pageTitle('Decisions'),
      h('p', { class: 'lede' }, 'Questions waiting on you, across all projects. Recording a decision keeps the choice, rationale and date with the project.'));
    const group = (id, title, rows, emptyText) => h('section', { class: 'panel', 'aria-labelledby': id },
      h('h2', { id, tabindex: '-1' }, `${title} (${rows.length})`),
      rows.length
        ? h('ul', { class: 'items', role: 'list' }, rows.map(({ project, d }) => decisionItem(project, d, true)))
        : h('p', { class: 'muted' }, emptyText));
    main.append(
      group('dec-open', 'Waiting on you', open, 'No open decisions.'),
      group('dec-deferred', 'Deferred', deferred, 'Nothing deferred.'),
      group('dec-decided', 'Decided', decided, 'No decisions recorded yet.'));
    return 'Decisions';
  }

  /* ---------- views: agent slots ---------- */

  const AGENT_TONES = { running: 'info', queued: 'neutral', waiting: 'warn', offline: 'neutral' };
  const agentStatusBadge = (status) => badge(`Recorded: ${Core.label(status)}`, AGENT_TONES[status] || 'neutral');
  const providerBadge = (provider) => (provider ? badge(Core.label(provider), 'neutral') : null);

  function fact(term, value) {
    return h('div', {}, h('dt', {}, term), h('dd', {}, value));
  }

  function checkedText(iso) {
    return iso ? [timestampEl(iso), ` (${Core.relativeTime(iso, now())})`] : 'Never';
  }

  function sessionLink(url) {
    const safe = Core.checkSessionUrl(url).url;
    if (!safe) return h('span', { class: 'muted' }, 'Link removed: not a safe https URL');
    return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' },
      new URL(safe).hostname, sr(' (opens the external session in a new tab)'));
  }

  function connectionLine(view) {
    return h('p', { class: `connection${view.bound ? '' : ' unbound'}` }, view.connection);
  }

  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      announce(`${what} copied to the clipboard`);
    } catch (err) {
      announce('Copy failed. Select the text and copy it manually.');
    }
  }

  function slotForm(slot) {
    formDialog({
      title: `Edit ${slot.name} slot`,
      description: 'Everything in a slot is recorded by you. Saving does not contact, start or check any session.',
      submitLabel: 'Save slot',
      fields: [
        field({
          name: 'sessionUrl', label: 'Session link', type: 'url', inputmode: 'url', value: slot.sessionUrl || '',
          maxlength: Core.LIMITS.urlLength,
          hint: 'https only. Leave empty when no session is running. Links containing tokens or keys are refused because exports are often shared.',
        }),
        field({
          name: 'provider', label: 'Provider', type: 'select', value: slot.provider || '',
          options: [['', 'Not set']].concat(enumOptions(Core.AGENT_PROVIDERS)),
        }),
        field({ name: 'model', label: 'Model', value: slot.model, maxlength: Core.LIMITS.model }),
        field({
          name: 'branch', label: 'Branch', value: slot.branch, maxlength: Core.LIMITS.branch,
          hint: 'Git branch the session works on, for example feature/signup-form.',
        }),
        field({
          name: 'status', label: 'Recorded status', type: 'select', value: slot.status, options: enumOptions(Core.AGENT_STATUSES),
          hint: 'Without a session link only Queued or Offline are allowed. Changing the status or link clears the last check unless you record one now.',
        }),
        field({ name: 'statusNote', label: 'Status note', value: slot.statusNote }),
        field({
          name: 'handoff', label: 'Context handoff', type: 'textarea', rows: 8, maxlength: Core.LIMITS.handoff, value: slot.handoff,
          hint: 'What the next session needs: goal, what is done, what is next, constraints. Never paste secrets: this is saved in this browser and included in exports.',
        }),
        field({ name: 'checkNow', label: 'Record a status check now (I looked at the session)', type: 'checkbox' }),
      ],
      onSubmit: (fd, form) => {
        const invalid = (name) => form.querySelector(`[name="${name}"]`).setAttribute('aria-invalid', 'true');
        const rawUrl = str(fd, 'sessionUrl');
        let sessionUrl = null;
        if (rawUrl) {
          const check = Core.checkSessionUrl(rawUrl);
          if (check.problem) {
            invalid('sessionUrl');
            return { errors: [`Session link ${check.problem}.`] };
          }
          sessionUrl = check.url;
        }
        const status = str(fd, 'status');
        if (!sessionUrl && !Core.UNBOUND_AGENT_STATUSES.includes(status)) {
          invalid('status');
          return { errors: ['Recorded status: with no session link, choose Queued or Offline. Add the session link to record Running or Waiting.'] };
        }
        const branch = str(fd, 'branch');
        if (branch && !Core.isValidBranchName(branch)) {
          invalid('branch');
          return { errors: ['Branch: use letters, digits, ".", "_", "-" and "/" only, for example feature/signup-form.'] };
        }
        const handoff = str(fd, 'handoff');
        const checkNow = checked(fd, 'checkNow');
        return commit((doc) => {
          const target = findSlot(doc, slot.id);
          if (!target) return ['This slot no longer exists.'];
          const changed = target.status !== status || target.sessionUrl !== sessionUrl;
          if (handoff !== target.handoff) target.handoffUpdatedAt = handoff ? now().toISOString() : null;
          Object.assign(target, {
            sessionUrl, provider: str(fd, 'provider') || null, model: str(fd, 'model'), branch, status,
            statusNote: str(fd, 'statusNote'), handoff,
          });
          if (checkNow) target.verifiedAt = now().toISOString();
          else if (changed) target.verifiedAt = null;
          touch(target);
          return null;
        }, `${slot.name} slot saved`);
      },
    });
  }

  async function recordSlotCheck(slot) {
    const ok = await confirmDialog({
      title: 'Record status check?',
      body: [
        h('p', {}, slot.sessionUrl
          ? `Confirm that you just looked at the ${slot.name} session and its status is still ${Core.label(slot.status)}.`
          : `Confirm that the ${slot.name} slot still has no session and its status is still ${Core.label(slot.status)}.`),
        h('p', {}, 'To change the status, use Edit slot instead.'),
      ],
      confirmLabel: 'Record check',
    });
    if (!ok) return;
    commit((doc) => {
      const target = findSlot(doc, slot.id);
      if (!target) return ['This slot no longer exists.'];
      target.verifiedAt = now().toISOString();
      touch(target);
      return null;
    }, `Status check recorded for ${slot.name}`);
  }

  async function resetSlot(slot) {
    const ok = await confirmDialog({
      title: `Reset the ${slot.name} slot?`,
      body: h('p', {}, 'The session link, provider, model, branch, status, milestones and handoff will be cleared so the slot can be reused. Export first if you want to keep them.'),
      confirmLabel: 'Reset slot',
      variant: 'danger',
    });
    if (!ok) return;
    commit((doc) => {
      const target = findSlot(doc, slot.id);
      if (!target) return ['This slot no longer exists.'];
      Object.assign(target, Core.defaultAgentSlots().find((d) => d.id === slot.id));
      touch(target);
      return null;
    }, `${slot.name} slot reset`);
  }

  function slotCard(slot, view) {
    return h('article', { class: 'card', 'aria-labelledby': `slot-${slot.id}` },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', id: `slot-${slot.id}` },
          h('a', { href: `#/agent/${encodeURIComponent(slot.id)}`, 'data-key': `slot:${slot.id}` }, slot.name)),
        h('div', { class: 'badges' }, agentStatusBadge(slot.status), providerBadge(slot.provider))),
      connectionLine(view),
      slot.statusNote ? h('p', { class: 'card-summary' }, slot.statusNote) : null,
      h('ul', { class: 'facts-inline' },
        slot.model ? h('li', {}, `Model: ${slot.model}`) : null,
        slot.branch ? h('li', {}, 'Branch: ', h('code', {}, slot.branch)) : null,
        h('li', {}, slot.verifiedAt ? ['Last checked ', Core.relativeTime(slot.verifiedAt, now())] : 'Never checked')),
      view.freshness ? h('p', { class: 'warning' }, view.freshness) : null,
      view.progress.denominator > 0 ? progressSummary(view.progress) : h('p', { class: 'muted small' }, 'No slot milestones'));
  }

  function renderAgents(main) {
    main.append(pageTitle('Agent slots'),
      h('p', { class: 'lede' }, 'Records you keep about Claude, Codex or other agent sessions that run elsewhere. Project Cockpit does not connect to, start or monitor any session: every link, status and check here was entered by a person.'));
    main.append(h('ul', { class: 'card-grid', role: 'list' },
      state.doc.agentSlots.map((slot) => h('li', {}, slotCard(slot, Core.agentSlotView(slot, now()))))));
    return 'Agent slots';
  }

  function renderAgent(main, id) {
    const slot = findSlot(state.doc, id);
    main.append(h('p', { class: 'crumb' }, h('a', { href: '#/agents' }, h('span', { 'aria-hidden': 'true' }, '← '), 'All agent slots')));
    if (!slot) {
      main.append(pageTitle('Slot not found'),
        h('p', {}, `The available slots are ${Core.AGENT_SLOTS.map((d) => d.name).join(', ')}.`));
      return 'Slot not found';
    }
    const view = Core.agentSlotView(slot, now());
    const p = view.progress;
    const owner = { kind: 'slot', id: slot.id };
    main.append(h('header', { class: 'project-head' },
      pageTitle(`${slot.name} slot`),
      h('div', { class: 'badges' }, agentStatusBadge(slot.status), providerBadge(slot.provider)),
      connectionLine(view),
      view.freshness ? h('p', { class: 'warning' }, view.freshness) : null,
      h('div', { class: 'button-row' },
        button('Edit slot', () => slotForm(slot), { key: `edit-slot:${slot.id}`, variant: 'primary' }),
        button('Record status check', () => recordSlotCheck(slot), { key: `check-slot:${slot.id}` }),
        button(['Reset slot', sr(` (${slot.name})`)], () => resetSlot(slot), { key: `reset-slot:${slot.id}`, variant: 'danger' }))));

    const sessionPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-session' },
      h('h2', { id: 'sec-session', tabindex: '-1' }, 'Session record'),
      h('dl', { class: 'facts' },
        fact('Session link', view.bound ? sessionLink(slot.sessionUrl) : 'No session connected'),
        fact('Provider', slot.provider ? Core.label(slot.provider) : 'Not set'),
        fact('Model', slot.model || 'Not set'),
        fact('Branch', slot.branch ? h('code', {}, slot.branch) : 'Not set'),
        fact('Recorded status', [Core.label(slot.status), slot.statusNote ? h('span', { class: 'muted' }, ` · ${slot.statusNote}`) : null]),
        fact('Last checked', checkedText(slot.verifiedAt)),
        fact('Record updated', slot.updatedAt ? Core.relativeTime(slot.updatedAt, now()) : 'Never')),
      h('p', { class: 'muted small' }, 'Opening the link takes you to the external session. Nothing is fetched from it.'));

    const handoffPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-handoff' },
      h('div', { class: 'section-head' },
        h('h2', { id: 'sec-handoff', tabindex: '-1' }, 'Context handoff'),
        slot.handoff ? button('Copy handoff', () => copyText(slot.handoff, 'Handoff'), { key: `copy-handoff:${slot.id}`, variant: 'quiet' }) : null),
      slot.handoff
        ? [h('p', { class: 'handoff' }, slot.handoff),
          slot.handoffUpdatedAt ? h('p', { class: 'muted small' }, 'Saved ', timestampEl(slot.handoffUpdatedAt)) : null]
        : h('p', { class: 'muted' }, 'No handoff saved. Use Edit slot to write the context the next session should start from.'));

    const milestonesPanel = h('section', { class: 'panel', 'aria-labelledby': 'sec-milestones' },
      sectionHead('sec-milestones', `Slot milestones (${slot.milestones.length})`, 'Add milestone', () => milestoneForm(owner, null), `add-m:slot:${slot.id}`),
      p.denominator > 0 ? h('div', { class: 'progress-big' },
        h('p', { class: 'fraction' }, h('strong', {}, `${p.numeratorText} / ${p.denominatorText}`), ` weight verified complete (${p.percent}%)`),
        progressBar(p.percent),
        h('p', {}, confidenceChip(p.confidence))) : null,
      slot.milestones.length
        ? h('ol', { class: 'items', role: 'list' }, slot.milestones.map((m, i) => milestoneItem(owner, m, p.milestones[i], p.denominator)))
        : h('p', { class: 'muted' }, 'No milestones for this slot yet. They follow the same rule as project milestones.'));

    main.append(h('div', { class: 'detail-grid' },
      h('div', { class: 'detail-main' }, sessionPanel, milestonesPanel),
      h('div', { class: 'detail-side' }, handoffPanel)));
    return `${slot.name} slot`;
  }

  /* ---------- startup ---------- */

  function wireChrome() {
    const menu = $('#data-menu');
    const closeMenu = () => { menu.open = false; };
    $('#btn-new-project').addEventListener('click', () => projectForm(null));
    $('#btn-import').addEventListener('click', () => { closeMenu(); $('#import-file').click(); });
    $('#btn-export').addEventListener('click', () => { closeMenu(); exportJson(); });
    $('#btn-sample').addEventListener('click', () => { closeMenu(); loadSample(); });
    $('#btn-delete-all').addEventListener('click', () => { closeMenu(); deleteAll(); });
    $('#import-file').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      importFile(file);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.open) {
        closeMenu();
        menu.querySelector('summary').focus();
      }
    });
    document.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target)) closeMenu();
    });
    $('#dialog').addEventListener('close', () => {
      // close events are queued; ignore a late one if another dialog is already open.
      if ($('#dialog').open) return;
      clear($('#dialog'));
      restoreFocus();
    });
    $('.skip-link').addEventListener('click', (event) => {
      event.preventDefault();
      const heading = $('#page-title');
      if (heading) heading.focus();
      else $('#main').focus();
    });
    window.addEventListener('hashchange', () => {
      closeDialog();
      render({ focusHeading: true });
    });
  }

  async function init() {
    // A custom adapter can be supplied by a script loaded before this one:
    // window.CockpitConfig = { storageAdapter: myAdapter }. See docs/STORAGE.md.
    const config = window.CockpitConfig || {};
    if (config.storageAdapter) {
      state.adapter = Store.assertAdapter(config.storageAdapter);
      state.durable = config.durable !== false;
    } else {
      const picked = Store.createDefaultAdapter();
      state.adapter = Store.assertAdapter(picked.adapter);
      state.durable = picked.durable;
    }
    wireChrome();
    await loadFromAdapter();
    if (typeof state.adapter.subscribe === 'function') {
      state.adapter.subscribe(async () => {
        await loadFromAdapter();
        render();
        announce('Data updated from another tab');
      });
    }
    render();
    document.documentElement.dataset.ready = 'true';
  }

  init();
}());
