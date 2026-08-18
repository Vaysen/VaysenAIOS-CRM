/**
 * TASK-102F: 差异化客户合并 — 命令与预览 DTO
 *
 * 合并模式:
 * - trusted_defaults: 按字段优先级 (人工确认 > 验证导入 > 精确渠道 > 推断 > 不可信展示)
 *   自动选择胜出值, 调用方无需逐字段指定。
 * - field_choices: 调用方为每个字段显式指定 winner (source | target)。
 *
 * 乐观锁: targetUpdatedAt 必须与目标 Lead.updatedAt 一致, 否则拒绝合并。
 * 审计: before/after 快照 + fieldChoices + actor + targetVersion 全部持久化到 CustomerMergeAudit。
 */

/**
 * 可参与差异化合并的 Lead 字段集合。
 * 仅这四个字段进入 fieldDiffs / fieldChoices, 其余字段 (contactPoint 等) 走关系迁移。
 */
export type MergeableField = 'companyName' | 'country' | 'website' | 'industry';

/**
 * 单个字段的人工选择 (field_choices 模式)。
 */
export interface MergeFieldChoice {
  field: MergeableField;
  winner: 'source' | 'target';
}

/**
 * 合并命令。
 *
 * @property companyId       - 租户 ID (必填, 租户隔离)
 * @property actorId         - 执行合并的用户 ID (审计 actor)
 * @property candidateId     - IdentityMatchCandidate.id
 * @property targetUpdatedAt - 乐观锁: 调用方读取到的目标 Lead.updatedAt (ISO 字符串)
 * @property mode            - trusted_defaults | field_choices
 * @property fieldChoices    - field_choices 模式下的逐字段选择; trusted_defaults 下应留空
 */
export interface MergeCustomerCommand {
  companyId: string;
  actorId: string;
  candidateId: string;
  targetUpdatedAt: string;
  mode: 'trusted_defaults' | 'field_choices';
  fieldChoices: MergeFieldChoice[];
}

/**
 * 合并预览 — 调用方在确认前展示差异与影响范围。
 *
 * - fieldDiffs: 仅包含 source/target 不一致的字段, 并给出建议胜出方与原因。
 * - contactCount / contactPointCount / conversationCount: 关系迁移规模, 帮助评估影响。
 */
export interface MergePreview {
  /** 预览时目标客户的版本；确认合并必须原样回传。 */
  targetUpdatedAt: string;
  fieldDiffs: Array<{
    field: string;
    sourceValue: unknown;
    targetValue: unknown;
    suggestedWinner: 'source' | 'target';
    reason: string;
  }>;
  contactCount: { source: number; target: number };
  contactPointCount: { source: number; target: number };
  conversationCount: { source: number; target: number };
}

/**
 * 撤销合并命令。
 *
 * @property companyId - 租户 ID (必填, 租户隔离)
 * @property auditId   - CustomerMergeAudit.id
 * @property actorId   - 执行撤销的用户 ID (审计 undoneById)
 */
export interface UndoMergeCommand {
  companyId: string;
  auditId: string;
  actorId: string;
}
