import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import { AppModule } from '../app.module';
import { CefrLevel, DEFAULT_ACCENT, DEFAULT_LOCALE, EDITORIAL_STATE, LEARNING_LANGUAGE, PartOfSpeech } from '../common/constants/domain';
import { DB, Db } from '../db/db';
import { meaningLocalizations, meanings, topicMeanings, words, wordTypes } from '../db/schema';
import { AdminService } from '../modules/admin/services/admin.service';
import { PublicationService } from '../modules/admin/services/publication.service';

interface Sense {
  ipa: string;
  cefrLevel: CefrLevel;
  meaningText: string;
  definitionText: string;
  coreDefinition: string;
  example: string;
  target: string;
  translation: string;
}

/** Words whose senses sound different, so IPA and audio must follow the Meaning. */
const HETERONYMS: { lemma: string; partOfSpeech: PartOfSpeech; senses: Sense[] }[] = [
  {
    lemma: 'tear',
    partOfSpeech: 'noun',
    senses: [
      {
        ipa: '/tɪr/', cefrLevel: 'A2', meaningText: 'nước mắt', definitionText: 'giọt nước chảy ra từ mắt khi khóc',
        coreDefinition: 'a drop of liquid that comes from your eye when you cry',
        example: 'A tear ran down her cheek.', target: 'tear', translation: 'Một giọt nước mắt lăn trên má cô ấy.',
      },
      {
        ipa: '/tɛr/', cefrLevel: 'B1', meaningText: 'vết rách', definitionText: 'chỗ bị xé rách trên vải hoặc giấy',
        coreDefinition: 'a hole in cloth or paper where it has been pulled apart',
        example: 'There is a tear in my jacket.', target: 'tear', translation: 'Áo khoác của tôi có một vết rách.',
      },
    ],
  },
  {
    lemma: 'bass',
    partOfSpeech: 'noun',
    senses: [
      {
        ipa: '/beɪs/', cefrLevel: 'B1', meaningText: 'âm trầm', definitionText: 'phần âm thanh thấp nhất trong bản nhạc',
        coreDefinition: 'the lowest part in music, or a deep sound',
        example: 'Turn the bass down, please.', target: 'bass', translation: 'Làm ơn vặn nhỏ âm trầm xuống.',
      },
      {
        ipa: '/bæs/', cefrLevel: 'B2', meaningText: 'cá vược', definitionText: 'một loại cá sống ở sông, hồ hoặc biển',
        coreDefinition: 'a fish that lives in rivers, lakes or the sea',
        example: 'He caught a large bass in the lake.', target: 'bass', translation: 'Anh ấy câu được một con cá vược lớn ở hồ.',
      },
    ],
  },
  {
    lemma: 'lead',
    partOfSpeech: 'noun',
    senses: [
      {
        ipa: '/liːd/', cefrLevel: 'B1', meaningText: 'vị trí dẫn đầu', definitionText: 'vị trí đứng trước những người khác trong cuộc thi',
        coreDefinition: 'the first position in a race or competition',
        example: 'Our team took the lead in the second half.', target: 'lead', translation: 'Đội chúng tôi vươn lên dẫn đầu trong hiệp hai.',
      },
      {
        ipa: '/lɛd/', cefrLevel: 'B2', meaningText: 'chì', definitionText: 'một kim loại nặng, mềm, màu xám',
        coreDefinition: 'a soft, heavy, grey metal',
        example: 'Old water pipes were often made of lead.', target: 'lead', translation: 'Ống nước cũ thường được làm bằng chì.',
      },
    ],
  },
  {
    lemma: 'row',
    partOfSpeech: 'noun',
    senses: [
      {
        ipa: '/roʊ/', cefrLevel: 'A2', meaningText: 'hàng, dãy', definitionText: 'nhiều người hoặc vật xếp thành một đường thẳng',
        coreDefinition: 'a line of people or things next to each other',
        example: 'We sat in the front row.', target: 'row', translation: 'Chúng tôi ngồi ở hàng ghế đầu.',
      },
      {
        ipa: '/raʊ/', cefrLevel: 'B2', meaningText: 'cuộc cãi vã', definitionText: 'cuộc tranh cãi to tiếng giữa hai người',
        coreDefinition: 'a noisy argument between people who know each other',
        example: 'They had a row about money.', target: 'row', translation: 'Họ cãi nhau một trận vì chuyện tiền bạc.',
      },
    ],
  },
  {
    lemma: 'bow',
    partOfSpeech: 'noun',
    senses: [
      {
        ipa: '/boʊ/', cefrLevel: 'B1', meaningText: 'cái nơ', definitionText: 'dải ruy băng thắt thành hình hai vòng',
        coreDefinition: 'a knot with two loops, made with ribbon or string',
        example: 'She tied a red bow on the gift.', target: 'bow', translation: 'Cô ấy thắt một chiếc nơ đỏ lên món quà.',
      },
      {
        ipa: '/baʊ/', cefrLevel: 'B2', meaningText: 'cái cúi chào', definitionText: 'động tác cúi người để chào hoặc cảm ơn',
        coreDefinition: 'the act of bending your body forward to greet or thank someone',
        example: 'The actors took a bow at the end.', target: 'bow', translation: 'Các diễn viên cúi chào khi kết thúc.',
      },
    ],
  },
];

