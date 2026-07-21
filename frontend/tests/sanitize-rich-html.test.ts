import { describe, expect, it } from 'vitest';
import { sanitizeRichHtml } from '../src/lib/sanitize-rich-html';

describe('sanitizeRichHtml', () => {
  it('removes scriptable tags, handlers, dangerous URL schemes, and active CSS', () => {
    const dirty = '<script>alert(1)</script><img src="x" onerror="steal()">'
      + '<a href="javascript:steal()" onclick="steal()">bad</a>'
      + '<div style="background:url(https://evil.example/x)">content</div>'
      + '<iframe srcdoc="<script>steal()</script>"></iframe><form><input></form>';
    const clean = sanitizeRichHtml(dirty);
    expect(clean).not.toMatch(/script|onerror|onclick|javascript:|iframe|srcdoc|<form|<input/i);
    expect(clean).not.toContain('url(');
    expect(clean).toContain('content');
  });

  it('preserves safe business formatting and hardens links', () => {
    const clean = sanitizeRichHtml('<p style="color:#135790">Hello <a href="https://example.com">buyer</a></p>');
    expect(clean).toContain('color:#135790');
    expect(clean).toContain('https://example.com');
    expect(clean).toContain('rel="noopener noreferrer"');
  });
});
