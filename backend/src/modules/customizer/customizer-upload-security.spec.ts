import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { validateCustomizerUpload } from './customizer-upload-security';

function upload(originalname: string, mimetype: string, buffer: Buffer): Express.Multer.File {
  return { originalname, mimetype, buffer, size: buffer.length } as Express.Multer.File;
}

describe('customizer upload security', () => {
  it('accepts a MIME/extension/magic matched PNG and PDF', () => {
    validateCustomizerUpload(upload('logo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'image');
    validateCustomizerUpload(upload('design.pdf', 'application/pdf', Buffer.from('%PDF-1.7')), 'pdf');
  });

  it.each([
    ['payload.svg', 'image/svg+xml', Buffer.from('<svg onload="alert(1)">')],
    ['payload.png', 'image/png', Buffer.from('<html><script>alert(1)</script>')],
    ['payload.jpg', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])],
  ])('rejects active or mismatched image content: %s', (name, mime, buffer) => {
    expect(() => validateCustomizerUpload(upload(name, mime, buffer), 'image')).toThrow(BadRequestException);
  });

  it('rejects a renamed non-PDF payload', () => {
    expect(() => validateCustomizerUpload(upload('payload.pdf', 'application/pdf', Buffer.from('<script>')), 'pdf'))
      .toThrow(BadRequestException);
  });

  it('keeps expensive processing routes behind the global JWT guard', () => {
    const source = fs.readFileSync(path.join(__dirname, 'customizer.controller.ts'), 'utf8');
    expect(source).not.toMatch(/@Public\(\)\s*@Post\('image\/(?:remove-bg|pdf-to-images)'\)/);
    expect(source).toContain('@RateLimit(10, 60_000)');
    expect(source).toContain('@RateLimit(5, 60_000)');
  });
});
