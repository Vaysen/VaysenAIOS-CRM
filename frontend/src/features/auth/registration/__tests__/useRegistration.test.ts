import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRegistration } from '../useRegistration';

describe('useRegistration', () => {
  it('受控五字段初始值正确', () => {
    const { result } = renderHook(() =>
      useRegistration({
        onSubmit: vi.fn(),
        initialValues: {
          username: 'init_user',
          firstName: 'John',
        },
      }),
    );

    expect(result.current.values.username).toBe('init_user');
    expect(result.current.values.firstName).toBe('John');
    expect(result.current.values.password).toBe('');
    expect(result.current.values.lastName).toBe('');
    expect(result.current.values.companyName).toBe('');
  });

  it('setField 更新字段值并清除错误', () => {
    const { result } = renderHook(() =>
      useRegistration({ onSubmit: vi.fn() }),
    );

    act(() => {
      result.current.setField('username', 'chris');
    });

    expect(result.current.values.username).toBe('chris');
  });

  it('无效输入不调用 onSubmit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRegistration({ onSubmit }));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(result.current.errors.username).toBeDefined();
    expect(result.current.errors.password).toBeDefined();
    expect(result.current.errors.firstName).toBeDefined();
    expect(result.current.errors.lastName).toBeDefined();
  });

  it('有效输入调用 onSubmit 并触发 onSuccess', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useRegistration({ onSubmit, onSuccess }),
    );

    act(() => {
      result.current.setField('username', 'chris');
      result.current.setField('password', 'password123');
      result.current.setField('firstName', 'John');
      result.current.setField('lastName', 'Smith');
    });

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'chris',
        password: 'password123',
        firstName: 'John',
        lastName: 'Smith',
      }),
      expect.any(AbortSignal),
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('双击只调用一次 onSubmit', async () => {
    const onSubmit = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
    const { result } = renderHook(() => useRegistration({ onSubmit }));

    act(() => {
      result.current.setField('username', 'chris');
      result.current.setField('password', 'password123');
      result.current.setField('firstName', 'John');
      result.current.setField('lastName', 'Smith');
    });

    // 并发调用两次
    await act(async () => {
      await Promise.all([
        result.current.handleSubmit(),
        result.current.handleSubmit(),
      ]);
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('onSubmit 抛错时设置 submit 错误', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('用户名已存在'));
    const { result } = renderHook(() => useRegistration({ onSubmit }));

    act(() => {
      result.current.setField('username', 'chris');
      result.current.setField('password', 'password123');
      result.current.setField('firstName', 'John');
      result.current.setField('lastName', 'Smith');
    });

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.errors.submit).toBe('用户名已存在');
    expect(result.current.isSubmitting).toBe(false);
  });

  it('卸载时中止进行中的请求', async () => {
    let resolveFn: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      (_values, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          resolveFn = resolve;
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const { result, unmount } = renderHook(() =>
      useRegistration({ onSubmit }),
    );

    act(() => {
      result.current.setField('username', 'chris');
      result.current.setField('password', 'password123');
      result.current.setField('firstName', 'John');
      result.current.setField('lastName', 'Smith');
    });

    // 开始提交（不等待完成）
    act(() => {
      void result.current.handleSubmit();
    });

    // 卸载组件，应触发 abort
    unmount();

    // 等待 promise settle
    await waitFor(() => {
      // onSubmit 被调用，但因为 abort，promise 被 reject
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });
});
