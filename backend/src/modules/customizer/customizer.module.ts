import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { CustomizerController } from './customizer.controller';
import { CustomizerAdminController } from './customizer-admin.controller';
import { CustomizerService } from './customizer.service';
import { CustomizerPricingService } from './customizer-pricing.service';
import { RateLimitInterceptor } from './rate-limit.interceptor';
import { FileValidationInterceptor } from './file-validation.interceptor';

const ASSETS_DIR = path.resolve(process.cwd(), '.customizer-assets', 'models');

// Ensure directory exists at module load time
if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

/* ========================================
   Customizer Module (TASK-046: Security)
   - Multer configured with file size limits and type filtering
   - GLB files only for 3D models (50MB max)
   - Rate limiting and file validation interceptors registered
   ======================================== */

@Module({
  imports: [
    MulterModule.register({
      storage: diskStorage({
        destination: (req, file, cb) => {
          cb(null, ASSETS_DIR);
        },
        filename: (req, file, cb) => {
          const templateId = req.params.id;
          const ext = path.extname(file.originalname) || '.glb';
          cb(null, `${templateId}-${Date.now()}${ext}`);
        },
      }),
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB for GLB models
      },
      fileFilter: (req, file, cb) => {
        // TASK-046: Strict file type validation
        // GLB files only for 3D model uploads
        if (
          file.mimetype === 'model/gltf-binary' ||
          file.mimetype === 'application/octet-stream' ||
          file.originalname.toLowerCase().endsWith('.glb')
        ) {
          cb(null, true);
        } else {
          cb(new Error('Only GLB files are allowed for 3D model uploads'), false);
        }
      },
    }),
  ],
  controllers: [CustomizerController, CustomizerAdminController],
  providers: [
    CustomizerService,
    CustomizerPricingService,
    RateLimitInterceptor,
    FileValidationInterceptor,
  ],
  exports: [CustomizerService, CustomizerPricingService],
})
export class CustomizerModule {}
