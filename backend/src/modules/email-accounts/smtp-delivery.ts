import { ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as net from 'net';
import * as tls from 'tls';

const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 40_000;

function abortError() {
  const error: any = new ServiceUnavailableException('SMTP dispatch was aborted');
  error.code = 'PROVIDER_DISPATCH_ABORTED';
  return error;
}

/**
 * Creates a one-action SMTP transport whose underlying pinned socket is owned
 * by this action. Aborting destroys that socket; it does not merely abandon the
 * sendMail promise.
 */
export function createAbortableSmtpTransport(
  options: any,
  auth: { user: string; pass: string },
  signal?: AbortSignal,
) {
  let activeSocket: net.Socket | tls.TLSSocket | null = null;

  const getSocket = (_transportOptions: any, callback: (error: Error | null, value?: any) => void) => {
    if (signal?.aborted) {
      callback(abortError());
      return;
    }
    let returned = false;
    const finish = (error: Error | null, value?: any) => {
      if (returned) return;
      returned = true;
      callback(error, value);
    };
    if (options.secure) {
      const socket = tls.connect({
        host: options.host,
        port: options.port,
        servername: options.tls?.servername,
        minVersion: options.tls?.minVersion || 'TLSv1.2',
        rejectUnauthorized: options.tls?.rejectUnauthorized !== false,
      });
      activeSocket = socket;
      socket.once('secureConnect', () => finish(null, { connection: socket, secured: true }));
      socket.once('error', (error) => finish(error));
      return;
    }
    const socket = net.connect({ host: options.host, port: options.port });
    activeSocket = socket;
    socket.once('connect', () => finish(null, { connection: socket, secured: false }));
    socket.once('error', (error) => finish(error));
  };

  const transporter = nodemailer.createTransport({
    ...options,
    auth,
    getSocket,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  } as any);
  let closed = false;
  const abortClose = () => close(true);
  const close = (aborted = false) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', abortClose);
    if (activeSocket && !activeSocket.destroyed) {
      activeSocket.destroy(aborted ? abortError() : undefined);
    }
    transporter.close?.();
  };
  signal?.addEventListener('abort', abortClose, { once: true });
  if (signal?.aborted) abortClose();
  return { transporter, close: () => close(false) };
}

function normalizeMailbox(value: unknown) {
  const raw = typeof value === 'string'
    ? value
    : String((value as any)?.address || '');
  const bracketed = raw.match(/<([^<>]+)>/);
  return String(bracketed?.[1] || raw).trim().toLowerCase();
}

export function assertSmtpAcceptedTarget(info: any, target: string) {
  const expected = normalizeMailbox(target);
  const accepted = Array.isArray(info?.accepted)
    ? info.accepted.map(normalizeMailbox).filter(Boolean)
    : [];
  if (!expected || !accepted.includes(expected)) {
    const rejection: any = new ServiceUnavailableException(
      'SMTP provider did not accept the intended recipient',
    );
    rejection.code = 'SMTP_RECIPIENT_REJECTED';
    rejection.providerDeliveryOutcome = 'REJECTED';
    rejection.providerAccepted = false;
    throw rejection;
  }
  return accepted;
}
