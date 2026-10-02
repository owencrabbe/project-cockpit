'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { openApp, importAndConfirm } = require('./helpers');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'progress-fixture.json'), 'utf8'));
const CONFIDENCE_LABELS = { high: 'High', medium: 'Medium', low: 'Low', none: 'Not measurable' };

test.beforeEach(async ({ page }) => {
  // Freeze the clock at the fixture's "now" so confidence matches the hand-computed values.
  await page.clock.setFixedTime(new Date(fixture.now));
});

async function openFixture(page) {
  const app = await openApp(page);
  await importAndConfirm(page, JSON.stringify(fixture.document));
  return app;
}

function card(page, name) {
  return page.locator('article.card').filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });
}

test('project cards show the fixture numerator/denominator, percent and confidence', async ({ page }) => {
  const app = await openFixture(page);
  for (const project of fixture.document.projects) {
    const expected = fixture.expected[project.id];
    const c = card(page, project.name);
    await expect(c, project.id).toHaveCount(1);
    if (expected.percent === null) {
      await expect(c.locator('.progress-text')).toHaveText('No weighted milestones yet');
    } else {
      await expect(c.locator('.progress-pct'), project.id).toHaveText(`${expected.percent}%`);
      await expect(c.locator('.progress-fraction'), project.id)
        .toHaveText(`${expected.numeratorText} / ${expected.denominatorText} weight verified complete`);
    }
    await expect(c.getByText(`Confidence: ${CONFIDENCE_LABELS[expected.confidence]}`), project.id).toBeVisible();
    await expect(c.getByText(expected.lastVerifiedAt ? /^Last verified / : 'Never verified'), project.id).toBeVisible();
  }
  await app.assertClean();
});

test('detail view explains why each milestone does or does not count', async ({ page }) => {
  const app = await openFixture(page);
  await page.getByRole('link', { name: 'Fixture: exclusions' }).click();
  const panel = page.getByRole('region', { name: 'Progress' });
  await expect(panel.locator('.big-figure')).toHaveText('10%');
  await expect(panel.locator('.fraction')).toHaveText('10 / 100 weight verified complete');
  await expect(panel.getByText('Confidence: Low')).toBeVisible();
  for (const reason of fixture.expected.exclusions.confidenceReasons) {
    await expect(panel.getByText(reason, { exact: true })).toBeVisible();
  }
  const expectations = {
    'Counted despite resolved blocker': 'Counted: complete, verified and backed by evidence',
    'Blocked with evidence': 'Blocked: never counts as complete',
    'Untested with evidence': 'Untested: never counts as complete',
    'Complete but unverified': 'Marked complete, but not verified',
    'Complete without evidence': 'Marked complete, but has no http(s) evidence link',
    'Complete with open blocker': 'Marked complete, but an open blocker is linked to it',
  };
  for (const [title, text] of Object.entries(expectations)) {
    const item = page.locator('li.item').filter({ has: page.getByRole('heading', { level: 3, name: title }) });
    await expect(item.locator('.eligibility'), title).toHaveText(new RegExp(text.replace(/[()]/g, '\\$&')));
  }
  await expect(page.locator('li.item.is-counted')).toHaveCount(1);
  await app.assertClean();
});

test('recording verification on a complete milestone with evidence makes it count', async ({ page }) => {
  const app = await openFixture(page);
  await page.getByRole('link', { name: 'Fixture: exclusions' }).click();
  await page.getByRole('button', { name: 'Verify now (Complete but unverified)' }).click();
  const confirm = page.getByRole('dialog', { name: 'Record verification?' });
  await confirm.getByRole('button', { name: 'Record verification' }).click();
  const panel = page.getByRole('region', { name: 'Progress' });
  await expect(panel.locator('.big-figure')).toHaveText('25%');
  await expect(panel.locator('.fraction')).toHaveText('25 / 100 weight verified complete');
  await expect(panel.locator('time').first()).toHaveAttribute('datetime', new Date(fixture.now).toISOString());
  await app.assertClean();
});

test('Untested and Blocked never count; switching to Complete needs fresh verification', async ({ page }) => {
  const app = await openFixture(page);
  await page.getByRole('link', { name: 'Fixture: exclusions' }).click();
  const panel = page.getByRole('region', { name: 'Progress' });

  // A blocked milestone stays uncounted even after recording verification.
  await page.getByRole('button', { name: 'Edit milestone: Blocked with evidence' }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit milestone' });
  await dialog.getByLabel('Record verification now').check();
  await dialog.getByRole('button', { name: 'Save milestone' }).click();
  await expect(panel.locator('.big-figure')).toHaveText('10%');

  // Untested -> Complete without recording verification: the older verification is cleared.
  await page.getByRole('button', { name: 'Edit milestone: Untested with evidence' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit milestone' });
  await dialog.getByLabel('Status').selectOption('complete');
  await dialog.getByRole('button', { name: 'Save milestone' }).click();
  const item = page.locator('li.item').filter({ has: page.getByRole('heading', { level: 3, name: 'Untested with evidence' }) });
  await expect(item.locator('.eligibility')).toContainText('Marked complete, but not verified');
  await expect(panel.locator('.big-figure')).toHaveText('10%');

  // Now verify it: 10 + 30 = 40.
  await page.getByRole('button', { name: 'Edit milestone: Untested with evidence' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit milestone' });
  await dialog.getByLabel('Record verification now').check();
  await dialog.getByRole('button', { name: 'Save milestone' }).click();
  await expect(panel.locator('.big-figure')).toHaveText('40%');

  // Resolving the open blocker linked to b6 lets it count: 40 + 20 = 60.
  await page.getByRole('button', { name: 'Resolve blocker: Open blocker linked to b6' }).click();
  await expect(panel.locator('.big-figure')).toHaveText('60%');
  await expect(panel.locator('.fraction')).toHaveText('60 / 100 weight verified complete');
  await app.assertClean();
});

test('weights entered in the form are validated and drive the denominator', async ({ page }) => {
  const app = await openFixture(page);
  await page.getByRole('link', { name: 'Fixture: rounds down' }).click();
  await page.getByRole('button', { name: 'Add milestone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add milestone' });
  await dialog.getByLabel('Title').fill('Extra');
  await dialog.getByLabel('Weight').fill('0');
  await dialog.getByRole('button', { name: 'Add milestone' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Weight');
  await dialog.getByLabel('Weight').fill('1');
  await dialog.getByRole('button', { name: 'Add milestone' }).click();
  await expect(dialog).toBeHidden();
  const panel = page.getByRole('region', { name: 'Progress' });
  await expect(panel.locator('.fraction')).toHaveText('2 / 4 weight verified complete');
  await expect(panel.locator('.big-figure')).toHaveText('50%');
  await app.assertClean();
});
