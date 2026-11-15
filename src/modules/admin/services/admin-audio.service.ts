import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_ACCENT } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { POLICY } from '../../../config/policy';
import { audioKey, normalizeText } from '../../custom-words/domain/custom-word-text';
import { AudioStorage } from '../../custom-words/providers/audio-storage';
import { TtsProvider } from '../../custom-words/providers/tts.provider';
import { GenerateAudio } from '../dto/admin.schemas';
import { AdminAudioRepository, AudioTarget } from '../repositories/admin-audio.repository';

type Voiced = { ok: true; url: string } | { ok: false; message: string };

@Injectable()
export class AdminAudioService {
  private readonly logger = new Logger(AdminAudioService.name);

  constructor(private readonly repository: AdminAudioRepository, private readonly tts: TtsProvider, private readonly storage: AudioStorage) {}

  async status() {
    return { voice: this.tts.voice, accent: DEFAULT_ACCENT, ...(await this.repository.status()) };
  }

  /**
   * Voices one batch and saves it in one write. Live snapshots keep their old audio until the
   * meaning is republished (publications are immutable); status() counts those.
   */
  async generate(body: GenerateAudio) {
    const { missing, items } = await this.repository.targets(body);

    // Homographs share a lemma, and audioKey is per text, so each text is voiced once.
    const texts = [...new Map(items.map((t) => [normalizeText(t.lemma), t.lemma])).entries()];
    const voiced = new Map(await mapLimit(texts, POLICY.audio.ttsConcurrency, async ([norm, lemma]) => [norm, await this.voice(lemma)] as const));
    const results = [...voiced.values()];
    if (results.length > 0 && results.every((r) => !r.ok)) {
      // Nothing worked (missing config, quota): fail the request so the client stops looping.
      throw new ApiError('TTS_PROVIDER_UNAVAILABLE', (results[0] as { message: string }).message);
    }

    const resultOf = (t: AudioTarget) => voiced.get(normalizeText(t.lemma))!;
    const urlOf = new Map(items.flatMap((t) => { const r = resultOf(t); return r.ok ? [[t.id, r.url] as const] : []; }));
    const saved = await this.repository.setAudio([...urlOf].map(([id, url]) => ({ id, url })), body.overwrite);

    const view = (t: AudioTarget) => ({ pronunciationId: t.id, wordId: t.wordId, lemma: t.lemma });
    const generated = items.filter((t) => saved.has(t.id));
    const picked = new Set(items.map((t) => t.id));
    return {
      voice: this.tts.voice,
      accent: DEFAULT_ACCENT,
      generated: generated.map((t) => ({ ...view(t), audioUrl: urlOf.get(t.id)! })),
      failed: items.flatMap((t) => { const r = resultOf(t); return r.ok ? [] : [{ ...view(t), message: r.message }]; }),
      // Requested but not voiced: unknown id, another accent, already voiced without overwrite, or filled meanwhile.
      skippedIds: [...(body.pronunciationIds?.filter((id) => !picked.has(id)) ?? []), ...[...urlOf.keys()].filter((id) => !saved.has(id))],
      remaining: Math.max(0, missing - generated.filter((t) => !t.hasAudio).length),
    };
  }

  private async voice(lemma: string): Promise<Voiced> {
    try {
      const audio = await this.tts.synthesize(lemma);
      return { ok: true, url: await this.storage.upload(audioKey(this.tts.voice, DEFAULT_ACCENT, lemma), audio) };
    } catch (error) {
      this.logger.warn(`audio for "${lemma}" failed: ${(error as Error).message}`);
      return { ok: false, message: (error as Error).message };
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
