import { Injectable } from '@nestjs/common';
import { VALIDITY, Validity } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { AppConfig } from '../../config/app-config';

export interface SpeechRequest {
  audio: Buffer;
  contentType: string;
  referenceText: string;
  locale: string;
}

export interface SpeechResult {
  validity: Validity;
  accuracyScore: number | null;
  meta: Record<string, unknown>;
}

export abstract class SpeechProvider {
  abstract assess(request: SpeechRequest): Promise<SpeechResult>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const RECOGNITION_SUCCESS = 'Success';
const CLIENT_ERROR_MIN = 400;
const SERVER_ERROR_MIN = 500;

interface AzureResponse {
  RecognitionStatus?: string;
  NBest?: { AccuracyScore?: number; PronunciationAssessment?: { AccuracyScore?: number } }[];
}

@Injectable()
export class AzureRestSpeechProvider extends SpeechProvider {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async assess({ audio, contentType, referenceText, locale }: SpeechRequest): Promise<SpeechResult> {
    const { azureSpeechKey: key, azureSpeechRegion: region } = this.config;
    if (!key || !region) throw new ApiError('SPEECH_PROVIDER_UNAVAILABLE', 'Azure Speech is not configured');

    const assessment = { ReferenceText: referenceText, GradingSystem: 'HundredMark', Granularity: 'Word', Dimension: 'Comprehensive' };
    const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': contentType,
          'Pronunciation-Assessment': Buffer.from(JSON.stringify(assessment)).toString('base64'),
          Accept: 'application/json',
        },
        body: new Uint8Array(audio),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('SPEECH_PROVIDER_UNAVAILABLE', 'Azure Speech request failed');
    }

    if (response.status >= SERVER_ERROR_MIN) throw new ApiError('SPEECH_PROVIDER_UNAVAILABLE', 'Azure Speech failed');
    if (response.status >= CLIENT_ERROR_MIN) return this.invalid(`http${response.status}`);

    const body = (await response.json()) as AzureResponse;
    if (body.RecognitionStatus !== RECOGNITION_SUCCESS) return this.invalid(body.RecognitionStatus ?? 'unknown');
    const best = body.NBest?.[0];
    const accuracyScore = best?.PronunciationAssessment?.AccuracyScore ?? best?.AccuracyScore;
    if (accuracyScore === undefined) return this.invalid('noScore');
    return { validity: VALIDITY.valid, accuracyScore, meta: { provider: 'azure', recognitionStatus: body.RecognitionStatus } };
  }

  private invalid(reason: string): SpeechResult {
    return { validity: VALIDITY.invalid, accuracyScore: null, meta: { provider: 'azure', reason } };
  }
}
