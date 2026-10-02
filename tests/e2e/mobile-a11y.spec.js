'use strict';

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { openApp, loadSample, importAndConfirm, chooseImport } = require('./helpers');

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function expectNoAxeViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id} [${v.impact}] x${v.nodes.length}: ${v.nodes[0].target.join(' ')}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

async function expectNoHorizontalScroll(page, label) {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, `horizontal overflow on ${label}`).toBeLessThanOrEqual(widths.client);
}

async function visitAllViews(page, check) {
  await check('projects');
  await page.getByRole('link', { name: 'Garden plot signup site' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Garden plot signup site' })).toBeVisible();
  await check('project detail');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Timeline' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
  await check('timeline');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Decisions' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Decisions' })).toBeVisible();
  await check('decisions');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Agents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent slots' })).toBeVisible();
  await check('agent slots');
  await page.getByRole('link', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security slot' })).toBeVisible();
  await check('agent slot detail');
}

for (const colorScheme of ['light', 'dark']) {
  test.describe(`axe (${colorScheme})`, () => {
    test.use({ colorScheme });

    test('every view has no WCAG 2.2 AA or best-practice violations', async ({ page }) => {
      const app = await openApp(page);
      await expectNoAxeViolations(page, 'empty state');
      await loadSample(page);
      await visitAllViews(page, (label) => expectNoAxeViolations(page, label));
      await app.assertClean();
    });

    test('dialogs have no violations', async ({ page }) => {
      const app = await openApp(page);
      await loadSample(page);
      await page.getByRole('link', { name: 'Garden plot signup site' }).click();
      await page.getByRole('button', { name: 'Add milestone' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add milestone' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Add evidence link' }).click();
      await expectNoAxeViolations(page, 'milestone dialog');
      await dialog.getByRole('button', { name: 'Add milestone' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expectNoAxeViolations(page, 'milestone dialog with errors');
      await page.keyboard.press('Escape');
      await chooseImport(page, '{"schema":"nope"}');
      await expect(page.getByRole('dialog', { name: 'Import failed: nothing was changed' })).toBeVisible();
      await expectNoAxeViolations(page, 'import error dialog');
      await page.keyboard.press('Escape');
      await page.goto('/#/agent/studio');
      await page.getByRole('button', { name: 'Edit slot' }).click();
      const slotDialog = page.getByRole('dialog', { name: 'Edit Studio slot' });
      await slotDialog.getByLabel('Session link').fill('http://not-https.example.com');
      await slotDialog.getByRole('button', { name: 'Save slot' }).click();
      await expect(slotDialog.getByRole('alert')).toBeVisible();
      await expectNoAxeViolations(page, 'slot dialog with errors');
      await app.assertClean();
    });
  });
}

test.describe('small screens', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('no horizontal scrolling at 320 CSS px, even with long unbroken text', async ({ page }) => {
    const app = await openApp(page);
    await expectNoHorizontalScroll(page, 'empty state');
    await loadSample(page);
    await visitAllViews(page, (label) => expectNoHorizontalScroll(page, label));
    const long = 'W'.repeat(120);
    await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Projects' }).click();
    await importAndConfirm(page, JSON.stringify({
      schema: 'project-cockpit',
      version: 1,
      projects: [{
        id: 'long', name: long, summary: 'S'.repeat(500), status: 'active', tags: ['t'.repeat(40)],
        milestones: [{
          id: 'm', title: long, weight: 1, status: 'complete', verifiedAt: '2026-01-01T00:00:00Z',
          evidence: [{ label: 'L'.repeat(120), url: `https://example.com/${'p'.repeat(1500)}` }],
        }],
        decisions: [{ id: 'd', question: long, options: ['O'.repeat(120)], status: 'open', neededBy: '2026-01-02' }],
      }],
    }));
    await expectNoHorizontalScroll(page, 'long text list');
    await page.getByRole('link', { name: long }).click();
    await expectNoHorizontalScroll(page, 'long text detail');
    await page.getByRole('button', { name: /^Edit milestone/ }).click();
    await expectNoHorizontalScroll(page, 'long text dialog');
    await app.assertClean();
  });

  test('buttons and form controls are at least 44px tall; checkboxes at least 24px', async ({ page }) => {
    const app = await openApp(page);
    await loadSample(page);
    const measure = () => page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const small = [];
      document.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, summary, .tabs a, .stat-link, .crumb a')
        .forEach((el) => {
          if (!visible(el)) return;
          const r = el.getBoundingClientRect();
          if (r.height < 44 || r.width < 44) small.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        });
      document.querySelectorAll('input[type=checkbox], input[type=radio]').forEach((el) => {
        if (!visible(el)) return;
        const r = el.getBoundingClientRect();
        if (r.height < 24 || r.width < 24) small.push(`checkbox ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      return small;
    });
    expect(await measure(), 'projects view').toEqual([]);
    await page.getByRole('link', { name: 'Garden plot signup site' }).click();
    expect(await measure(), 'detail view').toEqual([]);
    await page.getByRole('button', { name: 'Add milestone' }).click();
    expect(await measure(), 'dialog').toEqual([]);
    await page.keyboard.press('Escape');
    await page.goto('/#/agent/studio');
    await expect(page.getByRole('heading', { level: 1, name: 'Studio slot' })).toBeVisible();
    expect(await measure(), 'agent slot detail').toEqual([]);
    await app.assertClean();
  });
});

test('structure: one main landmark, one h1 per view, labelled navigation with current page', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await visitAllViews(page, async (label) => {
    expect(await page.locator('main').count(), label).toBe(1);
    expect(await page.locator('h1').count(), label).toBe(1);
    await expect(page.getByRole('navigation', { name: 'Views' }).locator('[aria-current="page"]')).toHaveCount(1);
  });
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
  await app.assertClean();
});

test('keyboard: skip link, route focus, dialog focus trap and focus return', async ({ page }) => {
  const app = await openApp(page);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#page-title')).toBeFocused();

  await loadSample(page);
  const cardLink = page.getByRole('link', { name: 'Garden plot signup site' });
  await cardLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Garden plot signup site' })).toBeFocused();

  const add = page.getByRole('button', { name: 'Add milestone' });
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add milestone' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title')).toBeFocused();
  // Native modal dialogs make the page behind them inert. Tabbing past the last
  // control may move focus to the browser UI (activeElement = body), but it must
  // never land on page content behind the dialog.
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const el = document.activeElement;
      if (document.getElementById('dialog').contains(el)) return 'dialog';
      return el === document.body || el === null ? 'browser' : 'page';
    });
    expect(where, 'focus never reaches content behind the modal').not.toBe('page');
  }
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();

  const menu = page.locator('#data-menu summary');
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeHidden();
  await expect(menu).toBeFocused();
  await app.assertClean();
});

test('form errors are announced and invalid fields are marked', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await page.getByRole('link', { name: 'Garden plot signup site' }).click();
  await page.getByRole('button', { name: 'Add milestone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add milestone' });
  await dialog.getByRole('button', { name: 'Add milestone' }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('Please fix the following');
  await expect(alert).toContainText('Title');
  await expect(alert).toContainText('Weight');
  await expect(dialog.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByLabel('Weight')).toHaveAttribute('aria-invalid', 'true');
  await app.assertClean();
});

test('status changes are announced in a polite live region and focus is kept', async ({ page }) => {
  const app = await openApp(page);
  await loadSample(page);
  await page.getByRole('link', { name: 'Garden plot signup site' }).click();
  const box = page.getByRole('checkbox', { name: 'Create 30 sample signups and run the waitlist test' });
  // click() rather than check(): the list re-renders and the item moves into the collapsed "Done" group.
  await box.click();
  await expect(page.locator('#live')).toHaveText('Action done');
  await expect(page.locator('#live')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#sec-actions')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Next actions (1)' })).toBeVisible();
  await app.assertClean();
});
