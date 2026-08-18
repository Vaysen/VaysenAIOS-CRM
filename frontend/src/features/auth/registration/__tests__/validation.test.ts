import { describe, it, expect } from 'vitest';
import { validateField, validateAll, isValid } from '../validation';
import { normalizeRegistrationValues } from '../schema';
import type { RegistrationValues } from '../types';

describe('validation', () => {
  describe('normalizeRegistrationValues', () => {
    it('修剪文本字段、保留密码空格并将空公司名转为 undefined', () => {
      expect(
        normalizeRegistrationValues({
          username: '  chris  ',
          password: ' password123 ',
          firstName: ' John ',
          lastName: ' Smith ',
          companyName: '   ',
        }),
      ).toEqual({
        username: 'chris',
        password: ' password123 ',
        firstName: 'John',
        lastName: 'Smith',
        companyName: undefined,
      });
    });
  });

  describe('validateField', () => {
    it('username: 空值报错', () => {
      expect(validateField('username', '')).toBe('用户名不能为空');
    });

    it('username: 少于3字符报错', () => {
      expect(validateField('username', 'ab')).toBe('用户名至少3个字符');
    });

    it('username: 3字符通过', () => {
      expect(validateField('username', 'abc')).toBeUndefined();
    });

    it('password: 空值报错', () => {
      expect(validateField('password', '')).toBe('密码不能为空');
    });

    it('password: 少于12位报错', () => {
      expect(validateField('password', '12345678901')).toBe('密码至少12位');
    });

    it('password: 12位通过', () => {
      expect(validateField('password', '123456789012')).toBeUndefined();
    });

    it('firstName: 空值报错', () => {
      expect(validateField('firstName', '')).toBe('名不能为空');
    });

    it('firstName: 有值通过', () => {
      expect(validateField('firstName', 'John')).toBeUndefined();
    });

    it('lastName: 空值报错', () => {
      expect(validateField('lastName', '')).toBe('姓不能为空');
    });

    it('companyName: 可空，始终通过', () => {
      expect(validateField('companyName', '')).toBeUndefined();
      expect(validateField('companyName', 'ABC Co')).toBeUndefined();
    });
  });

  describe('validateAll', () => {
    it('全空值返回所有必填错误', () => {
      const errors = validateAll({
        username: '',
        password: '',
        firstName: '',
        lastName: '',
      });
      expect(errors.username).toBeDefined();
      expect(errors.password).toBeDefined();
      expect(errors.firstName).toBeDefined();
      expect(errors.lastName).toBeDefined();
      expect(errors.companyName).toBeUndefined();
    });

    it('全有效值返回无错误', () => {
      const values: RegistrationValues = {
        username: 'chris',
        password: 'password1234',
        firstName: 'John',
        lastName: 'Smith',
        companyName: 'ABC Co',
      };
      const errors = validateAll(values);
      expect(isValid(errors)).toBe(true);
    });
  });

  describe('isValid', () => {
    it('有空错误返回 false', () => {
      expect(isValid({ username: '不能为空' } as never)).toBe(false);
    });

    it('空对象返回 true', () => {
      expect(isValid({})).toBe(true);
    });
  });
});
