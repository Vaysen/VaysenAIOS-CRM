/**
 * TASK-102D: ContactsSyncDto 校验测试
 *
 * 验证 class-validator 在 /whatsapp/electron-webhook/contacts 上生效:
 * - 合法快照通过
 * - 缺少 externalId 被拒
 * - externalIdKind 非法值被拒
 * - 群组标记仍可透传(后端负责跳过)
 * - 主进程透传的 timestamp/total 兼容字段被接受
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ContactsSyncDto, WhatsAppContactSnapshotDto } from './electron-contacts.dto';

async function violations(obj: any): Promise<string[]> {
  const dto = plainToInstance(ContactsSyncDto, obj) as ContactsSyncDto;
  const errors = await validate(dto);
  return collectConstraintNames(errors);
}

function collectConstraintNames(errors: any[]): string[] {
  const names: string[] = [];
  for (const e of errors) {
    if (e.constraints) names.push(...Object.keys(e.constraints));
    if (e.children && e.children.length) {
      names.push(...collectConstraintNames(e.children));
    }
  }
  return names;
}

describe('ContactsSyncDto — TASK-102D', () => {
  const validSnapshot = {
    externalId: '8613800001234@c.us',
    externalIdKind: 'phone_jid',
    phoneCandidate: '8613800001234',
    displayNameCandidate: 'Alice',
    isGroup: false,
    isSelf: false,
    observedAt: 1717_000_000_000,
  };

  it('合法载荷通过校验', async () => {
    const errors = await violations({
      accountId: 'acct-1',
      contacts: [validSnapshot],
      timestamp: Date.now(),
      total: 1,
    });
    expect(errors).toHaveLength(0);
  });

  it('LID 快照(phoneCandidate=null)通过校验', async () => {
    const errors = await violations({
      accountId: 'acct-1',
      contacts: [
        { ...validSnapshot, externalId: '234977878868136@lid', externalIdKind: 'lid', phoneCandidate: null },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it('缺少 externalId 被拒', async () => {
    const errors = await violations({
      accountId: 'acct-1',
      contacts: [{ ...validSnapshot, externalId: undefined }],
    });
    expect(errors).toContain('isString');
  });

  it('externalIdKind 非法值被拒', async () => {
    const errors = await violations({
      accountId: 'acct-1',
      contacts: [{ ...validSnapshot, externalIdKind: 'foo' }],
    });
    expect(errors).toContain('isEnum');
  });

  it('缺少 accountId 被拒', async () => {
    const errors = await violations({ contacts: [validSnapshot] });
    expect(errors).toContain('isString');
  });

  it('observedAt 非数字被拒', async () => {
    const errors = await violations({
      accountId: 'acct-1',
      contacts: [{ ...validSnapshot, observedAt: 'not-a-number' }],
    });
    expect(errors).toContain('isNumber');
  });
});
