/**
 * Deterministic stand-in for a model, for tests and local development (the preview uses the
 * same answers through the mock API). No network.
 */
import { fakeAnswer } from '@lse/shared';
import { approxTokens, type ModelProvider, type ModelRequest, type ModelResponse } from './gateway';

export class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly model = 'fake-deterministic-1';
  readonly calls: ModelRequest[] = [];

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const text = JSON.stringify(fakeAnswer(req.purpose, req.input));
    return {
      text,
      inputTokens: approxTokens(req.system + JSON.stringify(req.input)),
      outputTokens: approxTokens(text),
      costMillipence: 0,
    };
  }
}
