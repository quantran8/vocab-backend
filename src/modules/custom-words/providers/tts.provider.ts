import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';

export abstract class TtsProvider {
  /** The default voice. */
  abstract readonly voice: string;
  /** Speaks an IPA transcription (no slashes), never a spelling: senses of one spelling can sound different. */
  abstract synthesizeIpa(ipa: string, voiceId?: string): Promise<Buffer>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const OUTPUT_FORMAT = 'mp3_44100_128';
const TOO_MANY_REQUESTS = 429;
// 429 means too many requests at once for the plan, not a spent quota (that is 401), so waiting helps.
const RETRY_DELAYS_MS = [1_000, 3_000];

@Injectable()
export class ElevenLabsTtsProvider extends TtsProvider {
  constructor(private readonly config: AppConfig) {
    super();
  }

  get voice() {
    return this.config.elevenLabsVoiceId ?? '';
  }

  // Eleven v4 reads IPA wrapped in slashes; older models would need SSML phoneme tags.
  async synthesizeIpa(ipa: string, voiceId?: string): Promise<Buffer> {
    const text = `"/${ipa}/"`;
    const { elevenLabsApiKey: key, elevenLabsModelId: model } = this.config;
    const voice = voiceId ?? this.config.elevenLabsVoiceId;
    if (!key || !voice || !model) throw new ApiError('TTS_PROVIDER_UNAVAILABLE', 'ElevenLabs is not configured');

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${OUTPUT_FORMAT}`, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: model }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new ApiError('TTS_PROVIDER_UNAVAILABLE', 'ElevenLabs request failed');
      }
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (response.status === TOO_MANY_REQUESTS && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw new ApiError('TTS_PROVIDER_UNAVAILABLE', `ElevenLabs returned ${response.status}${await reasonOf(response)}`);
    }
  }
}

/** ElevenLabs explains a refusal in `detail.message` (paid voice, quota, busy); shown to admins as is. */
async function reasonOf(response: Response) {
  const body = (await response.json().catch(() => null)) as { detail?: { message?: unknown } | string } | null;
  const message = typeof body?.detail === 'string' ? body.detail : body?.detail?.message;
  return typeof message === 'string' && message ? `: ${message}` : '';
}
