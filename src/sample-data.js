/*
 * Fictional sample data. Every project, person, team and link here is made
 * up; links point at the reserved example.com / example.org domains.
 * Dates are generated relative to "now" so the demo never goes stale.
 */
(function (root, factory) {
  'use strict';
  const api = factory(root.CockpitCore || (typeof require === 'function' ? require('./core.js') : null));
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CockpitSample = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;

  function buildSampleDocument(nowInput) {
    const now = nowInput instanceof Date ? nowInput : new Date(nowInput || Date.now());
    const day = (offset) => Core.localDateString(new Date(now.getTime() + offset * DAY_MS));
    const ago = (days) => new Date(now.getTime() - days * DAY_MS - 2 * 60 * 60 * 1000).toISOString();

    return {
      schema: Core.SCHEMA_ID,
      version: Core.SCHEMA_VERSION,
      projects: [
        {
          id: 'garden-signup',
          name: 'Garden plot signup site',
          summary: 'Online waitlist and plot signup for a neighborhood garden (fictional example).',
          owner: 'You',
          status: 'active',
          priority: 'high',
          tags: ['web', 'volunteers'],
          startDate: day(-40),
          dueDate: day(21),
          updatedAt: ago(1),
          milestones: [
            {
              id: 'm-requirements', title: 'Requirements agreed with coordinators', weight: 10, status: 'complete',
              dueDate: day(-30), verifiedAt: ago(3),
              evidence: [{ label: 'Requirements notes', url: 'https://example.com/garden/requirements' }],
              notes: '',
            },
            {
              id: 'm-form', title: 'Signup form live on staging', weight: 25, status: 'complete',
              dueDate: day(-7), verifiedAt: ago(5),
              evidence: [
                { label: 'Staging form', url: 'https://staging.example.com/garden/signup' },
                { label: 'Form test checklist', url: 'https://example.com/garden/tests/signup-form' },
              ],
              notes: '',
            },
            {
              id: 'm-waitlist', title: 'Waitlist ordering logic', weight: 20, status: 'untested',
              dueDate: day(4), verifiedAt: null, evidence: [],
              notes: 'Built. Needs a test pass with 30 sample signups before it can count.',
            },
            {
              id: 'm-a11y', title: 'Accessibility review', weight: 15, status: 'in_progress',
              dueDate: day(10), verifiedAt: null, evidence: [], notes: '',
            },
            {
              id: 'm-plots', title: 'Plot map imported', weight: 20, status: 'blocked',
              dueDate: day(12), verifiedAt: null, evidence: [], notes: '',
            },
            {
              id: 'm-launch', title: 'Launch announcement sent', weight: 10, status: 'not_started',
              dueDate: day(21), verifiedAt: null, evidence: [], notes: '',
            },
          ],
          blockers: [
            {
              id: 'b-plotmap', description: 'Waiting on the final plot map from the garden coordinator.',
              owner: 'Coordinator', since: day(-6), milestoneId: 'm-plots', resolved: false,
            },
          ],
          nextActions: [
            { id: 'a-testdata', text: 'Create 30 sample signups and run the waitlist test', owner: 'You', dueDate: day(2), done: false },
            { id: 'a-contrast', text: 'Fix the low-contrast button flagged in review', owner: 'Design', dueDate: day(6), done: false },
            { id: 'a-copy', text: 'Draft launch announcement copy', owner: 'You', dueDate: null, done: true },
          ],
          decisions: [
            {
              id: 'd-notify',
              question: 'Notify waitlisted gardeners by email only, or email plus text message?',
              context: 'Text messages would need a paid gateway. Email is free.',
              options: ['Email only', 'Email plus text message'],
              status: 'open', decision: '', neededBy: day(3), decidedAt: null,
            },
          ],
        },
        {
          id: 'field-notes',
          name: 'Field notes mobile app',
          summary: 'Offline-first note taking for survey volunteers (fictional example).',
          owner: 'Mobile team',
          status: 'active',
          priority: 'medium',
          tags: ['mobile', 'offline'],
          startDate: day(-60),
          dueDate: day(45),
          updatedAt: ago(2),
          milestones: [
            {
              id: 'm-sync', title: 'Offline storage and sync design', weight: 15, status: 'complete',
              dueDate: day(-35), verifiedAt: ago(20),
              evidence: [{ label: 'Design notes', url: 'https://example.org/field-notes/sync-design' }],
              notes: '',
            },
            {
              id: 'm-capture', title: 'Photo capture screen', weight: 20, status: 'complete',
              dueDate: day(-10), verifiedAt: null,
              evidence: [{ label: 'Build preview', url: 'https://example.org/field-notes/builds/capture' }],
              notes: 'Marked complete by the team but nobody has verified it yet.',
            },
            {
              id: 'm-export', title: 'CSV export', weight: 15, status: 'complete',
              dueDate: day(-5), verifiedAt: ago(2), evidence: [], notes: 'Verified on one device; evidence link still missing.',
            },
            {
              id: 'm-beta', title: 'Closed beta with 5 volunteers', weight: 30, status: 'not_started',
              dueDate: day(30), verifiedAt: null, evidence: [], notes: '',
            },
            {
              id: 'm-store', title: 'App store listing prepared', weight: 20, status: 'in_progress',
              dueDate: day(-2), verifiedAt: null, evidence: [], notes: '',
            },
          ],
          blockers: [
            {
              id: 'b-devices', description: 'Test devices had not arrived.', owner: 'Mobile team',
              since: day(-25), milestoneId: null, resolved: true,
            },
          ],
          nextActions: [
            { id: 'a-verify-capture', text: 'Verify photo capture on two older phones', owner: 'You', dueDate: day(1), done: false },
            { id: 'a-csv-evidence', text: 'Attach a sample CSV as evidence for the export milestone', owner: 'Mobile team', dueDate: day(1), done: false },
          ],
          decisions: [
            {
              id: 'd-platform',
              question: 'Ship Android first, or both platforms together?',
              context: '',
              options: ['Android first', 'Both together'],
              status: 'decided', decision: 'Android first: most volunteers use Android phones.',
              neededBy: day(-12), decidedAt: ago(9),
            },
          ],
        },
        {
          id: 'label-printer',
          name: 'Warehouse label printer migration',
          summary: 'Move shipping-label printing to new thermal printers (fictional example).',
          owner: 'Ops',
          status: 'blocked',
          priority: 'high',
          tags: ['operations', 'hardware'],
          startDate: day(-50),
          dueDate: day(14),
          updatedAt: ago(4),
          milestones: [
            {
              id: 'm-inventory', title: 'Printer inventory and locations', weight: 10, status: 'complete',
              dueDate: day(-45), verifiedAt: ago(40),
              evidence: [{ label: 'Inventory sheet', url: 'https://example.com/ops/printer-inventory' }],
              notes: '',
            },
            {
              id: 'm-driver', title: 'Driver installed on packing stations', weight: 40, status: 'blocked',
              dueDate: day(3), verifiedAt: null, evidence: [], notes: '',
            },
            {
              id: 'm-templates', title: 'Label templates converted', weight: 30, status: 'untested',
              dueDate: day(8), verifiedAt: null, evidence: [], notes: '',
            },
            {
              id: 'm-cutover', title: 'Cutover and old printers retired', weight: 20, status: 'not_started',
              dueDate: day(14), verifiedAt: null, evidence: [], notes: '',
            },
          ],
          blockers: [
            {
              id: 'b-driver', description: 'Printer driver for the new station operating system is not available yet.',
              owner: 'Ops', since: day(-12), milestoneId: 'm-driver', resolved: false,
            },
          ],
          nextActions: [
            { id: 'a-vendor', text: 'Ask vendor support for a driver release date', owner: 'Ops', dueDate: day(-1), done: false },
            { id: 'a-recheck', text: 'Re-check printer inventory (last check is over a month old)', owner: 'Ops', dueDate: day(5), done: false },
          ],
          decisions: [
            {
              id: 'd-fallback',
              question: 'Rent temporary printers if the driver slips past next week?',
              context: 'Renting keeps shipping on schedule but adds a short-term cost.',
              options: ['Rent temporary printers', 'Wait for the driver'],
              status: 'open', decision: '', neededBy: day(7), decidedAt: null,
            },
          ],
        },
        {
          id: 'newsletter',
          name: 'Quarterly volunteer newsletter',
          summary: 'Plan, write and send the autumn newsletter (fictional example).',
          owner: 'Comms',
          status: 'done',
          priority: 'low',
          tags: ['comms', 'volunteers'],
          startDate: day(-30),
          dueDate: day(-5),
          updatedAt: ago(5),
          milestones: [
            {
              id: 'm-outline', title: 'Outline approved', weight: 20, status: 'complete',
              dueDate: day(-20), verifiedAt: ago(12),
              evidence: [{ label: 'Approved outline', url: 'https://example.com/newsletter/outline' }], notes: '',
            },
            {
              id: 'm-draft', title: 'Draft written and edited', weight: 50, status: 'complete',
              dueDate: day(-10), verifiedAt: ago(8),
              evidence: [{ label: 'Final draft', url: 'https://example.com/newsletter/draft-final' }], notes: '',
            },
            {
              id: 'm-send', title: 'Sent to mailing list', weight: 30, status: 'complete',
              dueDate: day(-5), verifiedAt: ago(5),
              evidence: [{ label: 'Sent copy', url: 'https://example.com/newsletter/sent' }], notes: '',
            },
          ],
          blockers: [],
          nextActions: [],
          decisions: [],
        },
        {
          id: 'bike-workshop',
          name: 'Bike repair workshop booking',
          summary: 'Simple booking page for monthly repair workshops (fictional example).',
          owner: 'You',
          status: 'planned',
          priority: 'medium',
          tags: ['web', 'events'],
          startDate: day(14),
          dueDate: day(75),
          updatedAt: ago(6),
          milestones: [],
          blockers: [],
          nextActions: [
            { id: 'a-scope', text: 'Write a one-paragraph scope for the booking page', owner: 'You', dueDate: day(16), done: false },
          ],
          decisions: [
            {
              id: 'd-tool',
              question: 'Use a shared spreadsheet or a booking form for sign-ups?',
              context: 'Revisit after the garden launch.',
              options: ['Shared spreadsheet', 'Booking form'],
              status: 'deferred', decision: '', neededBy: null, decidedAt: null,
            },
          ],
        },
      ],
    };
  }

  return Object.freeze({ buildSampleDocument });
});
