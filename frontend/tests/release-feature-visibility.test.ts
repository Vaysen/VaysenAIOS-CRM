import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_FEATURES } from '../src/config/release-features';

describe('customer delivery feature visibility', () => {
  it('keeps unfinished AI voice customer service disabled', () => {
    expect(RELEASE_FEATURES.aiVoiceCustomerService).toBe(false);
  });

  it('gates both the navigation entry and direct route', () => {
    const sidebar = fs.readFileSync(
      path.join(process.cwd(), 'src/components/layout/sidebar.tsx'),
      'utf8',
    );
    const page = fs.readFileSync(
      path.join(process.cwd(), 'src/app/(dashboard)/voice-service/page.tsx'),
      'utf8',
    );

    expect(sidebar).toContain('RELEASE_FEATURES.aiVoiceCustomerService');
    expect(page).toContain("router.replace('/')");
    expect(page).toContain('if (!RELEASE_FEATURES.aiVoiceCustomerService) return null');
  });
});
