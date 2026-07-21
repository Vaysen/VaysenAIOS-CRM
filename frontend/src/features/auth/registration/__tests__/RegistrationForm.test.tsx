import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegistrationForm } from '../RegistrationForm';
import type { RegistrationValues } from '../types';

describe('RegistrationForm (FF-005)', () => {
  it('渲染五个输入字段和提交按钮', () => {
    render(<RegistrationForm onSubmit={vi.fn()} />);

    expect(screen.getByLabelText(/^名/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^姓/)).toBeInTheDocument();
    expect(screen.getByLabelText(/用户名/)).toBeInTheDocument();
    expect(screen.getByLabelText(/密码/)).toBeInTheDocument();
    expect(screen.getByLabelText(/公司名称/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /注册/ })).toBeInTheDocument();
  });

  it('空提交显示验证错误', async () => {
    const user = userEvent.setup();
    render(<RegistrationForm onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /注册/ }));

    expect(await screen.findByText('用户名不能为空')).toBeInTheDocument();
    expect(screen.getByText('密码不能为空')).toBeInTheDocument();
    expect(screen.getByText('名不能为空')).toBeInTheDocument();
    expect(screen.getByText('姓不能为空')).toBeInTheDocument();
  });

  it('用户名少于3字符显示错误', async () => {
    const user = userEvent.setup();
    render(<RegistrationForm onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText(/用户名/), 'ab');
    await user.click(screen.getByRole('button', { name: /注册/ }));

    expect(await screen.findByText('用户名至少3个字符')).toBeInTheDocument();
  });

  it('密码少于6位显示错误', async () => {
    const user = userEvent.setup();
    render(<RegistrationForm onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText(/用户名/), 'chris');
    await user.type(screen.getByLabelText(/密码/), '12345');
    await user.type(screen.getByLabelText(/^名/), 'John');
    await user.type(screen.getByLabelText(/^姓/), 'Smith');
    await user.click(screen.getByRole('button', { name: /注册/ }));

    expect(await screen.findByText('密码至少6位')).toBeInTheDocument();
  });

  it('有效提交调用 onSubmit 并显示成功', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    render(<RegistrationForm onSubmit={onSubmit} onSuccess={onSuccess} />);

    await user.type(screen.getByLabelText(/^名/), 'John');
    await user.type(screen.getByLabelText(/^姓/), 'Smith');
    await user.type(screen.getByLabelText(/用户名/), 'chris');
    await user.type(screen.getByLabelText(/密码/), 'password123');
    await user.click(screen.getByRole('button', { name: /注册/ }));

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'chris',
          password: 'password123',
          firstName: 'John',
          lastName: 'Smith',
        }),
        expect.any(AbortSignal),
      );
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('onSubmit 抛错时显示错误信息', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error('用户名已存在'));
    render(<RegistrationForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^名/), 'John');
    await user.type(screen.getByLabelText(/^姓/), 'Smith');
    await user.type(screen.getByLabelText(/用户名/), 'chris');
    await user.type(screen.getByLabelText(/密码/), 'password123');
    await user.click(screen.getByRole('button', { name: /注册/ }));

    expect(await screen.findByText('用户名已存在')).toBeInTheDocument();
  });

  it('提交中禁用按钮', async () => {
    const user = userEvent.setup();
    let resolveFn: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveFn = resolve; }),
    );
    render(<RegistrationForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/^名/), 'John');
    await user.type(screen.getByLabelText(/^姓/), 'Smith');
    await user.type(screen.getByLabelText(/用户名/), 'chris');
    await user.type(screen.getByLabelText(/密码/), 'password123');
    await user.click(screen.getByRole('button', { name: /注册/ }));

    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: /注册中/ })).toBeDisabled();
    });

    // 清理
    await act(async () => {
      resolveFn?.();
    });
  });
});
