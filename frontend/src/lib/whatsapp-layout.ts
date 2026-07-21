export const QUOTE_PANEL_MIN_WIDTH = 420;
export const QUOTE_PANEL_MAX_WIDTH = 540;
export const QUOTE_PANEL_VIEWPORT_RATIO = 0.32;

export function getQuotePanelWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return QUOTE_PANEL_MAX_WIDTH;
  return Math.min(
    QUOTE_PANEL_MAX_WIDTH,
    Math.max(QUOTE_PANEL_MIN_WIDTH, Math.round(viewportWidth * QUOTE_PANEL_VIEWPORT_RATIO)),
  );
}
