import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DB, Db } from '../db/db';
import { appUsers } from '../db/schema';
import { AdminService } from '../modules/admin/admin.service';
import { PublicationService } from '../modules/admin/publication.service';
import { SeedWord, seedTopic } from './seed-content';

const DEMO_SLUG = 'workplace-basics';
const DEMO_USERS = [['demo-a1', 'A1'], ['demo-a2', 'A2'], ['demo-b1', 'B1']] as const;

// Authored for this repo: the fixture named in the spec was not part of the upload.
const WORDS: SeedWord[] = [
  { lemma: 'clarify', partOfSpeech: 'verb', ipa: '/ˈklær.ə.faɪ/', cefrLevel: 'B1', meaningText: 'làm rõ', definitionText: 'làm cho điều gì dễ hiểu hơn', example: 'Please clarify this point.', translation: 'Vui lòng làm rõ điểm này.' },
  { lemma: 'achieve', partOfSpeech: 'verb', ipa: '/əˈtʃiːv/', cefrLevel: 'B1', meaningText: 'đạt được', definitionText: 'thành công làm được điều gì', example: 'We can achieve this goal.', translation: 'Chúng ta có thể đạt được mục tiêu này.' },
  { lemma: 'deadline', partOfSpeech: 'noun', ipa: '/ˈded.laɪn/', cefrLevel: 'B1', meaningText: 'hạn chót', definitionText: 'thời điểm phải hoàn thành việc gì', example: 'The deadline is Friday.', translation: 'Hạn chót là thứ Sáu.' },
  { lemma: 'schedule', partOfSpeech: 'noun', ipa: '/ˈskedʒ.uːl/', cefrLevel: 'A2', meaningText: 'lịch trình', definitionText: 'kế hoạch về thời gian', example: 'Check the schedule today.', translation: 'Hãy xem lịch trình hôm nay.' },
  { lemma: 'improve', partOfSpeech: 'verb', ipa: '/ɪmˈpruːv/', cefrLevel: 'A2', meaningText: 'cải thiện', definitionText: 'làm cho tốt hơn', example: 'We must improve the process.', translation: 'Chúng ta phải cải thiện quy trình.' },
  { lemma: 'request', partOfSpeech: 'noun', ipa: '/rɪˈkwest/', cefrLevel: 'A2', meaningText: 'yêu cầu', definitionText: 'lời đề nghị chính thức', example: 'I sent a request yesterday.', translation: 'Tôi đã gửi yêu cầu hôm qua.' },
  { lemma: 'meeting', partOfSpeech: 'noun', ipa: '/ˈmiː.tɪŋ/', cefrLevel: 'A1', meaningText: 'cuộc họp', definitionText: 'buổi gặp để thảo luận', example: 'The meeting starts now.', translation: 'Cuộc họp bắt đầu bây giờ.' },
  { lemma: 'answer', partOfSpeech: 'noun', ipa: '/ˈæn.sɚ/', cefrLevel: 'A1', meaningText: 'câu trả lời', definitionText: 'điều nói ra để đáp lại câu hỏi', example: 'This answer is correct.', translation: 'Câu trả lời này đúng.' },
];

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get<Db>(DB);
  await seedTopic({ db, admin: app.get(AdminService), publications: app.get(PublicationService) }, DEMO_SLUG, WORDS);
  await db
    .insert(appUsers)
    .values(DEMO_USERS.map(([identitySubject, level]) => ({ identitySubject, proficiencyLevel: level, learningLevel: level })))
    .onConflictDoNothing();
  await app.close();
}

void main();
