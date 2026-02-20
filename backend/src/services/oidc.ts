import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.js';

type OidcPayload = JWTPayload & {
  email?: unknown;
  name?: unknown;
  preferred_username?: unknown;
  azp?: unknown;
  email_verified?: unknown;
  oid?: unknown;
  uid?: unknown;
  user_id?: unknown;
};

export interface VerifiedOidcIdentity {
  subject: string;
  email: string;
  name: string;
}

const normalizeIssuer = (value: string) => value.trim().replace(/\/+$/, '');

const toNonEmptyString = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const resolveConfiguredJwksUri = () => {
  const configured = toNonEmptyString(env.oidc.jwksUri);
  if (configured) {
    return configured;
  }
  return '';
};

const resolveJwksUri = async () => {
  const configured = resolveConfiguredJwksUri();
  if (configured) {
    return configured;
  }
  const discoveryUrl = `${normalizeIssuer(env.oidc.issuerUrl)}/.well-known/openid-configuration`;
  try {
    const response = await fetch(discoveryUrl);
    if (response.ok) {
      const payload = await response.json() as { jwks_uri?: unknown };
      const discovered = toNonEmptyString(payload.jwks_uri);
      if (discovered) {
        return discovered;
      }
    }
  } catch {
  }
  return `${normalizeIssuer(env.oidc.issuerUrl)}/protocol/openid-connect/certs`;
};

const oidcIssuer = normalizeIssuer(env.oidc.issuerUrl);
let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;
const getJwks = async () => {
  if (!jwksPromise) {
    jwksPromise = resolveJwksUri().then((uri) => createRemoteJWKSet(new URL(uri)));
  }
  return jwksPromise;
};
const allowedAlgorithms = (env.oidc.allowedAlgs.length > 0 ? env.oidc.allowedAlgs : ['RS256'])
  .map((value) => value.trim())
  .filter((value) => /^(RS|PS|ES|EdDSA)/.test(value));

if (allowedAlgorithms.length === 0) {
  throw new Error('OIDC_ALLOWED_ALGS must include at least one asymmetric JWT algorithm');
}

const isBooleanTrue = (value: unknown) => {
  if (value === true) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return false;
};

const configuredClientIds = (env.oidc.clientId || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const tokenMatchesAllowedClient = (payload: OidcPayload, allowedClientIds: string[]): boolean => {
  const expected = new Set(allowedClientIds.map((value) => toNonEmptyString(value)).filter(Boolean));
  if (expected.size === 0) {
    return false;
  }

  const azp = toNonEmptyString(payload.azp);
  if (azp && expected.has(azp)) {
    return true;
  }

  const clientIdClaim = toNonEmptyString((payload as { client_id?: unknown }).client_id);
  if (clientIdClaim && expected.has(clientIdClaim)) {
    return true;
  }

  if (typeof payload.aud === 'string') {
    return expected.has(payload.aud);
  }

  if (Array.isArray(payload.aud)) {
    return payload.aud.some((audience) => expected.has(toNonEmptyString(audience)));
  }

  return false;
};

export const verifyOidcAccessToken = async (token: string): Promise<VerifiedOidcIdentity> => {
  const normalizedToken = toNonEmptyString(token);
  if (!normalizedToken) {
    throw new Error('missing OIDC token');
  }

  const jwks = await getJwks();
  const { payload } = await jwtVerify<OidcPayload>(normalizedToken, jwks, {
    issuer: oidcIssuer,
    algorithms: allowedAlgorithms,
    clockTolerance: 10,
  });

  const isConfiguredClientMatch = tokenMatchesAllowedClient(payload, configuredClientIds);
  const isDevAccountFallback = env.nodeEnv !== 'production'
    && tokenMatchesAllowedClient(payload, ['account']);
  if (!isConfiguredClientMatch && !isDevAccountFallback) {
    throw new Error('OIDC token audience mismatch');
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new Error('OIDC token missing exp claim');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new Error('OIDC token missing iat claim');
  }

  const email = toNonEmptyString(payload.email || payload.preferred_username).toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('OIDC token missing email');
  }

  const resolvedSubject = [
    payload.sub,
    payload.oid,
    payload.uid,
    payload.user_id,
  ]
    .map((candidate) => toNonEmptyString(candidate))
    .find(Boolean);
  const subject = resolvedSubject || `email:${email}`;

  if (env.oidc.requireEmailVerified && !isBooleanTrue(payload.email_verified)) {
    throw new Error('OIDC token email is not verified');
  }

  const name = toNonEmptyString(payload.name) || email;
  return { subject, email, name };
};
