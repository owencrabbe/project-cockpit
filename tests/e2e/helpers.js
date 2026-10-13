'use strict';

const { expect } = require('@playwright/test');

/** Opens the app with empty storage and fails the test on any console error or CSP violation. */
async function openApp(page, path = '/') {
  const problems = [];
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('dialog', async (dialog) => {
    problems.push(`native dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });
  // Runs before any page script on every navigation, including reloads.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective));
  });
  await page.goto(path);
  await page.waitForSelector('html[data-ready="true"]');
  return {
    problems,
    async assertClean() {
      const csp = await page.evaluate(() => window.__cspViolations);
      expect(csp, 'CSP violations').toEqual([]);
      expect(problems, 'console errors, page errors or native dialogs').toEqual([]);
    },
  };
}

async function loadSample(page) {
  await page.getByRole('button', { name: 'Load sample data' }).first().click();
  await expect(page.getByRole('heading', { level: 2, name: 'Garden plot signup site' })).toBeVisible();
}

/** Imports JSON text through the real file input, without confirming. */
async function chooseImport(page, text, name = 'import.json') {
  await page.setInputFiles('#import-file', { name, mimeType: 'application/json', buffer: Buffer.from(text) });
}

async function importAndConfirm(page, text) {
  await chooseImport(page, text);
  const dialog = page.getByRole('dialog', { name: 'Replace current data?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Replace data' }).click();
  await expect(dialog).toBeHidden();
}

module.exports = { openApp, loadSample, chooseImport, importAndConfirm };
