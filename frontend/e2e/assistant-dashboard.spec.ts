import { test, expect, type Page } from '@playwright/test';

const companyId = '11111111-1111-4111-8111-111111111111';

const agentRun = {
  id: '22222222-2222-4222-8222-222222222222',
  companyId,
  operatorUserId: 'user-1',
  kind: 'BACKGROUND_RESEARCH',
  status: 'RUNNING',
  inputDigest: '',
  subjectType: 'lead',
  subjectId: 'l1',
  result: null,
  errorCode: null,
  startedAt: new Date().toISOString(),
  completedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: [],
  authorizations: [],
};

const assistantRuntime = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  runtime: {
    engine: 'openclaw',
    release: '2026.7.1',
    status: 'READY',
    gatewayReady: true,
    adapterReady: true,
    modelReady: true,
    lastHeartbeatAt: new Date().toISOString(),
    errorCode: null,
  },
  wechatOwnerChannel: {
    status: 'CONNECTED',
    pluginReady: true,
    pairingExpiresAt: null,
    binding: {
      displayName: '茶茶',
      maskedAccount: 'wxid_***821',
      boundAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
    errorCode: null,
  },
  permissions: {
    canUseAssistant: true,
    canIssueWechatCommands: true,
    canAdminApprove: true,
    canManageChannel: true,
  },
  capabilities: [
    { id: 'crm.work_brief', status: 'ENABLED' },
    { id: 'crm.prepare_quote_delivery', status: 'APPROVAL_REQUIRED' },
    { id: 'external.confirmed_send', status: 'ENABLED' },
  ],
};

async function mockAuthenticatedCrm(
  page: Page,
  assistantRetryProbe?: { requestIds: string[]; failNext: boolean; delayMs?: number },
  pendingActions: unknown[] = [],
  historyTurns?: unknown[],
) {
  await page
    .context()
    .addCookies([{ name: 'token', value: 'e2e-token', domain: '127.0.0.1', path: '/' }]);
  await page.addInitScript(
    ({ companyId }) => {
      localStorage.setItem('access_token', 'e2e-token');
      localStorage.setItem('active_company_id', companyId);
    },
    { companyId },
  );

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({
        json: {
          id: 'user-1',
          email: 'admin@example.com',
          firstName: '茶茶',
          lastName: '',
          companies: [
            {
              id: companyId,
              name: 'Vaysen AI CRM',
              slug: 'vaysen',
              role: 'company_admin',
              isDefault: true,
            },
          ],
        },
      });
    }
    if (path.endsWith('/agent-runs/assistant/brief')) {
      return route.fulfill({
        json: {
          generatedAt: new Date().toISOString(),
          ai: { enabled: true, provider: 'zhipu', model: 'glm-4.5-air' },
          metrics: {
            leads: 36,
            newLeads: 2,
            pendingReminders: 7,
            overdueReminders: 2,
            todayReminders: 4,
            draftQuotes: 3,
            activeAgentRuns: 1,
          },
          leadStatusCounts: { new: 12, contacted: 9, quoted: 8, negotiating: 5, won: 2 },
          reminders: [
            {
              id: 'r1',
              title: '跟进美国快递袋客户',
              reason: '报价后 2 天未回复',
              priority: 'High',
              dueAt: new Date(Date.now() - 3600000).toISOString(),
              leadId: 'l1',
            },
            {
              id: 'r2',
              title: '确认牛皮纸袋打样参数',
              reason: '等待尺寸和印刷文件',
              priority: 'Medium',
              dueAt: new Date(Date.now() + 3600000).toISOString(),
              leadId: 'l2',
            },
          ],
          quotes: [],
          runs: [agentRun],
        },
      });
    }
    if (path.endsWith('/agent-runs/assistant/runtime')) {
      return route.fulfill({ json: assistantRuntime });
    }
    if (path.endsWith('/agent-runs/assistant/pending-actions')) {
      return route.fulfill({ json: pendingActions });
    }
    if (path.endsWith('/agent-runs/assistant/chat')) {
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON();
        if (assistantRetryProbe) {
          assistantRetryProbe.requestIds.push(input.requestId);
          if (assistantRetryProbe.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, assistantRetryProbe.delayMs));
          }
          if (assistantRetryProbe.failNext) {
            assistantRetryProbe.failNext = false;
            return route.fulfill({
              status: 503,
              json: { message: 'simulated response loss' },
            });
          }
        }
        return route.fulfill({
          json: {
            id: '33333333-3333-4333-8333-333333333333',
            input: input.message,
            output: '建议先处理 2 项逾期跟进，再审核 3 份报价草稿。所有外发内容均需人工确认。',
            createdAt: new Date().toISOString(),
            model: 'glm-4.5-air',
            actionProposal: null,
            accepted: false,
            acceptedAt: null,
            actionStatus: null,
            businessStatus: null,
            responseKind: 'CHAT',
            agentRunId: null,
            toolReceipts: [],
          },
        });
      }
      return route.fulfill({
        json: historyTurns ?? [{
          id: '44444444-4444-4444-8444-444444444444',
          input: '给当前客户做背调',
          output: '已创建客户背景调查任务，以下状态来自 CRM 任务记录。',
          createdAt: new Date().toISOString(),
          model: 'deterministic-router',
          actionProposal: null,
          accepted: false,
          acceptedAt: null,
          actionStatus: 'RUNNING',
          businessStatus: 'PROCESSING',
          responseKind: 'TASK_CREATED',
          agentRunId: agentRun.id,
          toolReceipts: [],
        }],
      });
    }
    if (path.endsWith('/agent-runs')) return route.fulfill({ json: [agentRun] });
    if (path.endsWith('/leads/assignment-notices')) return route.fulfill({ json: { total: 0 } });
    return route.fulfill({ json: { data: [], total: 0 } });
  });
}

