import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import * as path from 'path';

/* ========================================
   File Validation Interceptor (TASK-046)
   Validates uploaded files:
   - GLB files only for 3D models (max 50MB)
   - Image files only for logos (max 10MB)
   - Prevents malicious file uploads
   ======================================== */

export type FileValidationType = 'model' | 'image';

export const FILE_VALIDATION_KEY = 'fileValidation';

export interface FileValidationConfig {
  type: FileValidationType;
  maxSize: number; // bytes
  allowedMimeTypes: string[];
  allowedExtensions: string[];
}

const MODEL_VALIDATION: FileValidationConfig = {
  type: 'model',
  maxSize: 50 * 1024 * 1024, // 50MB
  allowedMimeTypes: ['model/gltf-binary', 'application/octet-stream'],
  allowedExtensions: ['.glb'],
};

const IMAGE_VALIDATION: FileValidationConfig = {
  type: 'image',
  maxSize: 10 * 1024 * 1024, // 10MB
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
  ],
  allowedExtensions: ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf'],
};

@Injectable()
export class FileValidationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();

    // Check for file validation metadata via reflector
    const handler = context.getHandler();
    const validationType: FileValidationType =
      (handler as any).__fileValidationType || 'model';

    const config =
      validationType === 'image' ? IMAGE_VALIDATION : MODEL_VALIDATION;

    // Get uploaded file (from multer)
    const file = (request as any).file;
    const files = (request as any).files;

    const allFiles: Express.Multer.File[] = [];
    if (file) allFiles.push(file);
    if (files && Array.isArray(files)) allFiles.push(...files);

    for (const f of allFiles) {
      if (!f) {
        throw new BadRequestException('No file uploaded');
      }

      // Validate file size
      if (f.size > config.maxSize) {
        const maxMB = Math.floor(config.maxSize / (1024 * 1024));
        throw new BadRequestException(
          `File size exceeds ${maxMB}MB limit (received ${Math.ceil(f.size / (1024 * 1024))}MB)`,
        );
      }

      // Validate file extension
      const ext = path.extname(f.originalname).toLowerCase();
      if (!config.allowedExtensions.includes(ext)) {
        throw new BadRequestException(
          `File type "${ext}" is not allowed. Allowed: ${config.allowedExtensions.join(', ')}`,
        );
      }

      // Validate MIME type (but be lenient for GLB which may be application/octet-stream)
      if (
        f.mimetype &&
        !config.allowedMimeTypes.includes(f.mimetype) &&
        config.type === 'image'
      ) {
        throw new BadRequestException(
          `MIME type "${f.mimetype}" is not allowed. Allowed: ${config.allowedMimeTypes.join(', ')}`,
        );
      }

      // Check for double extensions (e.g., file.exe.glb)
      const baseName = path.basename(f.originalname, ext);
      if (baseName.includes('.')) {
        const suspiciousExt = path.extname(baseName).toLowerCase();
        const dangerousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.php', '.js', '.asp', '.aspx'];
        if (dangerousExtensions.includes(suspiciousExt)) {
          throw new BadRequestException(
            'File name contains potentially dangerous extension',
          );
        }
      }

      // Validate file name length
      if (f.originalname.length > 255) {
        throw new BadRequestException('File name is too long (max 255 characters)');
      }
    }

    return next.handle();
  }
}

/* ========================================
   Decorator: @ValidateFile('image' | 'model')
   ======================================== */

import { SetMetadata } from '@nestjs/common';

export const ValidateFile = (type: FileValidationType = 'model') =>
  SetMetadata(FILE_VALIDATION_KEY, type);
