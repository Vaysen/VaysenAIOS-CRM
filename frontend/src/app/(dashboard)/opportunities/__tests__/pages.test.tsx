import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OpportunitiesPage from '../page';
import NewOpportunityPage from '../new/page';
import OpportunityDetailPage from '../[id]/client-page';
import type { Opportunity, OpportunityListResponse } from '@/types/opportunity';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
let query = new URLSearchParams();

vi.mock('@/lib/api', () => ({ default: { get: (...args: unknown[]) => apiGet(...args), post: (...args: unknown[]) => apiPost(...args), patch: (...args: unknown[]) => apiPatch(...args), delete: (...args: unknown[]) => apiDelete(...args) } }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ useSearchParams: () => query }));
vi.mock('@/lib/use-runtime-route-param', () => ({ useRuntimeRouteParam: () => 'opp-1' }));

const opportunity: Opportunity = {
  id: 'opp-1', leadId: 'lead-1', lead: { id: 'lead-1', companyName: 'Acme Packaging', contactName: 'Mia Chen', country: 'US' }, owner: { id: 'user-1', displayName: 'Lin Wei' }, name: 'Custom paper bags', description: 'Retail launch', stage: 'proposal', amount: '1200.00', currency: 'USD', probability: 60,
  expectedCloseDate: '2026-09-01T00:00:00.000Z', nextStep: 'Confirm artwork', wonAt: null, lostAt: null, lostReason: null, version: 3,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z',
};
const nullSummaryOpportunity: Opportunity = { ...opportunity, lead: null, owner: null };
const listResponse: OpportunityListResponse = { data: [opportunity], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } };
const directoryContact = { id: 'contact-1', displayName: 'Mia Chen', firstName: 'Mia', lastName: 'Chen', title: 'Procurement Manager', isPrimary: true };
const contactRole = { id: 'role-1', contactId: 'contact-1', roleType: 'buyer' as const, isPrimary: true, createdAt: '2026-08-03T00:00:00.000Z', contact: { id: 'contact-1', displayName: 'Mia Chen', title: 'Procurement Manager', isPrimary: true } };

