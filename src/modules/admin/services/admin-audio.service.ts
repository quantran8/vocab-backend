import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { DEFAULT_ACCENT } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { bareIpa } from '../../custom-words/domain/custom-word-text';
import { IPA_MISSING, PronunciationAudio } from '../../custom-words/services/pronunciation-audio.service';
import { GenerateAudio, ListAudioMissing, ListAudioStale, RefreshAudio } from '../dto/admin.schemas';
import { AdminAudioRepository, AudioTarget } from '../repositories/admin-audio.repository';

type Voiced = { ok: true; url: string } | { ok: false; message: string };

@Injectable()
export class AdminAudioService {
  private readonly logger = new Logger(AdminAudioService.name);

  constructor(
    private readonly repository: AdminAudioRepository,
    private readonly audio: PronunciationAudio,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  async status() {
    return { voice: this.audio.voice, voices: this.config.elevenLabsVoices, accent: DEFAULT_ACCENT, ...(await this.repository.status()) };
  }

  listMissing(query: ListAudioMissing) {
    return this.repository.listMissing(query);
  }

  listStale(query: ListAudioStale) {
    return this.repository.listStale(query);
  }

  /** Puts each pronunciation's current IPA and audio into live snapshots as new revisions; nothing else in them changes. */
  async refreshPublications({ publications, limit }: RefreshAudio) {
    const { total, items } = await this.repository.staleTargets(publications, limit);
    const refreshed = await this.repository.refreshAudio(items.map((p) => ({ ...p, id: newId() })), this.clock.now());
    return { refreshed, remaining: Math.max(0, total - refreshed.length) };
  }

  /**
   * Voices one batch and saves it in one write. Live snapshots keep their old audio until
   * refreshPublications() (publications are immutable); status() counts those.
   */
  async generate(body: GenerateAudio) {
    const voiceId = body.voiceId ?? this.audio.voice;
    if (!this.config.elevenLabsVoices.some((v) => v.id === voiceId)) throw new ApiError('VALIDATION_FAILED', 'voiceId: not one of the configured voices');
    const { missing, items } = await this.repository.targets(body);

    // The IPA is what is voiced, so meanings that sound the same share one call and one file.
    const sounds = [...new Set(items.flatMap((t) => bareIpa(t.ipa) ?? []))];
    // Overwrite means re-voice; otherwise a sound voiced before is reused.
    const known = body.overwrite ? new Map<string, string>() : await this.repository.audioBySound(sounds, voiceId);
    const toVoice = sounds.filter((ipa) => !known.has(ipa));
    const voiced = new Map<string, Voiced>([
      ...[...known].map(([ipa, url]) => [ipa, { ok: true, url }] as const),
      ...await mapLimit(toVoice, POLICY.audio.ttsConcurrency, async (ipa) => [ipa, await this.voice(ipa, voiceId)] as const),
    ]);
    const results = toVoice.map((ipa) => voiced.get(ipa)!);
    if (results.length > 0 && results.every((r) => !r.ok)) {
      // Nothing worked (missing config, quota): fail the request so the client stops looping.
      throw new ApiError('TTS_PROVIDER_UNAVAILABLE', (results[0] as { message: string }).message);
    }

    const noIpa: Voiced = { ok: false, message: IPA_MISSING };
    const resultOf = (t: AudioTarget) => voiced.get(bareIpa(t.ipa) ?? '') ?? noIpa;
    const urlOf = new Map(items.flatMap((t) => { const r = resultOf(t); return r.ok ? [[t.id, r.url] as const] : []; }));
    const saved = await this.repository.setAudio([...urlOf].map(([id, url]) => ({ id, url })), body.overwrite);

    const view = (t: AudioTarget) => ({ pronunciationId: t.id, meaningId: t.meaningId, wordId: t.wordId, lemma: t.lemma, ipa: t.ipa });
    const generated = items.filter((t) => saved.has(t.id));
    const picked = new Set(items.map((t) => t.id));
    return {
      voice: voiceId,
      accent: DEFAULT_ACCENT,
      generated: generated.map((t) => ({ ...view(t), audioUrl: urlOf.get(t.id)! })),
      failed: items.flatMap((t) => { const r = resultOf(t); return r.ok ? [] : [{ ...view(t), message: r.message }]; }),
      // Requested but not voiced: unknown id, another accent, no IPA, already voiced without overwrite, or filled meanwhile.
      skippedIds: [...(body.pronunciationIds?.filter((id) => !picked.has(id)) ?? []), ...[...urlOf.keys()].filter((id) => !saved.has(id))],
      remaining: Math.max(0, missing - generated.filter((t) => !t.hasAudio).length),
    };
  }

  private async voice(ipa: string, voiceId: string): Promise<Voiced> {
    try {
      return { ok: true, url: await this.audio.create(ipa, voiceId) };
    } catch (error) {
      this.logger.warn(`audio for /${ipa}/ failed: ${(error as Error).message}`);
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
