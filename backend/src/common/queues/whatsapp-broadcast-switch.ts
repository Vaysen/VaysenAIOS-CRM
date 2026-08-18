/**
 * whatsapp-broadcast-switch.ts
 *
 * R111 批次C：WhatsApp 批量营销安全开关（生产默认禁用）。
 *
 * 语义（fail-closed）：除非显式放行，否则广播执行一律 BLOCKED。
 * - WHATSAPP_BROADCAST_DISABLED=true（默认，未设置也视为 true）→ 禁用
 * - WHATSAPP_BROADCAST_DISABLED=false → 放行
 * - 兼容别名 WHATSAPP_BROADCAST_ENABLED=false → 禁用；=true → 放行
 *
 * 入队侧（marketing-campaigns.service）与 worker 侧（marketing-delivery.processor）
 * 共用此判定，避免两处语义漂移。
 */
export function isWhatsappBroadcastDisabled(): boolean {
  const disabled = process.env.WHATSAPP_BROADCAST_DISABLED;
  if (disabled !== undefined && disabled.trim() !== '') {
    return disabled.trim() !== 'false';
  }
  const enabled = process.env.WHATSAPP_BROADCAST_ENABLED;
  if (enabled !== undefined && enabled.trim() !== '') {
    return enabled.trim() !== 'true';
  }
  // 缺省：默认 true（生产安全开关，验证通过后由运维显式放行）
  return true;
}
