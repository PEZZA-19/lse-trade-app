import { describe, expect, it } from 'vitest';
import { demoBannerText } from './AppShell';

describe('demo banner', () => {
  it('the private demo with the business’s own jobs never says “sample jobs”', () => {
    const t = demoBannerText(true, true);
    expect(t.long).toMatch(/your own jobs, customers and supplier bills/);
    expect(`${t.long} ${t.short}`).not.toMatch(/sample/i);
    expect(t.short).toBe('Private demo · your jobs');
  });
  it('the public preview and the sample-data demo say they’re sample data', () => {
    expect(demoBannerText(false, false).short).toBe('Preview · sample data');
    expect(demoBannerText(false, true).short).toBe('Preview · sample data');
    expect(demoBannerText(true, false).long).toMatch(/sample jobs/);
  });
});
