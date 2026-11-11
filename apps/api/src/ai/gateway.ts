/**
 * Every model call goes through here: one place that logs the prompt and the answer, checks
 * the answer's shape, and stops at the monthly spend cap. Providers are pluggable; tests and
 * the preview use the deterministic fake, and nothing calls a real model unless a provider is
 * configured (none is).
 *
 * The gateway only returns data. Nothing it returns can send, pay or delete: callers turn it
 * into a draft (a bill to review, or a proposal in the approvals inbox).
 */
import type { z } from 'zod';
import type { Tx } from '../db/client';
import type { Auth } from '../lib/types';

export const AI_PURPOSES = [
  'bill_read',
  'reply_email',
  'overdue_reminder',
  'quote_draft',
  'price_update',
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export interface ModelRequest {
  purpose: AiPurpose;
  system: string;
  /** The structured input; real providers get it as JSON after the system prompt. */
  input: unknown;
  maxOutputTokens: number;
}

export interface ModelResponse {
  /** JSON text. */
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Thousandths of a penny. */
  costMillipence: number;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export type AiResult<T> =
  | { ok: true; data: T; callId: string; provider: string }
  | { ok: false; error: string; callId: string | null };

const MAX_LOG = 20_000;

export class AiGateway {
  constructor(
    private readonly provider: ModelProvider | null,
    /** Monthly cap per business, in pence. */
    readonly monthlyCapPence = 500,
  ) {}

  get enabled(): boolean {
    return this.provider !== null;
  }

  get providerName(): string | null {
    return this.provider?.name ?? null;
  }

  async run<S extends z.ZodType>(
    tx: Tx,
    auth: Auth,
    req: Omit<ModelRequest, 'maxOutputTokens'> & { maxOutputTokens?: number },
    schema: S,
  ): Promise<AiResult<z.output<S>>> {
    if (!this.provider)
      return {
        ok: false,
        error: 'The AI helper is not switched on for this business.',
        callId: null,
      };
    const full: ModelRequest = { maxOutputTokens: 1500, ...req };
    const prompt = `${full.system}\n\nINPUT\n${JSON.stringify(full.input, null, 1)}`.slice(
      0,
      MAX_LOG,
    );
    const log = async (
      status: 'ok' | 'error' | 'refused',
      fields: Partial<ModelResponse> & { error?: string; ms?: number },
    ) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO ai_calls (tenant_id, purpose, provider, model, prompt, response, status, error,
                              input_tokens, output_tokens, cost_millipence, duration_ms, created_by)
        VALUES (${auth.tenantId}, ${full.purpose}, ${this.provider!.name}, ${this.provider!.model}, ${prompt},
                ${fields.text?.slice(0, MAX_LOG) ?? null}, ${status}, ${fields.error ?? null},
                ${fields.inputTokens ?? 0}, ${fields.outputTokens ?? 0}, ${fields.costMillipence ?? 0},
                ${fields.ms ?? 0}, ${auth.userId})
        RETURNING id`;
      return row!.id;
    };

    const [spent] = await tx<{ total: string }[]>`
      SELECT coalesce(sum(cost_millipence), 0) AS total FROM ai_calls
       WHERE created_at >= date_trunc('month', now())`;
    if (Number(spent!.total) >= this.monthlyCapPence * 1000) {
      const callId = await log('refused', { error: 'Monthly spend cap reached' });
      return { ok: false, error: 'This month’s AI spend cap has been reached.', callId };
    }

    const started = Date.now();
    let res: ModelResponse;
    try {
      res = await this.provider.complete(full);
    } catch (e) {
      const callId = await log('error', {
        error: String((e as Error).message ?? e).slice(0, 500),
        ms: Date.now() - started,
      });
      return { ok: false, error: 'The AI helper could not answer just now.', callId };
    }
    const ms = Date.now() - started;
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      const callId = await log('error', { ...res, error: 'Answer was not JSON', ms });
      return { ok: false, error: 'The AI helper gave an answer that could not be used.', callId };
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      const callId = await log('error', {
        ...res,
        error: `Answer did not match: ${checked.error.message.slice(0, 300)}`,
        ms,
      });
      return { ok: false, error: 'The AI helper gave an answer that could not be used.', callId };
    }
    const callId = await log('ok', { ...res, ms });
    return { ok: true, data: checked.data, callId, provider: this.provider.name };
  }
}

/** Rough token count for providers that don't report one (and the fake). */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);
