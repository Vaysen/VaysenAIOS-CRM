export type CustomerRiskInput = {
  overdueTasks?: number;
  unreadMessages?: number;
  unrepliedOverThreeDays?: number;
  opportunitiesWithoutNextStep?: number;
  weakIdentity?: number;
  duplicateCandidates?: number;
};

export function buildCustomerRiskSummary(input: CustomerRiskInput, now = new Date()) {
  const items = Object.entries({
    overdueTasks: input.overdueTasks ?? 0,
    unreadMessages: input.unreadMessages ?? 0,
    unrepliedOverThreeDays: input.unrepliedOverThreeDays ?? 0,
    opportunitiesWithoutNextStep: input.opportunitiesWithoutNextStep ?? 0,
    weakIdentity: input.weakIdentity ?? 0,
    duplicateCandidates: input.duplicateCandidates ?? 0,
  }).filter(([, count]) => count > 0).map(([type, count]) => ({ type, count }));
  return { asOf: now.toISOString(), total: items.reduce((sum, item) => sum + item.count, 0), items };
}