// Joins the topic that already teaches this word, so daily sessions reach it.
const TOPIC_OF_LEMMA = 'ticket';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get<Db>(DB);
  const admin = app.get(AdminService);
  const publications = app.get(PublicationService);

  const existing = await db
    .select({ lemma: words.lemma })
    .from(words)
    .where(and(eq(words.language, LEARNING_LANGUAGE), isNull(words.homographKey), inArray(words.lemma, HETERONYMS.map((h) => h.lemma))));
  const skip = new Set(existing.map((w) => w.lemma));

  const [topic] = await db
    .select({ topicId: topicMeanings.topicId })
    .from(topicMeanings)
    .innerJoin(meanings, eq(meanings.id, topicMeanings.meaningId))
    .innerJoin(wordTypes, eq(wordTypes.id, meanings.typeId))
    .innerJoin(words, eq(words.id, wordTypes.wordId))
    .where(and(eq(words.lemma, TOPIC_OF_LEMMA), isNull(meanings.ownerUserId)))
    .limit(1);

  const [{ top }] = topic
    ? await db.select({ top: max(topicMeanings.curatedRank) }).from(topicMeanings).where(eq(topicMeanings.topicId, topic.topicId))
    : [{ top: 0 }];
  const topicRows: (typeof topicMeanings.$inferInsert)[] = [];
  for (const word of HETERONYMS) {
    if (skip.has(word.lemma)) {
      console.log(`= ${word.lemma} already exists`);
      continue;
    }
    const created = await admin.createWord({
      language: LEARNING_LANGUAGE,
      lemma: word.lemma,
      types: [{
        partOfSpeech: word.partOfSpeech,
        meanings: word.senses.map((s) => {
          const start = s.example.indexOf(s.target);
          return {
            cefrLevel: s.cefrLevel,
            coreDefinition: s.coreDefinition,
            pronunciations: [{ accentLocale: DEFAULT_ACCENT, ipa: s.ipa }],
            examples: [{ sourceText: s.example, targetLocator: { start, end: start + s.target.length } }],
          };
        }),
      }],
    });
    const meaningRows = created.types[0].meanings;
    for (const [index, meaning] of meaningRows.entries()) {
      const sense = word.senses[index];
      await admin.putMeaningLocale(meaning.id, DEFAULT_LOCALE, {
        meaningText: sense.meaningText,
        definitionText: sense.definitionText,
        editorialState: EDITORIAL_STATE.APPROVED,
        exampleTranslations: [{ exampleId: meaning.examples[0].id, translationText: sense.translation }],
      });
      await publications.publish(meaning.id, DEFAULT_LOCALE);
      console.log(`+ ${word.lemma} ${sense.ipa}: ${sense.meaningText}`);
    }
    const base = (top ?? 0) + topicRows.length;
    if (topic) topicRows.push(...meaningRows.map((m, i) => ({ topicId: topic.topicId, meaningId: m.id, curatedRank: base + i + 1 })));
  }
  if (topicRows.length > 0) await db.insert(topicMeanings).values(topicRows);

  const live = await db
    .select({ lemma: words.lemma, text: meaningLocalizations.meaningText })
    .from(meaningLocalizations)
    .innerJoin(meanings, eq(meanings.id, meaningLocalizations.meaningId))
    .innerJoin(wordTypes, eq(wordTypes.id, meanings.typeId))
    .innerJoin(words, eq(words.id, wordTypes.wordId))
    .where(and(inArray(words.lemma, HETERONYMS.map((h) => h.lemma)), eq(meaningLocalizations.locale, DEFAULT_LOCALE)));
  console.log(`Heteronym senses in ${DEFAULT_LOCALE}: ${live.map((l) => `${l.lemma}=${l.text}`).join(', ')}`);
  await app.close();
}

void main();
