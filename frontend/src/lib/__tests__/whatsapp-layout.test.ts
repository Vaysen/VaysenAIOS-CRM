import {
  getQuotePanelWidth,
  QUOTE_PANEL_MAX_WIDTH,
  QUOTE_PANEL_MIN_WIDTH,
} from '../whatsapp-layout';

describe('WhatsApp quote panel responsive layout', () => {
  it('uses 540px at the reported 1920px desktop viewport', () => {
    expect(getQuotePanelWidth(1920)).toBe(540);
  });

  it('shrinks in the common 1440px window without dropping below the usable minimum', () => {
    expect(getQuotePanelWidth(1440)).toBe(461);
    expect(getQuotePanelWidth(1280)).toBe(QUOTE_PANEL_MIN_WIDTH);
  });

  it('caps large screens and handles invalid measurements safely', () => {
    expect(getQuotePanelWidth(2560)).toBe(QUOTE_PANEL_MAX_WIDTH);
    expect(getQuotePanelWidth(Number.NaN)).toBe(QUOTE_PANEL_MAX_WIDTH);
  });
});
