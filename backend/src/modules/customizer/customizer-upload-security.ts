import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

export const CUSTOMIZER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CUSTOMIZER_PDF_MAX_BYTES = 15 * 1024 * 1024;

type UploadKind = 'image' | 'pdf';

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

export function validateCustomizerUpload(file: Express.Multer.File, kind: UploadKind): void {
  if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');

  const extension = path.extname(file.originalname || '').toLowerCase();
  const actualSize = Math.max(Number(file.size || 0), file.buffer.length);
  if (kind === 'pdf') {
    if (actualSize > CUSTOMIZER_PDF_MAX_BYTES) throw new BadRequestException('PDF file size exceeds 15MB limit');
    if (file.mimetype !== 'application/pdf' || extension !== '.pdf' || file.buffer.toString('ascii', 0, 5) !== '%PDF-') {
      throw new BadRequestException('File content is not a valid PDF upload');
    }
    return;
  }

  if (actualSize > CUSTOMIZER_IMAGE_MAX_BYTES) throw new BadRequestException('Image file size exceeds 10MB limit');
  const formats = [
    { mime: 'image/png', extensions: ['.png'], magic: isPng },
    { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], magic: isJpeg },
    { mime: 'image/webp', extensions: ['.webp'], magic: isWebp },
  ];
  const matched = formats.some((format) =>
    file.mimetype === format.mime && format.extensions.includes(extension) && format.magic(file.buffer));
  if (!matched) throw new BadRequestException('File content, MIME type and extension do not match a supported raster image');
}
