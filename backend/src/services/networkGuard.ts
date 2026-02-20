import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../config/env.js';

type OutboundHostValidationOptions = {
  context?: string;
};

export type SafeOutboundTarget = {
  host: string;
  address: string;
  family: 4 | 6;
};

const IPV4_PRIVATE_RANGES: Array<{ base: number; maskBits: number }> = [
  { base: 0x00000000, maskBits: 8 }, // 0.0.0.0/8
  { base: 0x0a000000, maskBits: 8 }, // 10.0.0.0/8
  { base: 0x64400000, maskBits: 10 }, // 100.64.0.0/10
  { base: 0x7f000000, maskBits: 8 }, // 127.0.0.0/8
  { base: 0xa9fe0000, maskBits: 16 }, // 169.254.0.0/16
  { base: 0xac100000, maskBits: 12 }, // 172.16.0.0/12
  { base: 0xc0000000, maskBits: 24 }, // 192.0.0.0/24
  { base: 0xc0a80000, maskBits: 16 }, // 192.168.0.0/16
  { base: 0xc6120000, maskBits: 15 }, // 198.18.0.0/15
  { base: 0xe0000000, maskBits: 4 }, // 224.0.0.0/4
  { base: 0xf0000000, maskBits: 4 }, // 240.0.0.0/4
];

type Ipv6Prefix = {
  base: bigint;
  maskBits: number;
};

const ipv4ToInt = (value: string): number | null => {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const parsed = Number(part);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
      return null;
    }
    result = (result << 8) + parsed;
  }
  return result >>> 0;
};

const isIPv4InCidrRange = (ip: number, range: { base: number; maskBits: number }) => {
  const mask = range.maskBits === 0 ? 0 : ((0xffffffff << (32 - range.maskBits)) >>> 0);
  return (ip & mask) === (range.base & mask);
};

const isPrivateOrReservedIpv4 = (value: string) => {
  const asInt = ipv4ToInt(value);
  if (asInt === null) return true;
  return IPV4_PRIVATE_RANGES.some((range) => isIPv4InCidrRange(asInt, range));
};

const IPV6_SEGMENT_PATTERN = /^[0-9a-f]{1,4}$/i;

const parseIpv6ToBigInt = (value: string): bigint | null => {
  const normalized = value.trim().toLowerCase().split('%')[0];
  if (!normalized || normalized.includes(':::')) {
    return null;
  }

  let expanded = normalized;
  if (expanded.includes('.')) {
    const splitAt = expanded.lastIndexOf(':');
    if (splitAt < 0) {
      return null;
    }
    const ipv4Tail = expanded.slice(splitAt + 1);
    const ipv4AsInt = ipv4ToInt(ipv4Tail);
    if (ipv4AsInt === null) {
      return null;
    }
    const high = ((ipv4AsInt >>> 16) & 0xffff).toString(16);
    const low = (ipv4AsInt & 0xffff).toString(16);
    expanded = `${expanded.slice(0, splitAt)}:${high}:${low}`;
  }

  const separatorIndex = expanded.indexOf('::');
  if (separatorIndex !== -1 && separatorIndex !== expanded.lastIndexOf('::')) {
    return null;
  }

  const hasElision = separatorIndex !== -1;
  const [headPart, tailPart = ''] = hasElision ? expanded.split('::') : [expanded, ''];
  const head = headPart ? headPart.split(':').filter(Boolean) : [];
  const tail = tailPart ? tailPart.split(':').filter(Boolean) : [];

  if (
    head.some((part) => !IPV6_SEGMENT_PATTERN.test(part))
    || tail.some((part) => !IPV6_SEGMENT_PATTERN.test(part))
  ) {
    return null;
  }

  if (hasElision) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 1) {
      return null;
    }
    const merged = [...head, ...new Array(missing).fill('0'), ...tail];
    if (merged.length !== 8) {
      return null;
    }
    return merged.reduce(
      (acc, segment) => (acc << 16n) + BigInt(parseInt(segment, 16)),
      0n,
    );
  }

  if (head.length !== 8) {
    return null;
  }

  return head.reduce(
    (acc, segment) => (acc << 16n) + BigInt(parseInt(segment, 16)),
    0n,
  );
};

const makeIpv6Prefix = (base: string, maskBits: number): Ipv6Prefix => {
  const parsed = parseIpv6ToBigInt(base);
  if (parsed === null) {
    throw new Error(`invalid ipv6 prefix: ${base}/${maskBits}`);
  }
  return { base: parsed, maskBits };
};

