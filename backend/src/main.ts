import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { loadEnvFile } from './config/load-env';
import { ensureUploadsRoot, uploadResponseSecurityHeaders } from './modules/communications/attachment-security';
import { buildHealthPayload } from './health-metadata';

loadEnvFile();

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // Preserve the exact bytes used by the OpenClaw HMAC broker. Controllers
  // still receive normal parsed JSON; only the fixed internal guard reads it.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Register /health on raw Express instance — bypasses NestJS global prefix
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.get('/health', (_req: any, res: any) => {
    res.json(buildHealthPayload());
  });

  // Serve uploaded files (images/PDFs/WhatsApp media) — 统一使用 process.cwd()
  const express = require('express');
  const path = require('path');
  const uploadsDir = ensureUploadsRoot();
  expressApp.use('/uploads', express.static(uploadsDir, {
    dotfiles: 'deny',
    fallthrough: false,
    setHeaders: (res: any, filePath: string) => {
      for (const [name, value] of Object.entries(uploadResponseSecurityHeaders(path.basename(filePath)))) {
        res.setHeader(name, value);
      }
    },
  }));

  // Serve customizer assets (processed images from TASK-014 image-processor)
  const customizerAssetsDir = path.join(__dirname, '..', '..', '.customizer-assets');
  expressApp.use('/customizer-assets', express.static(customizerAssetsDir));

  // Request logger — logs every incoming HTTP request for diagnostics
  expressApp.use((req: any, _res: any, next: any) => {
    logger.log(`${req.method} ${req.url}`);
    next();
  });

  app.setGlobalPrefix('api');

  app.use(helmet());
  app.use(compression());

  // CORS: strict in production, permissive in preview/dev.
  // Fail closed: NODE_ENV=production with no APP_MODE defaults to strict.
  const isPreview = process.env.APP_MODE === 'preview' || process.env.APP_MODE === 'development';
  const isProduction = !isPreview && process.env.NODE_ENV === 'production';

  const corsOriginEnv = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '';
  const allowedOrigins = new Set([
    'http://localhost:4001',
    'http://localhost:4002',
    'http://127.0.0.1:4001',
    'http://127.0.0.1:4002',
    ...corsOriginEnv.split(',').map((origin) => origin.trim()).filter(Boolean),
  ]);

  app.enableCors({
    origin: (origin, callback) => {
      // Production: strict CORS — only explicit allowlist.
      if (isProduction) {
        if (origin && !allowedOrigins.has(origin)) {
          callback(new Error(`CORS origin not allowed: ${origin}`));
          return;
        }
      }
      // Preview/dev: permissive (ZeroTier/LAN access).
      callback(null, true);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const enableSwagger = process.env.ENABLE_SWAGGER === 'true';
  if (enableSwagger) {
    const config = new DocumentBuilder()
      .setTitle('Vaysen AI CRM API')
      .setDescription('示例贸易公司 — 国际B2B外贸业务中台')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
    logger.log(`Swagger docs enabled at /api/docs`);
  }

  const port = process.env.PORT || 4000;
  await app.listen(port, '0.0.0.0');

  // Print registered routes for diagnostic purposes
  const server = app.getHttpServer();
  const router = server._events?.request?._router;
  if (router) {
    logger.log('Registered routes:');
    for (const layer of router.stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).join(',');
        logger.log(`  ${methods.toUpperCase()} ${layer.route.path}`);
      }
    }
  }

  logger.log(`Application running on http://0.0.0.0:${port}`);
  logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
