import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { AppModule } from '../app.module';
import { CefrLevel, DEFAULT_ACCENT, DEFAULT_LOCALE, EDITORIAL_STATE, LEARNING_LANGUAGE, PartOfSpeech } from '../common/constants/domain';
import { DB, Db } from '../db/db';
import { meaningExamples, meaningLocalizations, meanings, userMeaningProgress, words, wordTypes } from '../db/schema';
import { AdminService } from '../modules/admin/services/admin.service';
import { AdminWordsService } from '../modules/admin/services/admin-words.service';
import { PublicationService } from '../modules/admin/services/publication.service';

interface ExtraSense {
  lemma: string;
  partOfSpeech: PartOfSpeech;
  ipa: string;
  cefrLevel: CefrLevel;
  meaningText: string;
  definitionText: string;
  coreDefinition: string;
  example: string;
  target: string;
  translation: string;
}

const SENSES: ExtraSense[] = [
  { lemma: 'order', partOfSpeech: 'noun', ipa: '/ˈɔːrdɚ/', cefrLevel: 'A2', meaningText: 'thứ tự', definitionText: 'cách sắp xếp các thứ theo trình tự', coreDefinition: 'the way things are arranged in sequence', example: 'The names are listed in alphabetical order.', target: 'order', translation: 'Các tên được liệt kê theo thứ tự bảng chữ cái.' },
  { lemma: 'order', partOfSpeech: 'noun', ipa: '/ˈɔːrdɚ/', cefrLevel: 'B1', meaningText: 'mệnh lệnh', definitionText: 'lời yêu cầu bắt buộc từ người có quyền', coreDefinition: 'an instruction given by someone in authority', example: 'The soldiers were given an order to wait.', target: 'order', translation: 'Những người lính nhận được mệnh lệnh phải chờ.' },
  { lemma: 'order', partOfSpeech: 'verb', ipa: '/ˈɔːrdɚ/', cefrLevel: 'A1', meaningText: 'gọi món, đặt hàng', definitionText: 'yêu cầu được phục vụ hoặc giao một thứ gì đó', coreDefinition: 'to ask for food, drink or goods to be brought', example: 'We ordered two pizzas and a salad.', target: 'ordered', translation: 'Chúng tôi đã gọi hai cái pizza và một đĩa salad.' },
  { lemma: 'ticket', partOfSpeech: 'noun', ipa: '/ˈtɪkɪt/', cefrLevel: 'B1', meaningText: 'vé phạt', definitionText: 'giấy phạt vì vi phạm luật giao thông', coreDefinition: 'an official notice of a traffic offence', example: 'I got a parking ticket outside the bank.', target: 'ticket', translation: 'Tôi bị phạt đỗ xe trước cửa ngân hàng.' },
  { lemma: 'schedule', partOfSpeech: 'verb', ipa: '/ˈskedʒuːl/', cefrLevel: 'B1', meaningText: 'lên lịch', definitionText: 'sắp xếp để việc gì diễn ra vào một thời điểm', coreDefinition: 'to arrange for something to happen at a particular time', example: 'The meeting is scheduled for Monday morning.', target: 'scheduled', translation: 'Cuộc họp được lên lịch vào sáng thứ Hai.' },
  { lemma: 'exchange', partOfSpeech: 'noun', ipa: '/ɪksˈtʃeɪndʒ/', cefrLevel: 'B1', meaningText: 'sự trao đổi', definitionText: 'việc cho và nhận lại một thứ tương ứng', coreDefinition: 'the act of giving something and receiving something in return', example: 'We had a useful exchange of ideas.', target: 'exchange', translation: 'Chúng tôi đã có một buổi trao đổi ý tưởng hữu ích.' },
  { lemma: 'budget', partOfSpeech: 'adjective', ipa: '/ˈbʌdʒɪt/', cefrLevel: 'B1', meaningText: 'giá rẻ', definitionText: 'có giá thấp, dành cho người muốn tiết kiệm', coreDefinition: 'cheap, for people without much money', example: 'We flew with a budget airline.', target: 'budget', translation: 'Chúng tôi bay bằng một hãng hàng không giá rẻ.' },
  { lemma: 'budget', partOfSpeech: 'verb', ipa: '/ˈbʌdʒɪt/', cefrLevel: 'B2', meaningText: 'lập ngân sách', definitionText: 'lên kế hoạch chi tiêu một khoản tiền', coreDefinition: 'to plan how much money to spend', example: 'You need to budget carefully for the trip.', target: 'budget', translation: 'Bạn cần lập ngân sách cẩn thận cho chuyến đi.' },
  { lemma: 'discount', partOfSpeech: 'verb', ipa: '/dɪsˈkaʊnt/', cefrLevel: 'B1', meaningText: 'giảm giá', definitionText: 'bán với giá thấp hơn bình thường', coreDefinition: 'to reduce the price of something', example: 'All winter coats are discounted this week.', target: 'discounted', translation: 'Tất cả áo khoác mùa đông đều được giảm giá tuần này.' },
  { lemma: 'refund', partOfSpeech: 'verb', ipa: '/rɪˈfʌnd/', cefrLevel: 'B1', meaningText: 'hoàn tiền', definitionText: 'trả lại tiền cho người đã mua', coreDefinition: 'to give someone their money back', example: 'The shop refunded my money without any questions.', target: 'refunded', translation: 'Cửa hàng đã hoàn tiền cho tôi mà không hỏi gì.' },
  { lemma: 'purchase', partOfSpeech: 'noun', ipa: '/ˈpɝːtʃəs/', cefrLevel: 'B1', meaningText: 'món đồ đã mua', definitionText: 'thứ mà bạn đã bỏ tiền ra mua', coreDefinition: 'something that you have bought', example: 'Keep the receipt for every purchase.', target: 'purchase', translation: 'Hãy giữ hóa đơn cho mọi món đồ bạn mua.' },
  { lemma: 'bargain', partOfSpeech: 'verb', ipa: '/ˈbɑːrɡɪn/', cefrLevel: 'B1', meaningText: 'mặc cả', definitionText: 'thương lượng để được giá thấp hơn', coreDefinition: 'to discuss a price to make it lower', example: 'Tourists often bargain at the night market.', target: 'bargain', translation: 'Khách du lịch thường mặc cả ở chợ đêm.' },
  { lemma: 'recover', partOfSpeech: 'verb', ipa: '/rɪˈkʌvɚ/', cefrLevel: 'B2', meaningText: 'lấy lại', definitionText: 'tìm lại hoặc giành lại thứ đã mất', coreDefinition: 'to get back something that was lost or stolen', example: 'Police recovered the stolen car.', target: 'recovered', translation: 'Cảnh sát đã tìm lại được chiếc xe bị đánh cắp.' },
  { lemma: 'diet', partOfSpeech: 'noun', ipa: '/ˈdaɪət/', cefrLevel: 'A2', meaningText: 'chế độ ăn kiêng', definitionText: 'việc ăn ít hoặc kiêng một số món để giảm cân', coreDefinition: 'a limited range of food eaten to lose weight', example: 'She is on a diet before the wedding.', target: 'diet', translation: 'Cô ấy đang ăn kiêng trước đám cưới.' },
  { lemma: 'afford', partOfSpeech: 'verb', ipa: '/əˈfɔːrd/', cefrLevel: 'B2', meaningText: 'có thể chịu được (hậu quả)', definitionText: 'có thể làm gì mà không gặp rắc rối', coreDefinition: 'to be able to do something without serious problems', example: 'We cannot afford to miss this train.', target: 'afford', translation: 'Chúng ta không thể để lỡ chuyến tàu này.' },
];

