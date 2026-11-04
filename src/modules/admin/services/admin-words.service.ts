import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { AdminWordsRepository } from '../repositories/admin-words.repository';
import { PRIVATE_MEANING_LOCKED } from '../domain/admin.errors';
import {
  ExampleBody, ListMeanings, ListWords, MeaningBody, PatchMeaning, PatchPronunciation, PatchWord, PronunciationBody, WordTypeBody,
} from '../dto/admin.schemas';

const NEVER_PUBLISHED_ONLY = 'Only content that was never published can be deleted; recall it instead';
const IDENTITY_LOCKED = 'Lemma and homograph key are locked once a meaning was published';

@Injectable()
export class AdminWordsService {
  constructor(private readonly repository: AdminWordsRepository) {}

  listWords(query: ListWords) {
    return this.repository.listWords(query);
  }

  async getWord(id: string) {
    const word = await this.repository.findWordTree(id);
    if (!word) throw new ApiError('NOT_FOUND', 'Word not found');

    const meaningIds = word.types.flatMap((t) => t.meanings.map((m) => m.id));
    const { active, published, privateMeaningCount } = await this.repository.publicationState(id, meaningIds);
    const publicationsByMeaning = new Map<string, Omit<(typeof active)[number], 'meaningId'>[]>();
    for (const { meaningId, ...publication } of active) {
      publicationsByMeaning.set(meaningId, [...(publicationsByMeaning.get(meaningId) ?? []), publication]);
    }

    return {
      ...word,
      privateMeaningCount,
      identityLocked: published || privateMeaningCount > 0,
      types: word.types.map((type) => ({
        ...type,
        meanings: type.meanings.map((meaning) => ({ ...meaning, publications: publicationsByMeaning.get(meaning.id) ?? [] })),
      })),
    };
  }

  async patchWord(id: string, body: PatchWord) {
    if (await this.repository.hasWordHistory(id)) throw new ApiError('CONTENT_LOCKED', IDENTITY_LOCKED);
    const updated = await this.repository.updateWord(id, body);
    if (!updated) throw new ApiError('NOT_FOUND', 'Word not found');
    return updated;
  }

  async deleteWord(id: string) {
    if (await this.repository.hasWordHistory(id)) throw new ApiError('CONTENT_LOCKED', NEVER_PUBLISHED_ONLY);
    if (!(await this.repository.deleteWord(id))) throw new ApiError('NOT_FOUND', 'Word not found');
  }

  async createType(wordId: string, body: WordTypeBody) {
    const id = newId();
    await this.repository.insertType(id, wordId, body);
    return { id, wordId, partOfSpeech: body.partOfSpeech };
  }

  async deleteType(id: string) {
    if (await this.repository.hasTypeHistory(id)) throw new ApiError('CONTENT_LOCKED', NEVER_PUBLISHED_ONLY);
    if (!(await this.repository.deleteType(id))) throw new ApiError('NOT_FOUND', 'Word type not found');
  }

  async createPronunciation(typeId: string, body: PronunciationBody) {
    return { id: await this.repository.insertPronunciation(typeId, body), typeId, ...body };
  }

  async patchPronunciation(id: string, body: PatchPronunciation) {
    const row = await this.repository.updatePronunciation(id, body);
    if (!row) throw new ApiError('NOT_FOUND', 'Pronunciation not found');
    return row;
  }

  // Snapshots hold pronunciation ids, so a type with published meanings keeps its rows.
  async deletePronunciation(id: string) {
    if (await this.repository.hasPronunciationHistory(id)) throw new ApiError('CONTENT_LOCKED', NEVER_PUBLISHED_ONLY);
    if (!(await this.repository.deletePronunciation(id))) throw new ApiError('NOT_FOUND', 'Pronunciation not found');
  }

  listMeanings(query: ListMeanings) {
    return this.repository.listMeanings(query);
  }

  async createMeaning(typeId: string, body: MeaningBody) {
    return { id: await this.repository.insertMeaning(typeId, body), typeId };
  }

  async patchMeaning(id: string, body: PatchMeaning) {
    const row = await this.repository.updateMeaning(id, body);
    if (!row) {
      await this.assertSharedMeaning(id);
      throw new ApiError('NOT_FOUND', 'Meaning not found');
    }
    return row;
  }

  async deleteMeaning(id: string) {
    await this.assertSharedMeaning(id);
    if (await this.repository.hasMeaningHistory(id)) throw new ApiError('CONTENT_LOCKED', NEVER_PUBLISHED_ONLY);
    await this.repository.deleteMeaning(id);
  }

  async deleteMeaningLocale(id: string, locale: string) {
    await this.assertSharedMeaning(id);
    if (await this.repository.hasPublicationIn(id, locale)) throw new ApiError('CONTENT_LOCKED', NEVER_PUBLISHED_ONLY);
    if (!(await this.repository.deleteMeaningLocale(id, locale))) throw new ApiError('NOT_FOUND', 'Locale not found');
  }

  async meaningPublications(id: string) {
    return { items: await this.repository.listPublications(id) };
  }

  async createExample(meaningId: string, body: ExampleBody) {
    await this.assertSharedMeaning(meaningId);
    return { id: await this.repository.insertExample(meaningId, body), meaningId, ...body };
  }

  async patchExample(id: string, body: ExampleBody) {
    await this.assertSharedExample(id);
    await this.repository.updateExample(id, body);
    return { id, ...body };
  }

  async deleteExample(id: string) {
    await this.assertSharedExample(id);
    if (await this.repository.hasExampleHistory(id)) throw new ApiError('CONTENT_LOCKED', NEVER_PUBLISHED_ONLY);
    await this.repository.deleteExample(id);
  }

  private async assertSharedMeaning(id: string) {
    const meaning = await this.repository.findMeaningOwner(id);
    if (!meaning) throw new ApiError('NOT_FOUND', 'Meaning not found');
    if (meaning.ownerUserId) throw new ApiError('CONTENT_LOCKED', PRIVATE_MEANING_LOCKED);
  }

  private async assertSharedExample(id: string) {
    const example = await this.repository.findExampleOwner(id);
    if (!example) throw new ApiError('NOT_FOUND', 'Example not found');
    if (example.ownerUserId) throw new ApiError('CONTENT_LOCKED', PRIVATE_MEANING_LOCKED);
  }
}
