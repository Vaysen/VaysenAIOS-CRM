/**
 * 纯验证函数 (FF-005)
 *
 * 无副作用、无 I/O，可独立单元测试。
 * 规则：username ≥ 3 / password ≥ 12 / firstName 必填 / lastName 必填 / companyName 可空
 */
import type { RegistrationValues, RegistrationErrors } from './types';
import { REGISTRATION_LIMITS } from './schema';

/** 单字段校验 */
export function validateField(
  field: keyof RegistrationValues,
  value: string,
): string | undefined {
  switch (field) {
    case 'username':
      if (!value.trim()) return '用户名不能为空';
      if (value.trim().length < REGISTRATION_LIMITS.usernameMinLength) {
        return '用户名至少3个字符';
      }
      return undefined;

    case 'password':
      if (!value) return '密码不能为空';
      if (value.length < REGISTRATION_LIMITS.passwordMinLength) {
        return '密码至少12位';
      }
      return undefined;

    case 'firstName':
      if (!value.trim()) return '名不能为空';
      return undefined;

    case 'lastName':
      if (!value.trim()) return '姓不能为空';
      return undefined;

    case 'companyName':
      // 可选字段，不做校验
      return undefined;

    default:
      return undefined;
  }
}

/** 全字段校验，返回错误对象 */
export function validateAll(values: RegistrationValues): RegistrationErrors {
  return {
    username: validateField('username', values.username ?? ''),
    password: validateField('password', values.password ?? ''),
    firstName: validateField('firstName', values.firstName ?? ''),
    lastName: validateField('lastName', values.lastName ?? ''),
    companyName: validateField('companyName', values.companyName ?? ''),
  };
}

/** 是否通过校验（无任何错误） */
export function isValid(errors: RegistrationErrors): boolean {
  return !Object.values(errors).some((e) => e !== undefined);
}