async function main() {
  const userId = process.argv[2];
  if (!userId) throw new Error('Usage: node dist/seed/seed-polysemy.js <userId>');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get<Db>(DB);
  const admin = app.get(AdminService);
  const adminWords = app.get(AdminWordsService);
  const publications = app.get(PublicationService);

  const lemmas = [...new Set(SENSES.map((s) => s.lemma))];
  const typeRows = await db
    .select({ wordId: words.id, lemma: words.lemma, typeId: wordTypes.id, partOfSpeech: wordTypes.partOfSpeech })
    .from(words)
    .leftJoin(wordTypes, eq(wordTypes.wordId, words.id))
    .where(and(eq(words.language, LEARNING_LANGUAGE), isNull(words.homographKey), inArray(words.lemma, lemmas)));
  const wordIdOf = new Map(typeRows.map((r) => [r.lemma, r.wordId]));
  const typeIdOf = new Map(typeRows.filter((r) => r.typeId).map((r) => [`${r.lemma}:${r.partOfSpeech}`, r.typeId!]));

  // Re-runs skip senses whose Vietnamese text already exists on the word.
  const existingTexts = await db
    .select({ wordId: wordTypes.wordId, text: meaningLocalizations.meaningText })
    .from(meaningLocalizations)
    .innerJoin(meanings, eq(meanings.id, meaningLocalizations.meaningId))
    .innerJoin(wordTypes, eq(wordTypes.id, meanings.typeId))
    .where(and(eq(meaningLocalizations.locale, DEFAULT_LOCALE), inArray(wordTypes.wordId, [...wordIdOf.values()]), or(isNull(meanings.ownerUserId), eq(meanings.ownerUserId, userId))));
  const seen = new Set(existingTexts.map((r) => `${r.wordId}:${r.text}`));

  const created: { meaningId: string; sense: ExtraSense }[] = [];
  for (const sense of SENSES) {
    const wordId = wordIdOf.get(sense.lemma);
    if (!wordId) throw new Error(`Word not found: ${sense.lemma}`);
    if (seen.has(`${wordId}:${sense.meaningText}`)) continue;

    const key = `${sense.lemma}:${sense.partOfSpeech}`;
    let typeId = typeIdOf.get(key);
    if (!typeId) {
      typeId = (await adminWords.createType(wordId, { partOfSpeech: sense.partOfSpeech, pronunciations: [{ accentLocale: DEFAULT_ACCENT, ipa: sense.ipa }], meanings: [] })).id;
      typeIdOf.set(key, typeId);
    }
    const start = sense.example.indexOf(sense.target);
    if (start < 0) throw new Error(`Target "${sense.target}" not in example of ${sense.lemma}`);
    const { id: meaningId } = await adminWords.createMeaning(typeId, {
      cefrLevel: sense.cefrLevel,
      coreDefinition: sense.coreDefinition,
      examples: [{ sourceText: sense.example, targetLocator: { start, end: start + sense.target.length } }],
    });
    created.push({ meaningId, sense });
  }

  const exampleRows = created.length === 0 ? [] : await db
    .select({ id: meaningExamples.id, meaningId: meaningExamples.meaningId })
    .from(meaningExamples)
    .where(inArray(meaningExamples.meaningId, created.map((c) => c.meaningId)));
  const exampleIdOf = new Map(exampleRows.map((e) => [e.meaningId, e.id]));
  for (const { meaningId, sense } of created) {
    await admin.putMeaningLocale(meaningId, DEFAULT_LOCALE, {
      meaningText: sense.meaningText,
      definitionText: sense.definitionText,
      editorialState: EDITORIAL_STATE.APPROVED,
      exampleTranslations: [{ exampleId: exampleIdOf.get(meaningId)!, translationText: sense.translation }],
    });
    await publications.publish(meaningId, DEFAULT_LOCALE);
    console.log(`+ ${sense.lemma} (${sense.partOfSpeech}): ${sense.meaningText}`);
  }

  // New senses join the learner's pool due now, using the scheduler version of their existing rows.
  if (created.length > 0) {
    const [{ schedulerVersion }] = await db
      .select({ schedulerVersion: userMeaningProgress.schedulerVersion })
      .from(userMeaningProgress)
      .where(eq(userMeaningProgress.userId, userId))
      .limit(1);
    const now = new Date();
    await db
      .insert(userMeaningProgress)
      .values(created.map(({ meaningId }) => ({ userId, meaningId, learnedAt: now, nextReviewAt: now, intervalHours: 24, schedulerVersion })))
      .onConflictDoNothing();
  }
  console.log(`Seeded ${created.length} senses`);
  await app.close();
}

void main();
