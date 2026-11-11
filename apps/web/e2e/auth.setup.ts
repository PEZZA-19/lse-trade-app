import { test as setup } from '@playwright/test';
import { AUTH_FILE } from '../playwright.config';
import { signInThroughUi } from './sign-in';

setup('sign in as the demo owner', async ({ page }) => {
  await signInThroughUi(page);
  await page.context().storageState({ path: AUTH_FILE });
});
