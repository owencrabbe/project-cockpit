'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../../src/core.js');
const { openApp, loadSample, chooseImport, importAndConfirm } = require('./helpers');

const PAYLOADS = [
  '<img src=x onerror="window.__xss=1">',
  '<script>window.__xss=2</script>',
  '"><svg onload="window.__xss=3">',
  '<a href="javascript:window.__xss=4">click</a>',
];

function xssDocument() {
  const [p0, p1, p2, p3] = PAYLOADS;
  return {
    schema: 'project-cockpit',
    version: 1,
    projects: [{
      id: 'xss', name: p0, summary: p1, owner: p2, status: 'active', tags: ['<b>tag</b>'], dueDate: '2026-12-01',
      milestones: [{
        id: 'm1', title: p2, weight: 5, status: 'complete', verifiedAt: '2026-01-01T00:00:00Z', dueDate: '2026-11-01',
        evidence: [{ label: p3, url: 'https://example.com/?q=<script>alert(1)</script>' }], notes: p1,
      }],
      blockers: [{ id: 'b1', description: p0, owner: p3, milestoneId: 'm1', resolved: false }],
      nextActions: [{ id: 'a1', text: p1, owner: p2, dueDate: '2026-11-02', done: false }],
      decisions: [{ id: 'd1', question: p3, context: p0, options: [p1, p2], status: 'open', neededBy: '2026-11-03' }],
    }],
  };
}

async function countInjected(page) {
  return page.evaluate(() => ({
    img: document.querySelectorAll('img').length,
    svg: document.querySelectorAll('svg').length,
    script: document.querySelectorAll('script').length,
    iframe: document.querySelectorAll('iframe').length,
    jsLinks: Array.from(document.querySelectorAll('a[href]')).filter((a) => !/^(https?:|#)/.test(a.getAttribute('href'))).length,
    xss: window.__xss === undefined ? null : window.__xss,
  }));
}

test('imported HTML/script payloads render as inert text in every view', async ({ page }) => {
  const app = await openApp(page);
  await importAndConfirm(page, JSON.stringify(xssDocument()));
  const clean = { img: 0, svg: 0, script: 4, iframe: 0, jsLinks: 0, xss: null };
  expect(await countInjected(page)).toEqual(clean);
  await expect(page.getByRole('heading', { level: 2, name: PAYLOADS[0] })).toBeVisible();
  await page.getByRole('link', { name: PAYLOADS[0] }).click();
  await expect(page.getByRole('heading', { level: 1, name: PAYLOADS[0] })).toBeVisible();
  await expect(page.getByText(PAYLOADS[1]).first()).toBeVisible();
  expect(await countInjected(page)).toEqual(clean);
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Timeline' }).click();
  expect(await countInjected(page)).toEqual(clean);
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Decisions' }).click();
  expect(await countInjected(page)).toEqual(clean);
  await page.getByRole('button', { name: /^Edit decision/ }).click();
  expect(await countInjected(page)).toEqual(clean);
  expect(await page.title()).toBe('Decisions · Project Cockpit');
  await app.assertClean();
});

test('import with a javascript: evidence URL is rejected and nothing changes', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  const before = await page.evaluate(() => localStorage.getItem('project-cockpit:v1'));
  const bad = xssDocument();
  bad.projects[0].milestones[0].evidence[0].url = 'javascript:window.__xss=9';
  await chooseImport(page, JSON.stringify(bad));
  const dialog = page.getByRole('dialog', { name: 'Import failed: nothing was changed' });
  await expect(dialog).toContainText('$.projects[0].milestones[0].evidence[0].url: must be an absolute http:// or https:// URL');
  await dialog.getByRole('button', { name: 'Close' }).click();
  expect(await page.evaluate(() => localStorage.getItem('project-cockpit:v1'))).toBe(before);
  await expect(page.getByRole('heading', { level: 2, name: 'Garden plot signup site' })).toBeVisible();
  await app.assertClean();
});

test('oversized, malformed and wrong-schema files are rejected with a reason', async ({ page }) => {
  const app = await openApp(page);
  const dialog = page.getByRole('dialog', { name: 'Import failed: nothing was changed' });
  const cases = [
    [`{"schema":"project-cockpit","version":1,"projects":[]}${' '.repeat(2 * 1024 * 1024)}`, /the limit is 2\.00 MiB/],
    ['{"schema": "project-cockpit", ', /not valid JSON/],
    ['{"schema":"project-cockpit","version":1,"projects":[{"id":"p","name":"P","status":"active","milestones":[{"id":"m","title":"M","weight":-1,"status":"complete"}]}]}', /weight: must be greater than 0/],
    ['{"schema":"project-cockpit","version":1,"projects":[{"id":"p","name":"P","status":"finished"}]}', /status: must be one of/],
    ['{"schema":"something-else","version":1,"projects":[]}', /schema: must be "project-cockpit"/],
  ];
  for (const [text, pattern] of cases) {
    await chooseImport(page, text);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.issue-list')).toContainText(pattern);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  }
  expect(await page.evaluate(() => localStorage.getItem('project-cockpit:v1'))).toBeNull();
  await app.assertClean();
});

test('evidence links are http(s) only and open safely', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await page.getByRole('link', { name: 'Garden plot signup site' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Garden plot signup site' })).toBeVisible();
  const links = await page.locator('a[target="_blank"]').evaluateAll((els) => els.map((a) => ({
    href: a.getAttribute('href'), rel: a.getAttribute('rel'), referrer: a.getAttribute('referrerpolicy'),
  })));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.href).toMatch(/^https?:\/\//);
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
    expect(link.referrer).toBe('no-referrer');
  }
  await app.assertClean();
});

test('milestone form refuses non-http(s) evidence URLs', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await page.getByRole('link', { name: 'Garden plot signup site' }).click();
  await page.getByRole('button', { name: 'Add milestone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add milestone' });
  await dialog.getByLabel('Title').fill('Sneaky');
  await dialog.getByLabel('Weight').fill('5');
  await dialog.getByRole('button', { name: 'Add evidence link' }).click();
  await dialog.getByLabel('URL (http or https)').fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: 'Add milestone' }).click();
  await expect(dialog.getByRole('alert')).toContainText('is not an absolute http or https URL');
  await expect(dialog.getByLabel('URL (http or https)')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('URL (http or https)').fill('https://example.com/proof');
  await dialog.getByRole('button', { name: 'Add milestone' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { level: 3, name: 'Sneaky' })).toBeVisible();
  await app.assertClean();
});

