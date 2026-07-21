import type { Request } from 'express';

export type OpenClawRuntimeStatus = 'DISABLED' | 'STARTING' | 'READY' | 'DEGRADED' | 'OFFLINE';
export type OpenClawWechatStatus =
  | 'NOT_INSTALLED'
  | 'UNBOUND'
  | 'PAIRING'
  | 'WAITING_SCAN'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'EXPIRED'
  | 'ERROR';

export interface AuthenticatedOpenClawUser {
  id: string;
  email?: string;
  companies?: Array<{ id: string; role: string }>;
}

export interface VerifiedOpenClawRequest {
  bodyDigest: string;
  nonceDigest: string;
  keyId: string;
  canonicalPath: string;
}

export type OpenClawSignedRequest = Request & {
  rawBody?: Buffer;
  openClawVerified?: VerifiedOpenClawRequest;
};
