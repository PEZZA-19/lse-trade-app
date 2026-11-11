import { describe, expect, it } from 'vitest';
import { describeAction } from './syncFormat';

describe('describeAction', () => {
  it('names timer actions and offline creates', () => {
    expect(describeAction('/jobs/abc/timer/start')).toBe('Timer started');
    expect(describeAction('/jobs/abc/timer/stop')).toBe('Timer stopped');
    expect(describeAction('/customers')).toBe('New customer');
    expect(describeAction('/quotes')).toBe('New quote');
    expect(describeAction('/jobs')).toBe('New job');
    expect(describeAction('/something/else')).toBe('Change');
  });
});
