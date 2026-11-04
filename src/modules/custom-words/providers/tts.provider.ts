import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';

export abstract class TtsProvider {
  abstract readonly voice: string;
  abstract synthesize(text: string): Promise<Buffer>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const OUTPUT_FORMAT = 'mp3_44100_128';

@Injectable()
export class ElevenLabsTtsProvider extends TtsProvider {
  constructor(private readonly config: AppConfig) {
    super();
  }

  get voice() {
    return this.config.elevenLabsVoiceId ?? '';
  }

  async synthesize(text: string): Promise<Buffer> {
    const { elevenLabsApiKey: key, elevenLabsVoiceId: voice, elevenLabsModelId: model } = this.config;
    if (!key || !voice || !model) throw new ApiError('TTS_PROVIDER_UNAVAILABLE', 'ElevenLabs is not configured');

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
    if (!response.ok) throw new ApiError('TTS_PROVIDER_UNAVAILABLE', `ElevenLabs returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
