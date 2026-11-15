import { Injectable } from '@nestjs/common';
import { DEFAULT_ACCENT } from '../../../common/constants/domain';
import { audioKey, bareIpa } from '../domain/custom-word-text';
import { AudioStorage } from '../providers/audio-storage';
import { TtsProvider } from '../providers/tts.provider';

export const IPA_MISSING = 'IPA missing';

/** Voices a pronunciation from its IPA and stores it; the one path every audio writer uses. */
@Injectable()
export class PronunciationAudio {
  constructor(private readonly tts: TtsProvider, private readonly storage: AudioStorage) {}

  get voice() {
    return this.tts.voice;
  }

  /** Returns the public URL. Throws when there is no IPA: spelling alone cannot tell senses apart. */
  async create(ipa: string | null | undefined, voiceId = this.tts.voice): Promise<string> {
    const phonemes = bareIpa(ipa);
    if (!phonemes) throw new Error(IPA_MISSING);
    const audio = await this.tts.synthesizeIpa(phonemes, voiceId);
    return this.storage.upload(audioKey(voiceId, DEFAULT_ACCENT, phonemes), audio);
  }
}