describe('Opportunity frontend contract', () => {
  beforeEach(() => { apiGet.mockReset(); apiPost.mockReset(); apiPatch.mockReset(); apiDelete.mockReset(); query = new URLSearchParams(); });
  afterEach(() => vi.clearAllMocks());

  it('renders real list and kanban fields, then sends backend filter parameters', async () => {
    apiGet.mockResolvedValue({ data: listResponse });
    const user = userEvent.setup();
    render(<OpportunitiesPage />);
    expect(await screen.findByText('Custom paper bags')).toBeInTheDocument();
    expect(screen.getByText('客户：Acme Packaging')).toBeInTheDocument();
    expect(screen.getByText('联系人：Mia Chen · 负责人：Lin Wei')).toBeInTheDocument();
    expect(screen.getByText(/关联客户 ID：lead-1/)).toBeInTheDocument();
    expect(screen.getByText(/USD 1,200.00/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /看板/ }));
    expect(screen.getAllByText('方案报价').length).toBeGreaterThan(0);
    await user.type(screen.getByRole('textbox', { name: '搜索商机' }), ' launch');
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/opportunities', { params: expect.objectContaining({ search: 'launch' }) }));
  });

  it('renders stable non-misleading fallbacks when list summaries are null', async () => {
    apiGet.mockResolvedValue({ data: { ...listResponse, data: [nullSummaryOpportunity] } });
    render(<OpportunitiesPage />);
    expect(await screen.findByText('客户：客户摘要不可用')).toBeInTheDocument();
    expect(screen.getByText('联系人：联系人摘要不可用 · 负责人：负责人摘要不可用')).toBeInTheDocument();
    expect(screen.getByText(/关联客户 ID：lead-1/)).toBeInTheDocument();
    expect(screen.queryByText('客户：lead-1')).not.toBeInTheDocument();
  });

  it('creates with the leadId query prefill and structured payload', async () => {
    query = new URLSearchParams('leadId=lead-2');
    apiPost.mockResolvedValueOnce({ data: { id: 'opp-2' } });
    const user = userEvent.setup();
    render(<NewOpportunityPage />);
    expect(screen.getByRole('textbox', { name: '客户 ID' })).toHaveValue('lead-2');
    await user.type(screen.getByRole('textbox', { name: '商机名称' }), 'New opportunity');
    await user.click(screen.getByRole('button', { name: '创建商机' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/opportunities', expect.objectContaining({ leadId: 'lead-2', name: 'New opportunity', stage: 'new', currency: 'USD' })));
  });

  it('renders history and posts only a legal versioned transition', async () => {
    apiGet.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('stage-history') ? { data: [{ id: 'h-1', fromStage: 'qualified', toStage: 'proposal', changedAt: '2026-08-02T00:00:00.000Z', note: 'Approved', amountSnapshot: '1000.00', probabilitySnapshot: 60, expectedCloseDateSnapshot: null, source: 'USER' }] } : url.endsWith('contact-roles') ? { data: [] } : url.includes('/customer-assets/') ? [directoryContact] : opportunity }));
    apiPost.mockResolvedValueOnce({ data: { ...opportunity, stage: 'negotiation', version: 4 } });
    const user = userEvent.setup();
    render(<OpportunityDetailPage />);
    expect(await screen.findByText('已确认 → 方案报价')).toBeInTheDocument();
    expect(screen.getByText('客户：Acme Packaging · 联系人：Mia Chen')).toBeInTheDocument();
    expect(screen.getByText(/负责人：Lin Wei/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: '下一阶段' }), 'negotiation');
    await user.click(screen.getByRole('button', { name: '推进阶段' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/opportunities/opp-1/stage', { stage: 'negotiation', version: 3, note: undefined, lostReason: undefined }));
  });

  it('renders detail lead and owner summaries with a null fallback', async () => {
    apiGet.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('stage-history') ? { data: [] } : url.endsWith('contact-roles') ? { data: [] } : url.includes('/customer-assets/') ? [] : nullSummaryOpportunity }));
    render(<OpportunityDetailPage />);
    expect(await screen.findByText('客户：客户摘要不可用 · 联系人：联系人摘要不可用')).toBeInTheDocument();
    expect(screen.getByText(/负责人：负责人摘要不可用/)).toBeInTheDocument();
    expect(screen.getByText(/关联客户 ID：lead-1/)).toBeInTheDocument();
  });

  it('loads trusted contacts and uses server responses for add, update, and remove', async () => {
    let serverRoles = [contactRole];
    const addedRole = { ...contactRole, id: 'role-2', roleType: 'champion' as const, isPrimary: false };
    const updatedRole = { ...contactRole, roleType: 'champion' as const, isPrimary: false };
    apiGet.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('stage-history') ? { data: [] } : url.endsWith('contact-roles') ? { data: serverRoles } : url.includes('/customer-assets/') ? [directoryContact] : opportunity }));
    apiPost.mockResolvedValue({ data: addedRole });
    apiPatch.mockResolvedValue({ data: updatedRole });
    apiDelete.mockImplementation(async () => { serverRoles = []; return { data: { removed: true } }; });
    const user = userEvent.setup();
    render(<OpportunityDetailPage />);
    expect(await screen.findByRole('option', { name: /Mia Chen/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /客户主联系人/ })).toBeInTheDocument();
    expect(screen.getByText('商机主联系人')).toBeInTheDocument();
    expect(screen.queryByText('contact-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /UUID/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: '可信联系人' }), 'contact-1');
    await user.click(screen.getByRole('checkbox', { name: '设为商机主联系人' }));
    await user.click(screen.getByRole('button', { name: '添加联系人角色' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/opportunities/opp-1/contact-roles', { contactId: 'contact-1', roleType: 'buyer', isPrimary: true }));

    await user.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    await user.selectOptions(screen.getByRole('combobox', { name: '角色类型' }), 'champion');
    await user.click(screen.getByRole('checkbox', { name: '设为商机主联系人' }));
    await user.click(screen.getByRole('button', { name: '保存联系人角色' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith('/opportunities/opp-1/contact-roles/role-1', { contactId: 'contact-1', roleType: 'champion', isPrimary: false }));

    await user.click(screen.getAllByRole('button', { name: '删除' })[0]);
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/opportunities/opp-1/contact-roles/role-1'));
    expect(await screen.findByText(/暂无联系人角色/)).toBeInTheDocument();
  });

  it('keeps the selector read-only when the trusted directory is empty or forbidden', async () => {
    apiGet.mockImplementation((url: string) => url.includes('/customer-assets/')
      ? Promise.resolve({ data: [] })
      : Promise.resolve({ data: url.endsWith('stage-history') ? { data: [] } : url.endsWith('contact-roles') ? { data: [] } : opportunity }));
    render(<OpportunityDetailPage />);
    expect(await screen.findByText('当前客户暂无可选联系人，无法添加联系人角色。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加联系人角色' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /UUID/i })).not.toBeInTheDocument();
  });

  it('shows stable directory and role permission errors without bypassing the API', async () => {
    apiGet.mockImplementation((url: string) => url.includes('/customer-assets/')
      ? Promise.reject({ response: { status: 403 } })
      : Promise.resolve({ data: url.endsWith('stage-history') ? { data: [] } : url.endsWith('contact-roles') ? { data: [] } : opportunity }));
    render(<OpportunityDetailPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('当前账号无权读取客户联系人目录。');
  });

  it('shows stable 403, 409, and 400 role errors', async () => {
    apiGet.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('stage-history') ? { data: [] } : url.endsWith('contact-roles') ? { data: [] } : url.includes('/customer-assets/') ? [directoryContact] : opportunity }));
    apiPost.mockRejectedValueOnce({ response: { status: 403 } }).mockRejectedValueOnce({ response: { status: 409 } }).mockRejectedValueOnce({ response: { status: 400 } });
    const user = userEvent.setup();
    render(<OpportunityDetailPage />);
    await screen.findByRole('option', { name: /Mia Chen/ });
    await user.selectOptions(screen.getByRole('combobox', { name: '可信联系人' }), 'contact-1');
    await user.click(screen.getByRole('button', { name: '添加联系人角色' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前账号无权读取或修改联系人角色。');
    await user.click(screen.getByRole('button', { name: '添加联系人角色' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('联系人角色已被其他操作更新，请刷新后重试。');
    await user.click(screen.getByRole('button', { name: '添加联系人角色' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('联系人角色请求无效，请检查后重试。');
  });

  it('requires lost reason and gives a reload action on 409', async () => {
    apiGet.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('stage-history') ? { data: [] } : url.endsWith('contact-roles') ? { data: [] } : url.includes('/customer-assets/') ? [directoryContact] : opportunity }));
    apiPost.mockRejectedValueOnce({ response: { status: 409, data: { message: 'conflict' } } });
    const user = userEvent.setup();
    render(<OpportunityDetailPage />);
    await screen.findByText('Custom paper bags');
    await user.selectOptions(screen.getByRole('combobox', { name: '下一阶段' }), 'lost');
    await user.click(screen.getByRole('button', { name: '推进阶段' }));
    expect(screen.getByRole('alert')).toHaveTextContent('输单必须填写原因');
    await user.type(screen.getByRole('textbox', { name: '输单原因' }), 'Budget paused');
    await user.click(screen.getByRole('button', { name: '推进阶段' }));
    expect(await screen.findByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });
});
