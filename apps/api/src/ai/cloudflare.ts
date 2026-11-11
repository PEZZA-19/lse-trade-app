/**
 * Cloudflare AI Gateway provider (Workers AI or any provider behind the gateway). Built so the
 * swap is one line, but not configured anywhere: no account exists and no real AI calls are
 * made. When it is switched on, the gateway's own logs and spend limits apply on top of ours.
 */
import { approxTokens, type ModelProvider, type ModelRequest, type ModelResponse } from './gateway';

export interface CloudflareAiConfig {
  accountId: string;
  gatewayId: string;
  apiToken: string;
  /** e.g. "@cf/meta/llama-3.3-70b-instruct-fp8-fast". */
  model: string;
  /** Thousandths of a penny per 1k tokens, for the spend cap. */
  millipencePer1kTokens: number;
  fetch?: typeof fetch;
}

export class CloudflareAiProvider implements ModelProvider {
  readonly name = 'cloudflare-ai-gateway';
  constructor(private readonly cfg: CloudflareAiConfig) {}
  get model() {
    return this.cfg.model;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const url = `https://gateway.ai.cloudflare.com/v1/${this.cfg.accountId}/${this.cfg.gatewayId}/workers-ai/${this.cfg.model}`;
    const res = await (this.cfg.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: JSON.stringify(req.input) },
        ],
        max_tokens: req.maxOutputTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`AI Gateway answered ${res.status}`);
    const body = (await res.json()) as {
      result?: {
        response?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
    };
    const text = body.result?.response ?? '';
    const inputTokens =
      body.result?.usage?.prompt_tokens ?? approxTokens(req.system + JSON.stringify(req.input));
    const outputTokens = body.result?.usage?.completion_tokens ?? approxTokens(text);
    return {
      text,
      inputTokens,
      outputTokens,
      costMillipence: Math.ceil(
        ((inputTokens + outputTokens) / 1000) * this.cfg.millipencePer1kTokens,
      ),
    };
  }
}
