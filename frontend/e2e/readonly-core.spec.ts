import { test, expect } from '@playwright/test';

/**
 * TASK-112 核心只读 E2E（Web 端）
 *
 * 未认证只读链路：登录页 + 受保护路由的安全跳转。
 * 绝不发送任何消息 / 邮件 / 报价，仅做导航与可见性断言。
 * 依赖受管后端（E2E_BASE_URL，默认 http://127.0.0.1:3100）。
 */
test.describe('T112 核心只读旅程（Web）', () => {
  test('登录页展示邮箱契约且关键区域可加载', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('邮箱')).toBeVisible();
    await expect(page.getByPlaceholder(/@/)).toBeVisible();
  });

  test('受保护核心路由不会返回服务器错误', async ({ page }) => {
    const routes = ['/', '/customers', '/leads', '/communications'];
    for (const route of routes) {
      const resp = await page.goto(route);
      // 未登录环境允许渲染登录页或 HTTP 重定向，但不允许 5xx。
      expect([200, 301, 302, 307, 308]).toContain(resp?.status());
      await expect(page).toHaveURL(/login|customers|leads|communications|\/$/);
    }
  });
});
