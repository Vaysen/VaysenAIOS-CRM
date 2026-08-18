/**
 * 纯注册表单组件 (FF-005)
 *
 * 无 API/router/store 依赖。
 * 由 adapter（真实页面或 demo 页面）传入 onSubmit 和 onSuccess。
 */
'use client';

import { type FormEvent } from 'react';
import {
  useRegistration,
  type UseRegistrationOptions,
} from './useRegistration';
import type { RegistrationValues } from './types';
import { RegistrationField } from './RegistrationField';

export type { RegistrationValues } from './types';

export interface RegistrationFormProps extends UseRegistrationOptions {
  className?: string;
}

export function RegistrationForm({
  onSubmit,
  onSuccess,
  initialValues,
  className,
}: RegistrationFormProps) {
  const { values, errors, isSubmitting, setField, handleSubmit } =
    useRegistration({ onSubmit, onSuccess, initialValues });

  const onFormSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void handleSubmit();
  };

  return (
    <form onSubmit={onFormSubmit} className={className} noValidate>
      <div className="grid grid-cols-2 gap-4">
        <RegistrationField
          id="register-firstName"
          label="名"
          value={values.firstName}
          onChange={(v) => setField('firstName', v)}
          error={errors.firstName}
          required
          placeholder="John"
          autoComplete="given-name"
        />
        <RegistrationField
          id="register-lastName"
          label="姓"
          value={values.lastName}
          onChange={(v) => setField('lastName', v)}
          error={errors.lastName}
          required
          placeholder="Smith"
          autoComplete="family-name"
        />
      </div>

      <RegistrationField
        id="register-username"
        label="用户名"
        value={values.username}
        onChange={(v) => setField('username', v)}
        error={errors.username}
        required
        placeholder="chris"
        autoComplete="username"
        minLength={3}
      />

      <RegistrationField
        id="register-password"
        label="密码"
        type="password"
        value={values.password}
        onChange={(v) => setField('password', v)}
        error={errors.password}
        required
        placeholder="至少12位"
        autoComplete="new-password"
        minLength={6}
      />

      <RegistrationField
        id="register-company"
        label="公司名称（选填）"
        value={values.companyName ?? ''}
        onChange={(v) => setField('companyName', v)}
        error={errors.companyName}
        placeholder="ABC Trading Co."
        autoComplete="organization"
      />

      {errors.submit && (
        <div
          className="mb-4 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400"
          role="alert"
        >
          {errors.submit}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-white font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
      >
        {isSubmitting ? '注册中...' : '注册'}
      </button>
    </form>
  );
}
