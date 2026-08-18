import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';

type SmtpRelay = {
  host: string;
  port: number;
  secure: boolean;
};

type ResolvedAddress = {
  address: string;
  family: number;
};

const DEFAULT_RELAYS = [
  'smtp-relay.brevo.com:465:tls',
  'smtp-relay.brevo.com:587:starttls',
];

function canonicalHost(value: unknown) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (
    !host
    || isIP(host)
    || host === 'localhost'
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
  ) {
    throw new BadRequestException('SMTP relay host is not a canonical public hostname');
  }
  return host;
}

function isProhibitedIpv4(octets: number[]) {
  return octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    || octets[0] === 10
      || octets[0] === 127
      || octets[0] === 0
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 192 && octets[1] === 0)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] === 2)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19)
      || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
      || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
      || octets[0] >= 224;
}

function expandIpv6(address: string): number[] | null {
  let value = address;
  const dotted = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    value = value.slice(0, -dotted[1].length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right,
  ].map((word) => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function embeddedIpv4(words: number[]): number[] | null {
  // IPv4-mapped IPv6 (::ffff:w.x.y.z)
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
  }
  // 6to4 (2002:WWXX:YYZZ::/48)
  if (words[0] === 0x2002) {
    return [words[1] >> 8, words[1] & 0xff, words[2] >> 8, words[2] & 0xff];
  }
  // Well-known NAT64 (64:ff9b::/96)
  if (
    words[0] === 0x64 && words[1] === 0xff9b
    && words.slice(2, 6).every((word) => word === 0)
  ) {
    return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
  }
  return null;
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().split('%')[0];
  if (isIP(normalized) === 4) {
    return isProhibitedIpv4(normalized.split('.').map(Number));
  }
  if (isIP(normalized) === 6) {
    const words = expandIpv6(normalized);
    if (!words) return true;
    const embedded = embeddedIpv4(words);
    return (embedded ? isProhibitedIpv4(embedded) : false)
      // Deprecated IPv4-compatible (::/96) and IPv4-translated
      // (::ffff:0:0/96) forms are never accepted as SMTP egress targets.
      || words.slice(0, 6).every((word) => word === 0)
      || (
        words.slice(0, 4).every((word) => word === 0)
        && words[4] === 0xffff
        && words[5] === 0
      )
      || words.every((word) => word === 0)
      || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
      || (words[0] & 0xfe00) === 0xfc00
      || (words[0] & 0xffc0) === 0xfe80
      || (words[0] & 0xff00) === 0xff00
      || (words[0] === 0x2001 && words[1] === 0x0db8)
      || (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1);
  }
  return true;
}

function configuredRelays(): SmtpRelay[] {
  const entries = String(process.env.SMTP_EGRESS_ALLOWED_RELAYS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...DEFAULT_RELAYS, ...entries].map((entry) => {
    const [rawHost, rawPort, mode] = entry.split(':');
    const host = canonicalHost(rawHost);
    const port = Number(rawPort);
    if (![465, 587].includes(port) || !['tls', 'starttls'].includes(mode)) {
      throw new BadRequestException('SMTP relay allowlist entries must use host:465:tls or host:587:starttls');
    }
    return { host, port, secure: mode === 'tls' };
  });
}

export async function resolveSmtpEgress(
  account: { smtpHost: string; smtpPort: number; smtpSecure: boolean },
  resolver: (hostname: string) => Promise<ResolvedAddress[]> = async (hostname) => (
    dnsLookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>
  ),
) {
  const host = canonicalHost(account.smtpHost);
  const port = Number(account.smtpPort);
  const secure = account.smtpSecure === true;
  if (!configuredRelays().some((relay) => (
    relay.host === host && relay.port === port && relay.secure === secure
  ))) {
    throw new BadRequestException('SMTP relay is not permitted by the server egress allowlist');
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new ServiceUnavailableException('SMTP relay DNS resolution failed');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new BadRequestException('SMTP relay resolved to a prohibited network address');
  }
  const pinned = addresses[0];
  return {
    // Nodemailer 6 does not honor an arbitrary transport-level lookup hook in
    // every SMTP path. Connect to the vetted address directly so a second DNS
    // lookup cannot redirect the socket, while retaining the relay hostname
    // for certificate verification and SNI.
    host: pinned.address,
    port,
    secure,
    requireTLS: !secure,
    tls: {
      servername: host,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    },
  };
}
