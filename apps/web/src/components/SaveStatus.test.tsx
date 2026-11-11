import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SaveStatus } from './SaveStatus';

describe('SaveStatus', () => {
  it('only says Saved for the saved state', () => {
    const { rerender } = render(<SaveStatus state="saving" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    rerender(<SaveStatus state="error" errorMessage="Not saved: offline" onRetry={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not saved: offline');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    rerender(<SaveStatus state="saved" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });
});

describe('SaveStatus queued', () => {
  it('is explicit that a queued edit is only on this device', () => {
    const { container } = render(<SaveStatus state="queued" />);
    expect(container).toHaveTextContent('Saved on this device · will sync');
  });
});
