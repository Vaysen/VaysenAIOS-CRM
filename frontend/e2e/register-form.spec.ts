import { test, expect } from '@playwright/test';

test.describe('RegistrationForm (FF-005 五字段参考实现)', () => {
  test('renders all five inputs and a submit button on demo page', async ({ page }) => {
    await page.goto('/register-demo');

    await expect(page.getByLabel('名*', { exact: true })).toBeVisible();
    await expect(page.getByLabel('姓*', { exact: true })).toBeVisible();
    await expect(page.getByLabel('用户名*', { exact: true })).toBeVisible();
    await expect(page.getByLabel(/密码/)).toBeVisible();
    await expect(page.getByLabel(/公司名称/)).toBeVisible();
    await expect(page.getByRole('button', { name: /注册/ })).toBeVisible();
  });

  test('shows validation errors on empty submit', async ({ page }) => {
    await page.goto('/register-demo');

    await page.getByRole('button', { name: /注册/ }).click();

    await expect(page.getByText('用户名不能为空')).toBeVisible();
    await expect(page.getByText('密码不能为空')).toBeVisible();
    await expect(page.getByText('名不能为空', { exact: true })).toBeVisible();
    await expect(page.getByText('姓不能为空')).toBeVisible();
  });

  test('shows error when username is too short', async ({ page }) => {
    await page.goto('/register-demo');

    await page.getByLabel(/用户名/).fill('ab');
    await page.getByRole('button', { name: /注册/ }).click();

    await expect(page.getByText('用户名至少3个字符')).toBeVisible();
  });

  test('shows error when password is too short', async ({ page }) => {
    await page.goto('/register-demo');

    await page.getByLabel('名*', { exact: true }).fill('John');
    await page.getByLabel('姓*', { exact: true }).fill('Smith');
    await page.getByLabel('用户名*', { exact: true }).fill('chris');
    await page.getByLabel(/密码/).fill('12345');
    await page.getByRole('button', { name: /注册/ }).click();

    await expect(page.getByText('密码至少6位')).toBeVisible();
  });

  test('shows success message after valid submit', async ({ page }) => {
    await page.goto('/register-demo');

    await page.getByLabel('名*', { exact: true }).fill('John');
    await page.getByLabel('姓*', { exact: true }).fill('Smith');
    await page.getByLabel('用户名*', { exact: true }).fill('chris');
    await page.getByLabel(/密码/).fill('password123');
    await page.getByRole('button', { name: /注册/ }).click();

    await expect(page.getByTestId('success-message')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('success-message')).toContainText('chris');
  });

  test('disables submit button while submitting', async ({ page }) => {
    await page.goto('/register-demo');

    await page.getByLabel('名*', { exact: true }).fill('John');
    await page.getByLabel('姓*', { exact: true }).fill('Smith');
    await page.getByLabel('用户名*', { exact: true }).fill('chris');
    await page.getByLabel(/密码/).fill('password123');

    const submitButton = page.getByRole('button', { name: /注册/ });
    await submitButton.click();

    await expect(submitButton).toBeDisabled({ timeout: 5_000 });
  });
});
