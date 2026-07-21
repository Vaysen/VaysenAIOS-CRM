import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenClawSignedRequest } from './openclaw.types';

const MAX_SIGNED_BODY_BYTES = 64 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 60;

@Injectable()
export class OpenClawHmacGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OpenClawSignedRequest>();
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new ServiceUnavailableException('OpenClaw raw-body verification is unavailable');
    }
    if (rawBody.length > MAX_SIGNED_BODY_BYTES) throw new PayloadTooLargeException();

    const keyId = this.singleHeader(request.headers['x-openclaw-key-id']);
    const timestampHeader = this.singleHeader(request.headers['x-openclaw-timestamp']);
    const nonce = this.singleHeader(request.headers['x-openclaw-nonce']);
    const signature = this.singleHeader(request.headers['x-openclaw-signature']).toLowerCase();
    const configuredKeyId = (process.env.OPENCLAW_CRM_HMAC_KEY_ID || '').trim();
    const secret = process.env.OPENCLAW_CRM_HMAC_SECRET || '';
    if (!configuredKeyId || Buffer.byteLength(secret, 'utf8') < 48) {
      throw new ServiceUnavailableException('OpenClaw internal authentication is not configured');
    }
    if (keyId !== configuredKeyId) throw new UnauthorizedException('Invalid OpenClaw key id');
    if (!/^[A-Za-z0-9._~-]{16,128}$/.test(nonce)) {
      throw new UnauthorizedException('Invalid OpenClaw nonce');
    }
    if (!/^[a-f0-9]{64}$/.test(signature)) {
      throw new UnauthorizedException('Invalid OpenClaw signature');
    }

    const timestamp = Number(timestampHeader);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!/^\d{10}$/.test(timestampHeader) || !Number.isSafeInteger(timestamp)) {
      throw new UnauthorizedException('Invalid OpenClaw timestamp');
    }
    if (Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
      throw new UnauthorizedException('Expired OpenClaw request');
    }

    const canonicalPath = this.canonicalPath(request.originalUrl || request.url || '');
    const bodyDigest = createHash('sha256').update(rawBody).digest('hex');
    const canonical = `${timestampHeader}\n${nonce}\n${request.method.toUpperCase()}\n${canonicalPath}\n${bodyDigest}`;
    const expected = createHmac('sha256', secret).update(canonical, 'utf8').digest();
    const provided = Buffer.from(signature, 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
      throw new UnauthorizedException('Invalid OpenClaw signature');
    }

    const nonceDigest = createHash('sha256').update(`${keyId}\n${nonce}`, 'utf8').digest('hex');
    try {
      await this.prisma.openClawRequestNonce.create({
        data: {
          nonceDigest,
          keyId,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('OpenClaw nonce was already used');
      throw error;
    }
    request.openClawVerified = { bodyDigest, nonceDigest, keyId, canonicalPath };
    return true;
  }

  private singleHeader(value: string | string[] | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private canonicalPath(value: string): string {
    const path = value.split('?')[0] || '';
    if (!path.startsWith('/') || path.includes('\\') || path.includes('//')) {
      throw new UnauthorizedException('Invalid OpenClaw request path');
    }
    return path;
  }

  private isUniqueViolation(error: unknown): boolean {
    return !!error && typeof error === 'object' && (error as { code?: string }).code === 'P2002';
  }
}
