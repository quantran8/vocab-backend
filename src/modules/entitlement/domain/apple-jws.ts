import { X509Certificate } from 'node:crypto';
import { compactVerify, decodeJwt, decodeProtectedHeader } from 'jose';

// Marker extensions Apple puts on its App Store signing certificates (DER-encoded OIDs).
const OID_RECEIPT_SIGNING = Buffer.from('060a2a864886f76364060b01', 'hex'); // 1.2.840.113635.100.6.11.1 (leaf)
const OID_WWDR_INTERMEDIATE = Buffer.from('060a2a864886f76364060201', 'hex'); // 1.2.840.113635.100.6.2.1

export class AppleJwsError extends Error {}

const fingerprint = (cert: X509Certificate) => cert.fingerprint256.replace(/:/g, '').toUpperCase();

const validAt = (cert: X509Certificate, at: Date) => new Date(cert.validFrom) <= at && at <= new Date(cert.validTo);

export interface VerifyOptions {
  /** SHA-256 fingerprints (hex, upper case, no colons) of trusted roots. */
  rootFingerprints: string[];
  now: Date;
  /** Xcode StoreKit testing signs with a local key: decode only, and only when the payload says Xcode. */
  allowXcode: boolean;
}

/**
 * Verifies an App Store signed payload (JWS, ES256, x5c chain leaf → intermediate → root) the way
 * Apple's app-store-server-library does, without online revocation checks.
 */
export async function verifyAppleJws<T>(jws: string, options: VerifyOptions): Promise<T> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    throw new AppleJwsError('Not a JWS');
  }
  if (options.allowXcode) {
    const payload = safeDecode(jws);
    if (isXcode(payload)) return payload as T;
  }
  const chain = header.x5c;
  if (header.alg !== 'ES256' || !Array.isArray(chain) || chain.length !== 3) throw new AppleJwsError('Unexpected JWS header');
  let leaf: X509Certificate, intermediate: X509Certificate, root: X509Certificate;
  try {
    [leaf, intermediate, root] = chain.map((c) => new X509Certificate(Buffer.from(c, 'base64')));
  } catch {
    throw new AppleJwsError('Bad certificate');
  }
  if (!options.rootFingerprints.includes(fingerprint(root))) throw new AppleJwsError('Untrusted root');
  if (!intermediate.verify(root.publicKey) || !leaf.verify(intermediate.publicKey)) throw new AppleJwsError('Broken chain');
  if (!intermediate.ca || !intermediate.raw.includes(OID_WWDR_INTERMEDIATE) || !leaf.raw.includes(OID_RECEIPT_SIGNING)) {
    throw new AppleJwsError('Not an App Store signing certificate');
  }
  if (![leaf, intermediate, root].every((c) => validAt(c, options.now))) throw new AppleJwsError('Certificate outside its validity');
  try {
    const { payload } = await compactVerify(jws, leaf.publicKey);
    return JSON.parse(Buffer.from(payload).toString('utf8')) as T;
  } catch {
    throw new AppleJwsError('Bad signature');
  }
}

function safeDecode(jws: string): Record<string, unknown> | null {
  try {
    return decodeJwt(jws) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Transactions carry environment at the top; notifications carry it under data.
const isXcode = (payload: Record<string, unknown> | null) =>
  payload?.environment === 'Xcode' || (payload?.data as { environment?: string } | undefined)?.environment === 'Xcode';
