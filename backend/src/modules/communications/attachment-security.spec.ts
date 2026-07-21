import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createCommunicationUploadFilename,
  resolveSafeUploadPath,
  uploadResponseSecurityHeaders,
  validateCommunicationUpload,
} from './attachment-security';

describe('communication attachment security', () => {
  it('accepts matched passive file types and creates an opaque server filename', () => {
    const file = { mimetype: 'image/png', originalname: '../../customer logo.png' } as Express.Multer.File;
    expect(validateCommunicationUpload(file)).toBeDefined();
    expect(createCommunicationUploadFilename(file, () => Buffer.alloc(18, 0xab)))
      .toBe(`comm-${'ab'.repeat(18)}.png`);
  });

  it.each([
    ['text/html', 'payload.html'],
    ['image/svg+xml', 'payload.svg'],
    ['application/javascript', 'payload.js'],
    ['application/xml', 'payload.xml'],
    ['image/png', 'payload.html'],
    ['text/plain', 'payload.svg'],
  ])('rejects active or MIME/extension-mismatched content: %s %s', (mimetype, originalname) => {
    expect(() => validateCommunicationUpload({ mimetype, originalname } as Express.Multer.File))
      .toThrow(BadRequestException);
  });

  it('only resolves regular, non-symlink files inside uploads', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-crm-upload-'));
    const uploads = path.join(sandbox, 'uploads');
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(uploads);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(uploads, 'safe.pdf'), 'safe');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

    try {
      expect(resolveSafeUploadPath('/uploads/safe.pdf', uploads)).toBe(fs.realpathSync(path.join(uploads, 'safe.pdf')));
      expect(() => resolveSafeUploadPath('/uploads/../../outside/secret.txt', uploads)).toThrow(BadRequestException);
      expect(() => resolveSafeUploadPath(path.join(outside, 'secret.txt'), uploads)).toThrow(BadRequestException);
      expect(() => resolveSafeUploadPath('safe.pdf', uploads)).toThrow(BadRequestException);

      const junction = path.join(uploads, 'linked');
      fs.symlinkSync(outside, junction, 'junction');
      expect(() => resolveSafeUploadPath('/uploads/linked/secret.txt', uploads)).toThrow(/Symbolic-link|escapes/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('forces downloads with nosniff and a sandboxed CSP', () => {
    expect(uploadResponseSecurityHeaders('file.html')).toEqual(expect.objectContaining({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': 'attachment; filename="file.html"',
    }));
  });
});
