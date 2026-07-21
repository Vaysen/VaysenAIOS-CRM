/**
 * TASK-102F: 拒绝匹配候选 — 命令 DTO
 *
 * 用户明确判定两个 Lead 不是同一客户时, 保存 IdentityExclusion (对称),
 * 并将候选标记为 rejected。排除后, identity-resolution 引擎对同一对不再重复提示。
 */

/**
 * 拒绝候选命令。
 *
 * @property companyId   - 租户 ID (必填, 租户隔离)
 * @property actorId     - 执行拒绝的用户 ID (排除记录 createdById)
 * @property candidateId - IdentityMatchCandidate.id
 * @property reason      - 可选拒绝理由, 持久化到 IdentityExclusion.reason
 */
export interface RejectCandidateCommand {
  companyId: string;
  actorId: string;
  candidateId: string;
  reason?: string;
}
