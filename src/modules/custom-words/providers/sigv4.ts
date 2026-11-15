import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

// encodeURIComponent leaves !'()* alone; SigV4 wants them escaped.
export const encodeRfc3986 = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignV4Input {
  method: string;
  url: URL;
  /** Headers to sign besides host and x-amz-date. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  now: Date;
}

/** AWS Signature V4 (also what R2's S3 API expects). Returns the headers to send, host excluded. */
export function signV4(input: SignV4Input): Record<string, string> {
  const { method, url, payloadHash, accessKeyId, secretAccessKey, region, service, now } = input;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = { ...lowerKeys(input.headers), 'x-amz-date': amzDate };
  const signed = { ...headers, host: url.host };
  const names = Object.keys(signed).sort();
  const query = [...url.searchParams].map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).sort().join('&');

  const canonical = [
    method, url.pathname, query,
    ...names.map((n) => `${n}:${signed[n as keyof typeof signed].trim()}`), '',
    names.join(';'), payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = [day, region, service, 'aws4_request'].reduce<string | Buffer>((k, part) => hmac(k, part), `AWS4${secretAccessKey}`);
  const signature = hmac(key, toSign).toString('hex');

  return { ...headers, authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const lowerKeys = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
