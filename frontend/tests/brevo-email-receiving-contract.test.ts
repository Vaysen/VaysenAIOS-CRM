import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Brevo email receiving contract', () => {
  it('uses the Brevo free SMTP preset and captures a CRM reply address', () => {
    const source = readSource('src/app/(dashboard)/email-accounts/new/page.tsx');

    expect(source).toContain("smtpHost: 'smtp-relay.brevo.com'");
    expect(source).toContain('smtpPort: 587');
    expect(source).toContain('replyToEmail');
    expect(source).toContain('Brevo 收信通过 Inbound Parsing 自动回写 CRM');
    expect(source).toContain('Brevo 账号必须填写有效的 Reply-To / CRM 收件地址');
  });

  it('shows whether each Brevo account has a receiving address', () => {
    const source = readSource('src/app/(dashboard)/email-accounts/page.tsx');

    expect(source).toContain('收件地址未配置');
    expect(source).toContain('收件：');
    expect(source).toContain('等待服务端激活');
    expect(source).toContain('/integrations/brevo/status');
  });

  it('does not fall back to demo messages when the real inbox is empty or unavailable', () => {
    const source = readSource('src/components/email/mail-three-column.tsx');

    expect(source).toContain('setMessages(data)');
    expect(source).toContain('setMessages([])');
    expect(source).not.toContain('setMessages(MOCK_MESSAGES)');
    expect(source).toContain('暂无真实邮件');
  });
});
