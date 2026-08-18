import type { RegistrationValues } from './types';

export const REGISTRATION_LIMITS = {
  usernameMinLength: 3,
  passwordMinLength: 12,
} as const;

export function normalizeRegistrationValues(
  values: RegistrationValues,
): RegistrationValues {
  return {
    username: values.username.trim(),
    password: values.password,
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    companyName: values.companyName?.trim() || undefined,
  };
}
