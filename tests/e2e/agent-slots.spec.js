'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../../src/core.js');
const { openApp, loadSample, chooseImport, importAndConfirm } = require('./helpers');

const SLOT_NAMES = ['Studio', 'Security', 'Research', 'Hackathon', 'QA'];

async function gotoAgents(page) {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Agents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent slots' })).toBeVisible();
}

async function openSlot(page, name) {
  await gotoAgents(page);
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${name} slot` })).toBeVisible();
}

async function saveSlot(page, values) {
  await page.getByRole('button', { name: 'Edit slot' }).click();
  const dialog = page.getByRole('dialog', { name: /^Edit .* slot$/ });
  if (values.url !== undefined) await dialog.getByLabel('Session link').fill(values.url);
  if (values.provider) await dialog.getByLabel('Provider').selectOption(values.provider);
  if (values.model !== undefined) await dialog.getByLabel('Model').fill(values.model);
  if (values.branch !== undefined) await dialog.getByLabel('Branch').fill(values.branch);
  if (values.status) await dialog.getByLabel('Recorded status').selectOption(values.status);
  if (values.handoff !== undefined) await dialog.getByLabel('Context handoff').fill(values.handoff);
  if (values.checkNow) await dialog.getByLabel('Record a status check now').check();
  await dialog.getByRole('button', { name: 'Save slot' }).click();
  return dialog;
}

test('a fresh cockpit shows five unbound slots that say no session is connected', async ({ page }) => {
  const app = await openApp(page);
  await gotoAgents(page);
  await expect(page.getByText('does not connect to, start or monitor any session')).toBeVisible();
  const cards = page.locator('article.card');
  await expect(cards).toHaveCount(5);
  for (const name of SLOT_NAMES) {
    const card = cards.filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });
    await expect(card.getByText('No session connected')).toBeVisible();
    await expect(card.getByText('Recorded: Offline')).toBeVisible();
    await expect(card.getByText('Never checked')).toBeVisible();
  }
  // "connected" only ever appears as "No session connected".
  const text = await page.locator('main').innerText();
  expect((text.match(/connected/gi) || []).length).toBe((text.match(/No session connected/g) || []).length);
  await app.assertClean();
});

test('slot form validates session links, status and branch before saving', async ({ page }) => {
  const app = await openApp(page);
  await openSlot(page, 'Research');
  const dialog = await saveSlot(page, { status: 'running' });
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('with no session link, choose Queued or Offline');
  await expect(dialog.getByLabel('Recorded status')).toHaveAttribute('aria-invalid', 'true');
  const cases = [
    ['http://agents.example.com/sessions/r1', 'must be an absolute https:// URL'],
    ['javascript:alert(1)', 'must be an absolute https:// URL'],
    ['https://agents.example.com/sessions/r1?token=abc', 'must not include tokens'],
    ['https://agents.example.com/sessions/r1#access_token=abc', 'must not include tokens'],
  ];
  for (const [url, message] of cases) {
    await dialog.getByLabel('Session link').fill(url);
    await dialog.getByRole('button', { name: 'Save slot' }).click();
    await expect(alert).toContainText(message);
    await expect(dialog.getByLabel('Session link')).toHaveAttribute('aria-invalid', 'true');
  }
  await dialog.getByLabel('Session link').fill('https://agents.example.com/sessions/research-demo');
  await dialog.getByLabel('Branch').fill('bad branch');
  await dialog.getByRole('button', { name: 'Save slot' }).click();
  await expect(alert).toContainText('Branch: use letters, digits');
  await dialog.getByLabel('Branch').fill('research/waitlist-options');
  await dialog.getByLabel('Provider').selectOption('claude');
  await dialog.getByLabel('Model').fill('placeholder-model-a');
  await dialog.getByRole('button', { name: 'Save slot' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText('Session link recorded manually (not monitored)')).toBeVisible();
  await expect(page.getByText('Recorded: Running')).toBeVisible();
  await expect(page.getByText('Recorded status has never been checked against the session')).toBeVisible();
  const link = page.getByRole('link', { name: /agents\.example\.com/ });
  await expect(link).toHaveAttribute('href', 'https://agents.example.com/sessions/research-demo');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.getByRole('heading', { level: 1, name: 'Research slot' })).toBeVisible();
  await expect(page.locator('code', { hasText: 'research/waitlist-options' })).toBeVisible();
  await app.assertClean();
});

test('status changes clear the last check; recorded checks age into a stale warning', async ({ page }) => {
  const t0 = new Date('2026-10-02T09:00:00Z');
  await page.clock.setFixedTime(t0);
  const app = await openApp(page);
  await loadSample(page);
  await openSlot(page, 'Studio');
  const session = page.getByRole('region', { name: 'Session record' });
  await expect(session.getByText('(2 hours ago)')).toBeVisible();
  await saveSlot(page, { status: 'waiting' });
  await expect(session.locator('dd').filter({ hasText: /^Never$/ })).toHaveCount(1);
  await expect(page.getByText('Recorded status has never been checked against the session')).toBeVisible();
  await page.getByRole('button', { name: 'Record status check' }).click();
  await page.getByRole('dialog', { name: 'Record status check?' }).getByRole('button', { name: 'Record check' }).click();
  await expect(session.locator('time').first()).toHaveAttribute('datetime', t0.toISOString());
  await expect(page.locator('.warning')).toHaveCount(0);
  await page.clock.setFixedTime(new Date(t0.getTime() + 26 * 60 * 60 * 1000));
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.getByText(/Recorded status was last checked 1 day ago and may be out of date/)).toBeVisible();
  await app.assertClean();
});

test('slot milestones follow the same eligibility rule as projects', async ({ page }) => {
  const app = await openApp(page);
  await openSlot(page, 'Hackathon');
  const add = async (title, weight, status) => {
    await page.getByRole('button', { name: 'Add milestone' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add milestone' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Weight').fill(String(weight));
    await dialog.getByLabel('Status').selectOption(status);
    await dialog.getByRole('button', { name: 'Add evidence link' }).click();
    await dialog.getByLabel('URL (http or https)').fill('https://example.com/demo');
    await dialog.getByLabel('Record verification now').check();
    await dialog.getByRole('button', { name: 'Add milestone' }).click();
    await expect(dialog).toBeHidden();
  };
  await add('Demo recorded', 60, 'complete');
  await add('Judging feedback', 40, 'untested');
  const panel = page.getByRole('region', { name: /Slot milestones/ });
  await expect(panel.locator('.fraction')).toHaveText('60 / 100 weight verified complete (60%)');
  await expect(panel.getByText('Untested: never counts as complete')).toBeVisible();
  await gotoAgents(page);
  const card = page.locator('article.card').filter({ has: page.getByRole('heading', { level: 2, name: 'Hackathon' }) });
  await expect(card.locator('.progress-fraction')).toHaveText('60 / 100 weight verified complete');
  await app.assertClean();
});

test('context handoff is saved as plain text and can be copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const app = await openApp(page);
  await openSlot(page, 'QA');
  const handoff = 'Goal: test the label templates (fictional).\n<img src=x onerror="window.__xss=1">\nNext: print a sample.';
  await saveSlot(page, { handoff });
  const panel = page.getByRole('region', { name: 'Context handoff' });
  await expect(panel.locator('.handoff')).toHaveText(handoff);
  expect(await page.evaluate(() => ({ img: document.querySelectorAll('img').length, xss: window.__xss || null }))).toEqual({ img: 0, xss: null });
  await panel.getByRole('button', { name: 'Copy handoff' }).click();
  await expect(page.locator('#live')).toHaveText('Handoff copied to the clipboard');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(handoff);
  await app.assertClean();
});

test('reset returns a slot to unbound and offline', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await openSlot(page, 'Studio');
  await page.getByRole('button', { name: 'Reset slot' }).click();
  await page.getByRole('dialog', { name: 'Reset the Studio slot?' }).getByRole('button', { name: 'Reset slot' }).click();
  await expect(page.getByText('No session connected').first()).toBeVisible();
  await expect(page.getByText('Recorded: Offline')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Slot milestones (0)' })).toBeVisible();
  await expect(page.getByText('No handoff saved.')).toBeVisible();
  // Focus returns to the control that opened the confirmation.
  await expect(page.getByRole('button', { name: 'Reset slot' })).toBeFocused();
  await app.assertClean();
});

test('slots are exported and imported; unsafe session links are rejected on import', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await page.locator('#data-menu summary').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export JSON' }).click()]);
  const exported = Core.parseDocumentText(fs.readFileSync(await download.path(), 'utf8'));
  expect(exported.errors).toEqual([]);
  expect(exported.data.agentSlots.map((s) => [s.id, s.status])).toEqual([
    ['studio', 'running'], ['security', 'waiting'], ['research', 'queued'], ['hackathon', 'offline'], ['qa', 'offline'],
  ]);

  const bad = { schema: 'project-cockpit', version: 1, projects: [], agentSlots: [{ id: 'studio', status: 'running', sessionUrl: 'https://agents.example.com/s?access_token=abc' }] };
  await chooseImport(page, JSON.stringify(bad));
  const failed = page.getByRole('dialog', { name: 'Import failed: nothing was changed' });
  await expect(failed).toContainText('$.agentSlots[0].sessionUrl: must not include tokens');
  await failed.getByRole('button', { name: 'Close' }).click();

  // Files written before slots existed still import, with default slots.
  await importAndConfirm(page, fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'minimal.json'), 'utf8'));
  await gotoAgents(page);
  await expect(page.getByText('No session connected')).toHaveCount(5);
  await app.assertClean();
});
