import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';
import { encodeRfc3986, sha256Hex, signV4 } from './sigv4';

export abstract class AudioStorage {
  /** Returns a stable public URL: snapshots keep it forever, so it must not expire. */
  abstract upload(key: string, audio: Buffer, contentType?: string): Promise<string>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const AUDIO_CONTENT_TYPE = 'audio/mpeg';
// Short enough that a regenerated file under the same key reaches learners within a day.
const CACHE_CONTROL = 'public, max-age=86400';

/** Cloudflare R2 through its S3 API; the bucket is served from R2_PUBLIC_BASE_URL. */
@Injectable()
export class R2AudioStorage extends AudioStorage {
  constructor(private readonly config: AppConfig, private readonly clock: Clock) {
    super();
  }

  async upload(key: string, audio: Buffer, contentType = AUDIO_CONTENT_TYPE): Promise<string> {
    const { r2AccountId: account, r2AccessKeyId: accessKeyId, r2SecretAccessKey: secretAccessKey, r2Bucket: bucket, r2PublicBaseUrl: publicBase } = this.config;
    if (!account || !accessKeyId || !secretAccessKey || !bucket || !publicBase) throw new ApiError('TTS_PROVIDER_UNAVAILABLE', 'Audio storage is not configured');

    const path = key.split('/').map(encodeRfc3986).join('/');
    const url = new URL(`https://${account}.r2.cloudflarestorage.com/${encodeRfc3986(bucket)}/${path}`);
    const body = new Uint8Array(audio);
    const signed = signV4({
      method: 'PUT', url, headers: { 'x-amz-content-sha256': sha256Hex(body) }, payloadHash: sha256Hex(body),
      accessKeyId, secretAccessKey, region: 'auto', service: 's3', now: this.clock.now(),
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: { ...signed, 'content-type': contentType, 'cache-control': CACHE_CONTROL },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('TTS_PROVIDER_UNAVAILABLE', 'Audio upload failed');
    }
    if (!response.ok) throw new ApiError('TTS_PROVIDER_UNAVAILABLE', `Audio upload returned ${response.status}`);
    return `${publicBase}/${path}`;
  }
}
