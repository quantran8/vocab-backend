import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { AppConfig } from '../../config/app-config';

export abstract class AudioStorage {
  /** Returns a stable public URL: snapshots keep it forever, so it must not expire. */
  abstract upload(key: string, audio: Buffer): Promise<string>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const AUDIO_CONTENT_TYPE = 'audio/mpeg';

@Injectable()
export class SupabaseAudioStorage extends AudioStorage {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async upload(key: string, audio: Buffer): Promise<string> {
    const { supabaseUrl: base, supabaseServiceRoleKey: secret, supabaseAudioBucket: bucket } = this.config;
    if (!secret) throw new ApiError('TTS_PROVIDER_UNAVAILABLE', 'Audio storage is not configured');

    let response: Response;
    try {
      response = await fetch(`${base}/storage/v1/object/${bucket}/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, apikey: secret, 'Content-Type': AUDIO_CONTENT_TYPE, 'x-upsert': 'true' },
        body: new Uint8Array(audio),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('TTS_PROVIDER_UNAVAILABLE', 'Audio upload failed');
    }
    if (!response.ok) throw new ApiError('TTS_PROVIDER_UNAVAILABLE', `Audio upload returned ${response.status}`);
    return `${base}/storage/v1/object/public/${bucket}/${key}`;
  }
}
