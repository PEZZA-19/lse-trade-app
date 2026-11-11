import { expect, type Page } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The local API writes the last sign-in link here instead of emailing it. */
const LINK_FILE = path.resolve(import.meta.dirname, '../../api/.dev-sign-in-link');

const mtime = () => {
  try {
    return statSync(LINK_FILE).mtimeMs;
  } catch {
    return 0;
  }
};

/** Signs in through the UI exactly as a person would, reading the "email" from the dev link file. */
export async function signInThroughUi(page: Page, email = 'owner@lse.example') {
  const before = mtime();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
  await expect.poll(mtime).toBeGreaterThan(before);
  const [, link] = readFileSync(LINK_FILE, 'utf8').trim().split(' ');
  const url = new URL(link!);
  // Open the link on whichever host the tests use (the link points at the configured app origin).
  const target = `${url.pathname}${url.hash}`;
  await page.goto(target);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  return target;
}
