import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NewQuotePage from '../page';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/lib/api', () => ({ default: { get: (...args: unknown[]) => apiGet(...args), post: (...args: unknown[]) => apiPost(...args) } }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('leadId=lead-1') }));

describe('Quote opportunity selection', () => {
  beforeEach(() => {
    apiGet.mockResolvedValue({ data: { data: [{ id: 'opp-1', leadId: 'lead-1', name: 'Retail launch', description: null, stage: 'qualified', amount: '3000.00', currency: 'USD', probability: 40, expectedCloseDate: null, nextStep: null, wonAt: null, lostAt: null, lostReason: null, version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }], meta: { page: 1, limit: 100, total: 1, totalPages: 1 } } });
    apiPost.mockResolvedValue({ data: { id: 'quote-1' } });
  });

  it('selects a real opportunity and submits its id with the quote', async () => {
    const user = userEvent.setup();
    render(<NewQuotePage />);
    const select = await screen.findByRole('combobox', { name: '关联商机' });
    await user.selectOptions(select, 'opp-1');
    await user.click(screen.getByRole('button', { name: /创建草稿/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/quotes', expect.objectContaining({ leadId: 'lead-1', opportunityId: 'opp-1' })));
  });
});
