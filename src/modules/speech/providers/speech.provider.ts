import { Injectable } from '@nestjs/common';
import { VALIDITY, Validity } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';

export interface SpeechRequest {
  audio: Buffer;
  contentType: string;
  referenceText: string;
  locale: string;
}

/** One syllable as Azure heard it: its letters in the word, its IPA and its score. */
export interface SpeechSyllable {
  text: string;
  ipa: string;
  score: number;
}

export interface SpeechResult {
  validity: Validity;
  accuracyScore: number | null;
  // Empty when Azure gives no letters per syllable (only en-US does).
  syllables?: SpeechSyllable[];
  meta: Record<string, unknown>;
}

export abstract class SpeechProvider {
  abstract assess(request: SpeechRequest): Promise<SpeechResult>;
}

const REQUEST_TIMEOUT_MS = 10_000;
// The REST API sends 'Success'; some Azure surfaces send the enum's number, 0.
const RECOGNITION_SUCCESS: readonly unknown[] = ['Success', 0];
const CLIENT_ERROR_MIN = 400;
const SERVER_ERROR_MIN = 500;

// Scores come nested in PronunciationAssessment or flat on the item, depending on the API version.
interface AzureScored {
  AccuracyScore?: number;
  PronunciationAssessment?: { AccuracyScore?: number };
}

interface AzureSyllable extends AzureScored {
  Syllable?: string;
  Grapheme?: string;
}

interface AzureResponse {
  RecognitionStatus?: string | number;
  NBest?: (AzureScored & { Words?: (AzureScored & { Syllables?: AzureSyllable[] })[] })[];
}

const scoreOf = (item: AzureScored) => item.PronunciationAssessment?.AccuracyScore ?? item.AccuracyScore;

/** All-or-nothing: a partial list would colour only part of the word. */
function readSyllables(words: { Syllables?: AzureSyllable[] }[] = []): SpeechSyllable[] {
  const syllables: SpeechSyllable[] = [];
  for (const syllable of words.flatMap((w) => w.Syllables ?? [])) {
    const score = scoreOf(syllable);
    if (!syllable.Grapheme || score === undefined) return [];
    syllables.push({ text: syllable.Grapheme, ipa: syllable.Syllable ?? '', score });
  }
  return syllables;
}

@Injectable()
export class AzureRestSpeechProvider extends SpeechProvider {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async assess({ audio, contentType, referenceText, locale }: SpeechRequest): Promise<SpeechResult> {
    const { azureSpeechKey: key, azureSpeechRegion: region } = this.config;
    if (!key || !region) throw new ApiError('SPEECH_PROVIDER_UNAVAILABLE', 'Azure Speech is not configured');

    const assessment = { ReferenceText: referenceText, GradingSystem: 'HundredMark', Granularity: 'Phoneme', Dimension: 'Comprehensive', PhonemeAlphabet: 'IPA' };
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
    if (!RECOGNITION_SUCCESS.includes(body.RecognitionStatus)) return this.invalid(String(body.RecognitionStatus ?? 'unknown'));
    const best = body.NBest?.[0];
    const accuracyScore = best && scoreOf(best);
    if (accuracyScore === undefined) return this.invalid('noScore');
    return {
      validity: VALIDITY.VALID,
      accuracyScore,
      syllables: readSyllables(best?.Words),
      meta: { provider: 'azure', recognitionStatus: body.RecognitionStatus },
    };
  }

  private invalid(reason: string): SpeechResult {
    return { validity: VALIDITY.INVALID, accuracyScore: null, meta: { provider: 'azure', reason } };
  }
}
