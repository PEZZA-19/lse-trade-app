/**
 * Sends approved emails. Nothing is connected yet, so the default sender refuses and the
 * proposal is marked "not sent: no email account connected" rather than pretending.
 */
export interface OutgoingEmail {
  to: string;
  toName: string;
  subject: string;
  body: string;
}

export interface MessageSender {
  readonly name: string;
  /** Returns the provider's message id. */
  send(mail: OutgoingEmail): Promise<string>;
}

/** Tests only: records what would have been sent. */
export class RecordingSender implements MessageSender {
  readonly name = 'recording';
  readonly sent: OutgoingEmail[] = [];
  async send(mail: OutgoingEmail) {
    this.sent.push(mail);
    return `test-${this.sent.length}`;
  }
}
