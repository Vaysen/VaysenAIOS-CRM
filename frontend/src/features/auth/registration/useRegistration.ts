/**
 * 可中止的注册提交 Hook (FF-005)
 *
 * 特性：
 * - 受控五字段状态管理
 * - AbortController：组件卸载时自动 abort 进行中的请求
 * - 双击锁：submitLockRef 防止重复提交
 * - 成功回调 onSuccess
 * - 无 API/router/store 依赖，由调用方传入 onSubmit
 */
'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { RegistrationValues, RegistrationErrors } from './types';
import { validateAll, isValid } from './validation';
import { normalizeRegistrationValues } from './schema';

export interface UseRegistrationOptions {
  /** 提交回调，接收表单值和 AbortSignal */
  onSubmit: (values: RegistrationValues, signal: AbortSignal) => Promise<void>;
  /** 成功回调 */
  onSuccess?: () => void;
  /** 初始值 */
  initialValues?: Partial<RegistrationValues>;
}

export interface UseRegistrationReturn {
  values: RegistrationValues;
  errors: RegistrationErrors;
  isSubmitting: boolean;
  setField: (field: keyof RegistrationValues, value: string) => void;
  handleSubmit: () => Promise<void>;
}

export function useRegistration({
  onSubmit,
  onSuccess,
  initialValues,
}: UseRegistrationOptions): UseRegistrationReturn {
  const [values, setValues] = useState<RegistrationValues>({
    username: initialValues?.username ?? '',
    password: initialValues?.password ?? '',
    firstName: initialValues?.firstName ?? '',
    lastName: initialValues?.lastName ?? '',
    companyName: initialValues?.companyName ?? '',
  });
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const submitLockRef = useRef(false);

  // 卸载时中止进行中的请求
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const setField = useCallback(
    (field: keyof RegistrationValues, value: string) => {
      setValues((prev) => ({ ...prev, [field]: value }));
      // 清除该字段错误和提交错误
      setErrors((prev) => ({ ...prev, [field]: undefined, submit: undefined }));
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    // 双击锁
    if (submitLockRef.current) return;
    submitLockRef.current = true;

    // 校验
    const validationErrors = validateAll(values);
    setErrors(validationErrors);
    if (!isValid(validationErrors)) {
      submitLockRef.current = false;
      return;
    }

    // 中止上一个请求（如果有）
    abortRef.current?.abort();

    // 创建新的 AbortController
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSubmitting(true);
    try {
      await onSubmit(normalizeRegistrationValues(values), controller.signal);
      // 如果请求未被中止，执行成功回调
      if (!controller.signal.aborted) {
        onSuccess?.();
      }
    } catch (err) {
      // 如果请求被中止（卸载），不更新状态
      if (!controller.signal.aborted) {
        setErrors((prev) => ({
          ...prev,
          submit: err instanceof Error ? err.message : '注册失败，请重试',
        }));
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsSubmitting(false);
      }
      submitLockRef.current = false;
    }
  }, [values, onSubmit, onSuccess]);

  return {
    values,
    errors,
    isSubmitting,
    setField,
    handleSubmit,
  };
}