test.describe('AI 业务助理与真实数据驾驶舱', () => {
  test('首页不再出现演示数据，悬浮助理可在桌面视口完整打开', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockAuthenticatedCrm(page);
    await page.goto('/');
    // The first dev-server route may still be compiling on a cold Playwright run.
    await expect(page.getByRole('heading', { name: '今天的业务驾驶舱' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('演示数据')).toHaveCount(0);
    await expect(page.getByText('客户总数')).toBeVisible();

    await page.getByLabel('打开 AI 业务助理').click();
    const panel = page.getByRole('region', { name: 'AI 业务助理' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('JY AI 业务助理')).toBeVisible();
    await expect(panel.getByRole('button', { name: '翻译/回复' })).toBeVisible();
    await expect(panel.getByTestId('assistant-runtime-status')).toHaveCount(0);
    await expect(page.getByTestId('assistant-orb-trigger')).toHaveCount(0);
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x || 0) + (box?.width || 0)).toBeLessThanOrEqual(1440);
    expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual(900);
    await page.screenshot({
      path: test.info().outputPath('dashboard-assistant.png'),
      fullPage: true,
    });
  });

  test('完整工作台具备聊天、待办、进行中和汇报', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockAuthenticatedCrm(page);
    await page.goto('/ai-workbench');
    await expect(page.getByRole('heading', { name: 'AI 业务助理工作台' })).toBeVisible();
    await expect(page.getByText('与业务助理对话')).toBeVisible();
    await expect(page.getByText('正在工作的事务')).toBeVisible();
    await expect(page.getByText('待办事务')).toBeVisible();
    await expect(page.getByText('业务简报')).toBeVisible();
    await expect(page.getByText('业务主管模式')).toBeVisible();
    await expect(page.getByText('已创建真实任务')).toBeVisible();
    await expect(page.getByText('建议/草稿 · 未执行外部操作')).toHaveCount(0);
    await expect(page.getByTestId('assistant-orb-trigger')).toHaveCount(0);
  });

  test('长对话保留在工作台内部滚动并默认收起较早历史', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const history = Array.from({ length: 12 }, (_, index) => ({
      id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
      input: `历史问题 ${index + 1}`,
      output: `历史答复 ${index + 1}`,
      createdAt: new Date(Date.now() + index * 1_000).toISOString(),
      model: 'glm-4.5-air',
      actionProposal: null,
      accepted: false,
      acceptedAt: null,
      actionStatus: null,
      businessStatus: null,
      responseKind: 'CHAT',
      agentRunId: null,
      toolReceipts: [],
    }));
    await mockAuthenticatedCrm(page, undefined, [], history);
    await page.goto('/ai-workbench');

    const scroll = page.getByTestId('assistant-conversation-scroll');
    await expect(scroll).toBeVisible();
    await expect(page.getByTestId('assistant-history-toggle')).toContainText('查看较早 4 轮');
    await expect(page.getByText('历史问题 1', { exact: true })).toHaveCount(0);
    await expect(page.getByText('历史问题 12', { exact: true })).toBeVisible();
    const scrollMetrics = await scroll.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.clientHeight).toBeLessThan(800);
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    await expect(page.getByRole('button', { name: '发送给 AI 业务助理' })).toBeInViewport();

    await page.getByTestId('assistant-history-toggle').click();
    await expect(page.getByText('历史问题 1', { exact: true })).toBeVisible();
    await expect(page.getByTestId('assistant-history-toggle')).toContainText('收起较早对话');
  });

  test('负责人微信创建的报价提案会进入 CRM 待确认收件箱', async ({ page }) => {
    await mockAuthenticatedCrm(page, undefined, [{
      id: '55555555-5555-4555-8555-555555555555',
      createdAt: new Date().toISOString(),
      source: 'WECHAT_OWNER',
      actionProposal: {
        kind: 'PREPARE_QUOTE_DELIVERY',
        status: 'REQUIRES_CONFIRMATION',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        quote: {
          id: '66666666-6666-4666-8666-666666666666',
          referenceNo: 'QT-20260715-0001',
          status: 'draft',
          totalAmount: '640',
          currency: 'USD',
          updatedAt: new Date().toISOString(),
        },
        target: {
          name: 'Sample Buyer',
          phone: '+12025550123',
          conversationId: '77777777-7777-4777-8777-777777777777',
        },
        safety: {
          automaticSend: false,
          requiresHumanConfirmation: true,
          requiresManualWhatsappSend: true,
        },
      },
    }]);
    await page.goto('/ai-workbench');

    const inbox = page.getByTestId('assistant-workbench-pending-actions');
    await expect(inbox).toBeVisible();
    await expect(inbox.getByText('来自负责人微信', { exact: false })).toBeVisible();
    await expect(inbox.getByText('QT-20260715-0001')).toBeVisible();
    await expect(inbox.getByRole('button', { name: '我已核对草稿，确认准备 PDF' })).toBeVisible();
    await expect(inbox).toContainText('不会自动发送给客户');
  });

  test('完整工作台在 1280 宽度使用两列且不产生横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await mockAuthenticatedCrm(page);
    await page.goto('/ai-workbench');
    const grid = page.getByTestId('assistant-workbench-grid');
    await expect(grid).toBeVisible();
    const layout = await grid.evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(layout.columns).toBe(2);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  });

  for (const surface of ['workbench', 'orb'] as const) {
    test(`${surface === 'workbench' ? '完整工作台' : '悬浮球'}网络失败后复用同一个 requestId`, async ({ page }) => {
      const probe = { requestIds: [] as string[], failNext: true };
      await mockAuthenticatedCrm(page, probe);
      await page.goto(surface === 'workbench' ? '/ai-workbench' : '/');

      const container = surface === 'workbench'
        ? page.locator('main')
        : page.getByRole('region', { name: 'AI 业务助理' });
      if (surface === 'orb') {
        await page.getByLabel('打开 AI 业务助理').click();
      }
      await expect(container.getByText('给当前客户做背调')).toBeVisible();

      const editor = container.getByPlaceholder(/交代工作|交代一项工作/);
      await editor.fill('检查网络失败幂等重试');
      await container.getByRole('button', { name: '发送给 AI 业务助理' }).click();

      const retry = surface === 'workbench'
        ? container.getByTestId('assistant-pending-retry')
        : container.getByTestId('assistant-orb-pending-retry');
      await expect(retry).toBeVisible();

      await page.reload();
      if (surface === 'orb') {
        await page.getByLabel('打开 AI 业务助理').click();
      }
      await expect(retry).toBeVisible();
      await retry.getByRole('button', { name: '重试上次消息' }).click();

      await expect.poll(() => probe.requestIds.length).toBe(2);
      expect(probe.requestIds[0]).toBe(probe.requestIds[1]);
      expect(probe.requestIds[0]).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
      await expect(retry).toHaveCount(0);
    });
  }

  test('两个标签页并发提交同一工作时只产生一个幂等请求号', async ({ page }) => {
    const probe = { requestIds: [] as string[], failNext: false, delayMs: 250 };
    await mockAuthenticatedCrm(page, probe);
    await page.goto('/ai-workbench');

    const secondPage = await page.context().newPage();
    await mockAuthenticatedCrm(secondPage, probe);
    await secondPage.goto('/ai-workbench');

    const firstEditor = page.getByPlaceholder(/交代工作|交代一项工作/);
    const secondEditor = secondPage.getByPlaceholder(/交代工作|交代一项工作/);
    await firstEditor.fill('并发创建客户背调');
    await secondEditor.fill('并发创建客户背调');
    await Promise.all([
      page.getByRole('button', { name: '发送给 AI 业务助理' }).click(),
      secondPage.getByRole('button', { name: '发送给 AI 业务助理' }).click(),
    ]);

    await expect.poll(() => probe.requestIds.length).toBe(2);
    expect(new Set(probe.requestIds).size).toBe(1);
    await secondPage.close();
  });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test(`WhatsApp 中业务助理在 ${viewport.width}x${viewport.height} 使用 412px 贴边抽屉`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockAuthenticatedCrm(page);
      await page.goto('/whatsapp/chat');
      await page.getByLabel('打开 AI 业务助理').click();

      const panel = page.getByRole('region', { name: 'AI 业务助理' });
      await expect(panel).toHaveAttribute('data-placement', 'whatsapp-drawer');
      await expect(page.getByTestId('assistant-orb-trigger')).toHaveCount(0);
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width).toBeCloseTo(412, 0);
      expect(box?.x).toBeCloseTo(viewport.width - 412, 0);
      expect(box?.y).toBeCloseTo(64, 0);
      expect((box?.y || 0) + (box?.height || 0)).toBeCloseTo(viewport.height, 0);
    });
  }
});
