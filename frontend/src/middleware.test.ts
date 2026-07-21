import { describe, expect, it } from 'vitest';

import { shouldBypassAuth } from './middleware';

describe('middleware public assets', () => {
  it.each(['/logo.png', '/widget.css', '/widget.js'])('allows the exact public asset %s', (pathname) => {
    expect(shouldBypassAuth(pathname)).toBe(true);
  });

  it.each(['/logo.png-private', '/widget.css/admin', '/widget.js.map', '/admin/logo.png'])(
    'does not allow an asset lookalike path %s',
    (pathname) => {
      expect(shouldBypassAuth(pathname)).toBe(false);
    },
  );
});
