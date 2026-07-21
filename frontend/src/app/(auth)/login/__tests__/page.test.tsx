import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from '../page';

const login = vi.fn().mockResolvedValue(undefined);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: () => ({
    login,
    isLoading: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

describe('LoginPage (T112-001)', () => {
  it('uses the email contract, not a username contract', () => {
    render(<LoginPage />);

    // 标签应为「邮箱」而非「用户名」
    expect(screen.getByText('邮箱')).toBeInTheDocument();
    expect(screen.queryByText('用户名')).not.toBeInTheDocument();

    // 输入框应为 email 类型
    const input = screen.getByPlaceholderText(/@/) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('email');
  });

  it('submits the typed value as the email credential', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByPlaceholderText(/@/), 'chris@company.com');
    await user.type(screen.getByPlaceholderText('请输入密码'), 'secret123');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await screen.findByText('邮箱'); // 等待渲染稳定
    expect(login).toHaveBeenCalledWith('chris@company.com', 'secret123');
  });
});
