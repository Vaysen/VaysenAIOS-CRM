import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('WhatsApp Electron view layout contract', () => {
  it('uses the padding-free shell width without adding legacy negative-margin overflow', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/app/(dashboard)/whatsapp/chat/page.tsx'),
      'utf8',
    );

    expect(source).toContain('flex w-full min-w-0 overflow-hidden');
    expect(source).not.toMatch(/-m-5|lg:-m-6/);
    expect(source).toContain("height: 'calc(100vh - 64px)'");
    expect(source).toContain('const RIGHT_PANEL_WIDTH = 412');
    expect(source).toContain('w-[412px] shrink-0');
  });

  it('keeps the rendered quote panel width in sync with the Electron reservation', () => {
    const page = fs.readFileSync(
      path.join(process.cwd(), 'src/app/(dashboard)/whatsapp/chat/page.tsx'),
      'utf8',
    );
    const popup = fs.readFileSync(
      path.join(process.cwd(), 'src/components/communication/quote-pi-popup.tsx'),
      'utf8',
    );

    expect(page).toContain('getQuotePanelWidth(window.innerWidth)');
    expect(page).toContain('wa.whatsapp.setOverlayWidth(quoteFormType ? nextWidth : 0)');
    expect(popup).toContain('w-[clamp(420px,32vw,540px)]');
  });
});
