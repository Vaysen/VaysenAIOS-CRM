import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

type AllowedUpload = {
  extensions: readonly string[];
  storedExtension: string;
};

const ALLOWED_UPLOADS: Readonly<Record<string, AllowedUpload>> = Object.freeze({
  'image/jpeg': { extensions: ['.jpg', '.jpeg'], storedExtension: '.jpg' },
  'image/png': { extensions: ['.png'], storedExtension: '.png' },
  'image/webp': { extensions: ['.webp'], storedExtension: '.webp' },
  'image/gif': { extensions: ['.gif'], storedExtension: '.gif' },
  'application/pdf': { extensions: ['.pdf'], storedExtension: '.pdf' },
  'text/plain': { extensions: ['.txt'], storedExtension: '.txt' },
  'text/csv': { extensions: ['.csv'], storedExtension: '.csv' },
  'application/msword': { extensions: ['.doc'], storedExtension: '.doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['.docx'], storedExtension: '.docx',
  },
  'application/vnd.ms-excel': { extensions: ['.xls'], storedExtension: '.xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extensions: ['.xlsx'], storedExtension: '.xlsx',
  },
  'application/vnd.ms-powerpoint': { extensions: ['.ppt'], storedExtension: '.ppt' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    extensions: ['.pptx'], storedExtension: '.pptx',
  },
  'application/zip': { extensions: ['.zip'], storedExtension: '.zip' },
  'video/mp4': { extensions: ['.mp4'], storedExtension: '.mp4' },
  'video/webm': { extensions: ['.webm'], storedExtension: '.webm' },
  'video/quicktime': { extensions: ['.mov'], storedExtension: '.mov' },
  'audio/mpeg': { extensions: ['.mp3'], storedExtension: '.mp3' },
  'audio/mp4': { extensions: ['.m4a', '.mp4'], storedExtension: '.m4a' },
  'audio/ogg': { extensions: ['.ogg'], storedExtension: '.ogg' },
});

export function validateCommunicationUpload(file: Pick<Express.Multer.File, 'mimetype' | 'originalname'>): AllowedUpload {
  const mimeType = String(file?.mimetype || '').trim().toLowerCase();
  const originalExtension = path.extname(String(file?.originalname || '')).toLowerCase();
  const allowed = ALLOWED_UPLOADS[mimeType];

  if (!allowed || !allowed.extensions.includes(originalExtension)) {
    throw new BadRequestException('Unsupported attachment type or file extension');
  }

  return allowed;
}

export function createCommunicationUploadFilename(
  file: Pick<Express.Multer.File, 'mimetype' | 'originalname'>,
  random: () => Buffer = () => randomBytes(18),
): string {
  const allowed = validateCommunicationUpload(file);
  return `comm-${random().toString('hex')}${allowed.storedExtension}`;
}

export function getUploadsRoot(): string {
  return path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
}

export function ensureUploadsRoot(): string {
  const root = getUploadsRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new BadRequestException('Upload root is not a trusted directory');
  }
  return root;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve a WhatsApp attachment to an existing regular file under the real uploads root.
 * URL-style references must begin with /uploads/. Absolute paths are accepted only when
 * their real path is inside that root. Relative filesystem paths are deliberately rejected.
 */
export function resolveSafeUploadPath(reference: unknown, uploadsRoot = getUploadsRoot()): string {
  if (typeof reference !== 'string' || !reference.trim() || reference.includes('\0')) {
    throw new BadRequestException('Invalid attachment path');
  }

  const rootPath = path.resolve(uploadsRoot);
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BadRequestException('Upload root is not a trusted directory');
  }
  const realRoot = fs.realpathSync(rootPath);

  let candidate: string;
  if (reference.startsWith('/uploads/')) {
    const relativeReference = reference.slice('/uploads/'.length);
    if (!relativeReference || path.isAbsolute(relativeReference)) {
      throw new BadRequestException('Invalid attachment path');
    }
    candidate = path.resolve(rootPath, relativeReference);
  } else if (path.isAbsolute(reference)) {
    candidate = path.resolve(reference);
  } else {
    throw new BadRequestException('Attachment path must use /uploads/');
  }

  if (!isInsideRoot(rootPath, candidate)) {
    throw new BadRequestException('Attachment path escapes the upload directory');
  }

  // Reject every symbolic-link component, even when it resolves back inside the root.
  const relativeParts = path.relative(rootPath, candidate).split(path.sep).filter(Boolean);
  let current = rootPath;
  for (const part of relativeParts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new BadRequestException('Symbolic-link attachments are not allowed');
    }
  }

  const realCandidate = fs.realpathSync(candidate);
  if (!isInsideRoot(realRoot, realCandidate)) {
    throw new BadRequestException('Attachment path escapes the upload directory');
  }
  if (!fs.statSync(realCandidate).isFile()) {
    throw new BadRequestException('Attachment is not a regular file');
  }

  return realCandidate;
}

export function uploadResponseSecurityHeaders(filename: string): Record<string, string> {
  const safeName = path.basename(filename).replace(/[\r\n"\\]/g, '_');
  return {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `attachment; filename="${safeName}"`,
  };
}
