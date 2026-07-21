import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/Vaysen AI CRM/);
  });

  test('T112-001: login page uses the email contract (not username)', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('邮箱')).toBeVisible();
    await expect(page.getByPlaceholder(/@/)).toBeVisible();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    // 旧的「用户名」契约不应再出现
    await expect(page.getByText('用户名', { exact: true })).toHaveCount(0);
  });
});
