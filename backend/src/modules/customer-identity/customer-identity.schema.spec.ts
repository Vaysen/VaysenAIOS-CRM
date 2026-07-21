import * as fs from 'fs';
import * as path from 'path';

/**
 * TASK-102A: 客户身份数据契约 Schema 约束测试
 *
 * 本测试读取 prisma/schema.prisma 源文件并断言统一客户身份模型的数据契约。
 * 测试不依赖数据库连接,仅校验 schema 文本,确保迁移可回滚且契约稳定。
 */
describe('TASK-102A customer-identity schema contract', () => {
  const schemaPath = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'prisma',
    'schema.prisma',
  );
  let schema: string;

  beforeAll(() => {
    schema = fs.readFileSync(schemaPath, 'utf-8');
  });

  describe('Lead.companyName 可空契约', () => {
    it('companyName 应声明为 String? (可空)', () => {
      // 在 Lead 模型块内查找 companyName 字段声明
      const leadBlock = extractModelBlock(schema, 'Lead');
      expect(leadBlock).not.toBeNull();

      const companyNameLine = leadBlock!.match(
        /companyName\s+String\??/,
      );
      expect(companyNameLine).not.toBeNull();
      // 必须是可空 String? (归一化空白后比较)
      expect(companyNameLine![0].replace(/\s+/g, ' ')).toBe(
        'companyName String?',
      );
    });

    it('Lead 应新增 companyNameSource String? 字段', () => {
      const leadBlock = extractModelBlock(schema, 'Lead');
      expect(leadBlock).not.toBeNull();
      expect(leadBlock!).toMatch(/companyNameSource\s+String\?/);
    });

    it('Lead 应新增 companyNameConfidence String? 字段', () => {
      const leadBlock = extractModelBlock(schema, 'Lead');
      expect(leadBlock).not.toBeNull();
      expect(leadBlock!).toMatch(/companyNameConfidence\s+String\?/);
    });
  });

  describe('Contact 名称可空契约', () => {
    it('firstName 应声明为 String? (可空)', () => {
      const contactBlock = extractModelBlock(schema, 'Contact');
      expect(contactBlock).not.toBeNull();

      const firstNameLine = contactBlock!.match(/firstName\s+String\??/);
      expect(firstNameLine).not.toBeNull();
      expect(firstNameLine![0].replace(/\s+/g, ' ')).toBe(
        'firstName String?',
      );
    });

    it('lastName 应声明为 String? (可空)', () => {
      const contactBlock = extractModelBlock(schema, 'Contact');
      expect(contactBlock).not.toBeNull();

      const lastNameLine = contactBlock!.match(/lastName\s+String\??/);
      expect(lastNameLine).not.toBeNull();
      expect(lastNameLine![0].replace(/\s+/g, ' ')).toBe(
        'lastName String?',
      );
    });

    it('Contact 应新增 displayName String? 字段', () => {
      const contactBlock = extractModelBlock(schema, 'Contact');
      expect(contactBlock).not.toBeNull();
      expect(contactBlock!).toMatch(/displayName\s+String\?/);
    });

    it('Contact 应新增 nameSource String? 字段', () => {
      const contactBlock = extractModelBlock(schema, 'Contact');
      expect(contactBlock).not.toBeNull();
      expect(contactBlock!).toMatch(/nameSource\s+String\?/);
    });

    it('Contact 应新增 nameConfidence String? 字段', () => {
      const contactBlock = extractModelBlock(schema, 'Contact');
      expect(contactBlock).not.toBeNull();
      expect(contactBlock!).toMatch(/nameConfidence\s+String\?/);
    });
  });

  describe('ExternalIdentity 模型契约', () => {
    it('model ExternalIdentity 应存在', () => {
      expect(extractModelBlock(schema, 'ExternalIdentity')).not.toBeNull();
    });

    it('应包含 @@unique([companyId, provider, externalId]) 唯一约束', () => {
      const block = extractModelBlock(schema, 'ExternalIdentity');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /@@unique\(\[companyId,\s*provider,\s*externalId\]\)/,
      );
    });

    it('应包含 companyId 租户隔离字段', () => {
      const block = extractModelBlock(schema, 'ExternalIdentity');
      expect(block).not.toBeNull();
      expect(block!).toMatch(/companyId\s+String/);
    });

    it('应包含 identityStatus 默认值 unresolved', () => {
      const block = extractModelBlock(schema, 'ExternalIdentity');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /identityStatus\s+String\s+@default\("unresolved"\)/,
      );
    });

    it('应包含 @@index([companyId, identityStatus]) 索引', () => {
      const block = extractModelBlock(schema, 'ExternalIdentity');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /@@index\(\[companyId,\s*identityStatus\]\)/,
      );
    });
  });

  describe('IdentityMatchCandidate 模型契约', () => {
    it('model IdentityMatchCandidate 应存在', () => {
      expect(extractModelBlock(schema, 'IdentityMatchCandidate')).not.toBeNull();
    });

    it('应包含 @@unique([companyId, sourceLeadId, targetLeadId]) 唯一约束', () => {
      const block = extractModelBlock(schema, 'IdentityMatchCandidate');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /@@unique\(\[companyId,\s*sourceLeadId,\s*targetLeadId\]\)/,
      );
    });

    it('应包含 score Int 字段', () => {
      const block = extractModelBlock(schema, 'IdentityMatchCandidate');
      expect(block).not.toBeNull();
      expect(block!).toMatch(/score\s+Int/);
    });

    it('应包含 status 默认值 pending', () => {
      const block = extractModelBlock(schema, 'IdentityMatchCandidate');
      expect(block).not.toBeNull();
      expect(block!).toMatch(/status\s+String\s+@default\("pending"\)/);
    });
  });

  describe('IdentityExclusion 模型契约', () => {
    it('model IdentityExclusion 应存在', () => {
      expect(extractModelBlock(schema, 'IdentityExclusion')).not.toBeNull();
    });

    it('应包含 @@unique([companyId, leftLeadId, rightLeadId]) 唯一约束', () => {
      const block = extractModelBlock(schema, 'IdentityExclusion');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /@@unique\(\[companyId,\s*leftLeadId,\s*rightLeadId\]\)/,
      );
    });

    it('应包含 @@index([companyId]) 索引', () => {
      const block = extractModelBlock(schema, 'IdentityExclusion');
      expect(block).not.toBeNull();
      expect(block!).toMatch(/@@index\(\[companyId\]\)/);
    });
  });

  describe('CustomerMergeAudit 模型契约', () => {
    it('model CustomerMergeAudit 应存在', () => {
      expect(extractModelBlock(schema, 'CustomerMergeAudit')).not.toBeNull();
    });

    it('应包含 beforeState / afterState / fieldChoices Json 字段', () => {
      const block = extractModelBlock(schema, 'CustomerMergeAudit');
      expect(block).not.toBeNull();
      expect(block!).toMatch(/beforeState\s+Json/);
      expect(block!).toMatch(/afterState\s+Json/);
      expect(block!).toMatch(/fieldChoices\s+Json/);
    });

    it('应包含 undoneAt DateTime? 字段以支持回滚', () => {
      const block = extractModelBlock(schema, 'CustomerMergeAudit');
      expect(block).not.toBeNull();
      expect(block!).toMatch(/undoneAt\s+DateTime\?/);
    });

    it('应包含 @@index([companyId, targetLeadId, createdAt]) 索引', () => {
      const block = extractModelBlock(schema, 'CustomerMergeAudit');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /@@index\(\[companyId,\s*targetLeadId,\s*createdAt\]\)/,
      );
    });

    it('审计记录关联 Lead 时禁止级联删除', () => {
      const block = extractModelBlock(schema, 'CustomerMergeAudit');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /@relation\("CustomerMergeAuditSource"[^)]*onDelete:\s*Restrict\)/,
      );
      expect(block!).toMatch(
        /@relation\("CustomerMergeAuditTarget"[^)]*onDelete:\s*Restrict\)/,
      );
    });
  });

  describe('ContactPoint 唯一约束保留', () => {
    it('应保留 @@unique([companyId, type, normalizedValue]) 唯一约束', () => {
      const block = extractModelBlock(schema, 'ContactPoint');
      expect(block).not.toBeNull();
      expect(block!).toMatch(
        /@@unique\(\[companyId,\s*type,\s*normalizedValue\]\)/,
      );
    });
  });
});

/**
 * 从 schema.prisma 文本中提取指定 model 的完整块 (含大括号内容)。
 * 返回 null 表示该 model 不存在。
 */
function extractModelBlock(schema: string, modelName: string): string | null {
  // 匹配 `model ModelName {` 并捕获到对应闭合大括号
  const header = new RegExp(`model\\s+${modelName}\\s*\\{`);
  const match = header.exec(schema);
  if (!match) {
    return null;
  }

  const startIndex = match.index + match[0].length;
  let depth = 1;
  let i = startIndex;
  while (i < schema.length && depth > 0) {
    if (schema[i] === '{') {
      depth++;
    } else if (schema[i] === '}') {
      depth--;
    }
    i++;
  }

  if (depth !== 0) {
    return null;
  }

  // 返回 model 块的内部内容 (不含外层大括号)
  return schema.slice(match.index, i);
}
