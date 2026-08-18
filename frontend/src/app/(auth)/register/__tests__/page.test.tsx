import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RegisterPage from '../page';

const register = vi.fn().mockRejectedValue(new Error('用户名已存在'));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/i18n/use-translation', () => ({
  useT: () => ({ t: (key: string) => key }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: () => ({
    register,
    isLoading: false,
    error: '用户名已存在',
    clearError: vi.fn(),
  }),
}));

describe('RegisterPage adapter', () => {
  it('注册失败只显示一条错误信息', async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);

    await user.type(screen.getByLabelText('名*', { exact: true }), 'John');
    await user.type(screen.getByLabelText('姓*', { exact: true }), 'Smith');
    await user.type(screen.getByLabelText('用户名*', { exact: true }), 'chris');
    await user.type(screen.getByLabelText('密码*', { exact: true }), 'password1234');
    await user.click(screen.getByRole('button', { name: '注册' }));

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText('用户名已存在')).toHaveLength(1);
  });
});