test('data persists across reloads and syncs to other tabs', async ({ page, context }) => {
  const app = await openApp(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.waitForSelector('html[data-ready="true"]');
  await expect(other.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await loadSample(page);
  await expect(other.getByRole('heading', { level: 2, name: 'Garden plot signup site' })).toBeVisible();
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.getByRole('heading', { level: 2, name: 'Garden plot signup site' })).toBeVisible();
  await expect(page.locator('#storage-name')).toHaveText('This browser (localStorage)');
  await app.assertClean();
});

test('corrupted saved data is kept untouched until the user decides', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('project-cockpit:v1', '{"schema":"project-cockpit","version":1,"projects":[{"id":"p"'));
  const app = await openApp(page);
  const alert = page.getByRole('alert').filter({ hasText: 'Saved data could not be loaded' });
  await expect(alert).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill('Should not save');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Saved data needs attention first');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => localStorage.getItem('project-cockpit:v1'))).toBe('{"schema":"project-cockpit","version":1,"projects":[{"id":"p"');
  await alert.getByRole('button', { name: 'Discard saved data' }).click();
  await page.getByRole('dialog', { name: 'Discard unreadable saved data?' }).getByRole('button', { name: 'Discard saved data' }).click();
  await expect(alert).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('project-cockpit:v1'))).toBeNull();
  await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
  await app.assertClean();
});

test('export downloads a file that re-validates', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await page.locator('#data-menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^project-cockpit-\d{4}-\d{2}-\d{2}\.json$/);
  const text = fs.readFileSync(await download.path(), 'utf8');
  const result = Core.parseDocumentText(text);
  expect(result.errors).toEqual([]);
  expect(result.data.projects.map((p) => p.id)).toEqual(['garden-signup', 'field-notes', 'label-printer', 'newsletter', 'bike-workshop']);
  await app.assertClean();
});

test('a custom storage adapter supplied via window.CockpitConfig is used', async ({ page }) => {
  await page.addInitScript(() => {
    const saved = [];
    window.__savedByCustomAdapter = saved;
    window.CockpitConfig = {
      storageAdapter: {
        name: 'Test adapter',
        isAvailable: () => true,
        load: async () => null,
        save: async (text) => { saved.push(text.length); },
        clear: async () => {},
      },
    };
  });
  const app = await openApp(page);
  await expect(page.locator('#storage-name')).toHaveText('Test adapter');
  await loadSample(page);
  await expect.poll(() => page.evaluate(() => window.__savedByCustomAdapter.length)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('project-cockpit:v1'))).toBeNull();
  await app.assertClean();
});

test('runs straight from the file system (file://) under the same CSP', async ({ page }) => {
  const url = `file://${path.join(__dirname, '..', '..', 'index.html')}`;
  const app = await openApp(page, url);
  await loadSample(page);
  await page.getByRole('link', { name: 'Garden plot signup site' }).click();
  await expect(page.getByRole('region', { name: 'Progress' }).locator('.big-figure')).toHaveText('35%');
  await app.assertClean();
});
