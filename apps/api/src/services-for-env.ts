/**
 * Which real services a deployed Worker uses, from its bindings and secrets. Every slot fails
 * closed when it is not configured: nothing pretends to send, store or check.
 *
 * | Slot           | Configured by                    | When missing                                   |
 * |----------------|----------------------------------|------------------------------------------------|
 * | Sign-in email  | (provider not chosen yet)        | sign-in links fail loudly (UnconfiguredMailer) |
 * | Approved email | (provider not chosen yet)        | released emails end "not sent"                 |
 * | Turnstile      | TURNSTILE_SECRET (secret)        | website form answers 503 "not switched on"     |
 * | Photos         | PHOTOS (R2 bucket binding)       | uploads answer 503 "storage not set up"        |
 */
import { UnconfiguredMailer, type Mailer } from './lib/mailer';
import type { MessageSender } from './lib/messages';
import { R2Blobs, UnconfiguredBlobs, type BlobStore, type R2Like } from './lib/blobs';
import {
  CloudflareTurnstile,
  UnconfiguredTurnstile,
  type TurnstileVerifier,
} from './lib/turnstile';

export interface ServiceEnv {
  TURNSTILE_SECRET?: string;
  PHOTOS?: R2Like;
  /** Reserved for the email provider once Joe picks one (UK/EU region). Unused until then. */
  EMAIL_PROVIDER?: string;
}

export interface Services {
  mailer: Mailer;
  sender: MessageSender | null;
  turnstile: TurnstileVerifier;
  blobs: BlobStore;
}

export function servicesFor(env: ServiceEnv): Services {
  return {
    // Slot: an email provider adapter goes here (both for sign-in links and approved emails).
    mailer: new UnconfiguredMailer(),
    sender: null,
    turnstile: env.TURNSTILE_SECRET
      ? new CloudflareTurnstile(env.TURNSTILE_SECRET)
      : new UnconfiguredTurnstile(),
    blobs: env.PHOTOS ? new R2Blobs(env.PHOTOS) : new UnconfiguredBlobs(),
  };
}

/** What is and isn't connected, for the deploy checklist and logs. Never includes secret values. */
export function describeServices(s: Services) {
  return {
    signInEmail: s.mailer instanceof UnconfiguredMailer ? 'not connected' : 'connected',
    approvedEmail: s.sender ? `connected (${s.sender.name})` : 'not connected',
    websiteForm: s.turnstile.name === 'cloudflare' ? 'Turnstile on' : 'off (no Turnstile secret)',
    photos: s.blobs.name === 'r2' ? 'R2' : 'not set up',
  };
}
