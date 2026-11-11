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
