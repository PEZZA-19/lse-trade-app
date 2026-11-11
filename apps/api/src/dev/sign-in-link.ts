// Prints the most recent dev sign-in link written by the local API (no email is sent in development).
// Usage: request a link on the sign-in screen, then `pnpm sign-in-link`.
import { existsSync, readFileSync } from 'node:fs';

const file = '.dev-sign-in-link';
if (!existsSync(file)) {
  console.log(
    'No sign-in link yet. Start the API (`pnpm dev`), enter owner@lse.example on the sign-in screen, then run this again.',
  );
  process.exit(1);
}
const [to, link] = readFileSync(file, 'utf8').trim().split(' ');
console.log(`Sign-in link for ${to} (valid 15 minutes, single use):\n${link}`);
