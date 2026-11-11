import { AppError } from './errors';

export interface MagicLinkMail {
  to: string;
  link: string;
  expiresInMinutes: number;
}

/** Sends sign-in emails. Production will use the business's own mailbox (Gmail API) or a provider. */
export interface Mailer {
  sendMagicLink(mail: MagicLinkMail): Promise<void>;
}

/** Development: prints the link to the API console instead of emailing it. Keeps the last few for tests. */
export class ConsoleMailer implements Mailer {
  readonly sent: MagicLinkMail[] = [];
  constructor(private readonly log: (line: string) => void = console.log) {}
  async sendMagicLink(mail: MagicLinkMail) {
    this.sent.push(mail);
    if (this.sent.length > 50) this.sent.shift();
    this.log(
      `\n✉️  Sign-in link for ${mail.to} (valid ${mail.expiresInMinutes} min):\n   ${mail.link}\n`,
    );
  }
}

/** No email provider configured: fail loudly instead of pretending a link was sent. */
export class UnconfiguredMailer implements Mailer {
  async sendMagicLink(): Promise<void> {
    throw new AppError(
      500,
      'email_not_configured',
      'Sign-in email is not set up yet on this server.',
    );
  }
}