const IPV6_PRIVATE_PREFIXES: Ipv6Prefix[] = [
  makeIpv6Prefix('::', 128), // unspecified
  makeIpv6Prefix('::1', 128), // loopback
  makeIpv6Prefix('::', 96), // ipv4-compatible/deprecated
  makeIpv6Prefix('fc00::', 7), // unique local addresses
  makeIpv6Prefix('fe80::', 10), // link local
  makeIpv6Prefix('ff00::', 8), // multicast
];

const IPV6_MAPPED_IPV4_PREFIX = makeIpv6Prefix('::ffff:0:0', 96);

const isIpv6InPrefix = (address: bigint, prefix: Ipv6Prefix) => {
  if (prefix.maskBits <= 0) {
    return true;
  }
  const shift = BigInt(128 - prefix.maskBits);
  const mask = ((1n << BigInt(prefix.maskBits)) - 1n) << shift;
  return (address & mask) === (prefix.base & mask);
};

const isIpv4MappedIpv6 = (address: bigint) => isIpv6InPrefix(address, IPV6_MAPPED_IPV4_PREFIX);

const isPrivateOrReservedIpv6 = (value: string) => {
  const parsed = parseIpv6ToBigInt(value);
  if (parsed === null) {
    return true;
  }

  if (isIpv4MappedIpv6(parsed)) {
    const mappedIpv4 = Number(parsed & 0xffffffffn);
    const text = [
      (mappedIpv4 >>> 24) & 255,
      (mappedIpv4 >>> 16) & 255,
      (mappedIpv4 >>> 8) & 255,
      mappedIpv4 & 255,
    ].join('.');
    return isPrivateOrReservedIpv4(text);
  }

  return IPV6_PRIVATE_PREFIXES.some((prefix) => isIpv6InPrefix(parsed, prefix));
};

const normalizeHost = (value: string) => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const isBlockedHostname = (value: string) => {
  const normalized = normalizeHost(value);
  return (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
  );
};

const isPrivateOrReservedIp = (value: string) => {
  const family = net.isIP(value);
  if (family === 4) return isPrivateOrReservedIpv4(value);
  if (family === 6) return isPrivateOrReservedIpv6(value);
  return true;
};

const mustAllowPrivateTargets = () => env.allowPrivateNetworkTargets || env.nodeEnv === 'test';

const badRequest = (message: string) => {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 400;
  return error;
};

const pickPreferredLookupAddress = (
  lookupResult: Array<{ address: string; family: number }>,
) => lookupResult.find((entry) => entry.family === 4) ?? lookupResult[0];

export const resolveSafeOutboundHost = async (
  hostInput: string,
  options: OutboundHostValidationOptions = {},
): Promise<SafeOutboundTarget> => {
  const context = options.context ?? 'host';
  const host = normalizeHost(String(hostInput ?? ''));
  if (!host) {
    throw badRequest(`${context} is required`);
  }

  const directIpFamily = net.isIP(host);
  if (directIpFamily > 0) {
    if (!mustAllowPrivateTargets() && isPrivateOrReservedIp(host)) {
      throw badRequest(`${context} targets a private or reserved IP`);
    }
    return {
      host,
      address: host,
      family: directIpFamily as 4 | 6,
    };
  }

  if (!mustAllowPrivateTargets() && isBlockedHostname(host)) {
    throw badRequest(`${context} targets a blocked hostname`);
  }

  const lookupResult = await dns.lookup(host, { all: true, verbatim: true }).catch(() => null);
  if (!lookupResult || lookupResult.length === 0) {
    throw badRequest(`${context} could not be resolved`);
  }

  if (!mustAllowPrivateTargets()) {
    for (const resolved of lookupResult) {
      if (isPrivateOrReservedIp(resolved.address)) {
        throw badRequest(`${context} resolves to a private or reserved IP`);
      }
    }
  }

  const selected = pickPreferredLookupAddress(lookupResult);
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw badRequest(`${context} could not be resolved`);
  }

  return {
    host,
    address: selected.address,
    family: selected.family,
  };
};

export const assertSafeOutboundHost = async (
  hostInput: string,
  options: OutboundHostValidationOptions = {},
) => {
  await resolveSafeOutboundHost(hostInput, options);
};

export const assertSafePushEndpoint = async (endpointInput: string) => {
  const endpoint = String(endpointInput ?? '').trim();
  if (!endpoint) {
    throw badRequest('push endpoint is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw badRequest('push endpoint is invalid');
  }

  if (parsed.protocol !== 'https:') {
    throw badRequest('push endpoint must use https');
  }

  await assertSafeOutboundHost(parsed.hostname, { context: 'push endpoint host' });
};
