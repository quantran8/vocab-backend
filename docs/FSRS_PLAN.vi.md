# FSRS + bằng chứng có trọng số, Daily không có bài kỹ năng, skill chỉ đo mặt chữ và âm

> Bản tiếng Việt của [FSRS_PLAN.md](FSRS_PLAN.md). Nếu hai bản khác nhau, bản tiếng Anh là bản chuẩn.

## Bối cảnh

Session `01a1dcc8-…b0b8`: người học trả lời đúng cả 5 từ đến hạn, nhưng kết quả chỉ báo 3/5 "remember". Hai từ chỉ được giao `cloze_select`, là bài nhận diện. Chọn đúng đáp án không bao giờ được tính là solid, và chỉ được hoãn 24h một lần. "bargain" đã dùng lần hoãn đó từ trước, nên lịch không đổi và từ này cứ đến hạn mãi.

Nguyên nhân gốc:
- Bộ lập lịch (`src/modules/memory-srs/srs.ts`) chia câu trả lời thành tự nhớ và nhận diện. Trong khi app đi theo kiểu Duolingo, phần lớn bài không phải bài gõ.
- Planner bốc dạng bài ngẫu nhiên, không xét dạng nào thực sự giúp ghi nhận trí nhớ.
- Hệ thống skill chạy một mô hình trí nhớ thứ hai song song. Reading và writing trùng với trí nhớ nghĩa. Quy tắc "2 session, cách nhau 24h" trùng với việc giãn cách. Daily review còn bị thêm bài kỹ năng.

Thiết kế đích (đã thống nhất):
1. **FSRS-6 là mô hình trí nhớ duy nhất**, cho nghĩa của từ. Nó quyết định *khi nào ôn* và *ôn từ nào*.
2. **Mỗi bài mang một trọng số bằng chứng theo nhóm.** Các bài cùng bản chất dùng chung nhóm: `match` chung nhóm với `select`.
3. **Daily review: đúng một bài nghĩa cho mỗi từ đến hạn**, không thêm bài kỹ năng.
4. **Skill chỉ đo mặt chữ và âm** (listening, speaking, spelling). Skill quyết định *dạng bài nào*, không quyết định khi nào ôn.
5. **Màn kết quả chia nhóm theo đúng/sai, không theo trọng số.** Đúng sạch là remembered (solid). Có trợ giúp, thử lại hoặc primed là shaky. Sai là relearn.
6. **Tiến độ hiện có được quy đổi trực tiếp** từ `interval_hours` và `lapse_count`.

## 1. Nhóm bằng chứng và trọng số (logic thuần)

- `src/common/constants/domain.ts`
  - Thêm `EVIDENCE_CLASS`:

    | Nhóm | Giá trị | Variant |
    |---|---|---|
    | `RECALL_PRODUCE` | `recall_produce` | `typing` meaning_recall |
    | `RECALL_ASSEMBLED` | `recall_assembled` | `fly_reorder` spelling_recall |
    | `RECOGNIZE_CONTEXT` | `recognize_context` | `cloze_select` single_blank, context_meaning |
    | `RECOGNIZE` | `recognize` | `select` gloss, reverse_gloss, meaning_clash · `match` meaning_pairs, word_pairs |

  - Thêm `CLASS_BY_VARIANT`, đặt cạnh `INTENT_BY_VARIANT` ở `src/modules/practice-resolver/curated.ts:38`. Các variant không thuộc nhóm nào thì không mang bằng chứng về nghĩa: phonetic/stress choice, transcription, fix_spelling, recording.
  - Thêm `FSRS_GRADE = { AGAIN: 'again', HARD: 'hard', GOOD: 'good', EASY: 'easy' }`.
- `src/config/policy.ts`: thêm `memoryEvidence`.
  - `weights`: { recall_produce: 1.0, recall_assembled: 0.7, recognize_context: 0.4, recognize: 0.3 }
  - `audioFactor`: 1.2 (không vượt quá trọng số của nhóm kế trên)
  - `baseOptionCount`: 4
- File mới `src/modules/memory-srs/evidence-weight.ts`:
  - `answerWeight({ variant, optionCount, promptIsTargetAudio })` = w × (1 − 1/n) / (1 − 1/4) × hệ số audio.
  - `combineWeights(ws)` = 1 − Π(1 − wᵢ), tối đa là 1.
- Lấy `optionCount` lúc commit: `clientPayload.options.length` cho select/cloze, `pairs.left.length` cho match. `TaskRow` đã có sẵn `clientPayload`, được đọc ở `commit-evaluator.ts:66`.
  - Match tạm tính gần đúng: mọi cặp dùng tổng số cặp, vì thứ tự giải từng cặp không được lưu.

## 2. Lõi FSRS (logic thuần, không phụ thuộc Nest/Drizzle)

- File mới `src/modules/memory-srs/fsrs.ts`. Tự viết công thức FSRS-6 để có thể cập nhật theo trọng số:
  - `retrievability(elapsedDays, S)`, `intervalDays(S, desiredRetention)`
  - `initialState(outcome, at)`: S0 theo điểm. Một lần đúng sạch thì nội suy từ S0(Hard) đến S0(Good) theo W.
  - `knownState(at)`: S = `knownInitialDays`, D = D0(Easy).
  - `applyReview(state, outcome, at)`:
    - ôn trong cùng ngày thì dùng công thức ngắn hạn
    - đúng: S' = S·(1 + W·(SInc_good − 1)), phần cập nhật D cũng nhân theo W
    - Hard: công thức recall có hard penalty
    - Again: stability sau lapse, lapse + 1
  - `next_review_at` = at + interval, kẹp trong khoảng `minIntervalHours` đến `maxIntervalDays`.
- `src/config/policy.ts`: thay `POLICY.srs` bằng `POLICY.fsrs`.
  - `w`: 21 tham số mặc định của FSRS-6, chép từ `ts-fsrs` lúc triển khai
  - `desiredRetention`: 0.9
  - `maxIntervalDays`: 90
  - `minIntervalHours`: 12
  - `knownInitialDays`: 7, thay cho `newLearning.knownInitialHours`
- Thêm `ts-fsrs` **chỉ làm devDependency**. Test đối chiếu kiểm tra rằng `applyReview` với W = 1 / Hard / Again cho cùng kết quả như `ts-fsrs` khi dùng cùng tham số.
- Xóa `srs.ts` (`applyDailyDue`, `applyNonDaily`, logic grace). Một hàm `applyReview` dùng cho mọi mode, vì FSRS tự xử lý việc ôn sớm.
- `SrsState` thành { learnedAt, lastReviewedAt, nextReviewAt, stability, difficulty, lapseCount }.
- `SCHEDULER_VERSION` = `'fsrs6-weighted-v1'` (`domain.ts:301`).

## 3. Reducer → kết quả ôn

- `src/modules/memory-srs/memory-reducer.ts`
  - Giữ `signalOf`, `reduceMemory` và cột `signal`. Journey `reviewCounts` và phần xếp hạng Weak (`planner.repository.ts:218`) vẫn đọc nó.
  - Thêm vào `MemoryDraft`: `grade` và `weight`.
    - `FAILED_*` → AGAIN
    - `ASSISTED_RECALL` hoặc primed → HARD
    - `UNAIDED_RECALL` / `RECOGNITION_SUCCESS` → GOOD, với W = `combineWeights` của các câu trả lời sạch
    - W = 0 (chỉ có bài không thuộc nhóm nào) → không tính là lượt ôn
  - `MemoryFact` thêm `variant`, `optionCount` và `promptIsTargetAudio`, được điền ở `commit-evaluator.ts:151-166`.
- `src/modules/session-commit/services/commit.service.ts:177-195` `applySrs`:
  - Từ mới → `initialState` / `knownState`. Giữ nguyên chính xác các quy tắc known, declaredKnown và slip.
  - Từ đã có tiến độ → `applyReview` ở mọi mode.
  - Grade là null thì giữ nguyên trạng thái, kể cả `last_reviewed_at`.

## 3b. Điểm Easy từ thời gian trả lời

Commit của session hiện chưa ghi thời gian. `eventSchema` ở `src/modules/practice-evaluator/events.ts:8` chỉ có `seq`.

- **Client (thay đổi API):** mỗi event có thêm trường tùy chọn `elapsedMs`, là số ms tính từ lúc task hiện ra. Cách làm theo `elapsedMs` mà Challenge Map đang dùng (`src/modules/challenge/domain/match-madness.ts:40`).
- **Kiểm tra hợp lệ:** không được giảm dần giữa các event của một task, và có giới hạn trên trong policy.
- **Ghi nhận:** evaluator (`src/modules/practice-evaluator/evaluate.ts` `tallyAttempts`) ghi `firstSubmitMs` cho từng target. Giá trị này được giữ trong `result.tasks` để hiệu chỉnh về sau.
- **Quy tắc Easy:** thỏa cả 4 điều kiện:
  - đúng sạch ngay lần đầu
  - thuộc nhóm `recall_produce` hoặc `recall_assembled` (bài nhận diện không bao giờ được Easy)
  - `firstSubmitMs` ≤ ngưỡng
  - không bị primed
- **Ngưỡng** nằm trong `POLICY.memoryEvidence.easy` (TRIAL):
  - typing: `baseMs + perCharMs × độ dài đáp án`
  - fly_reorder: `baseMs + perTileMs × số tile`
- **Tác dụng:** grade EASY, áp dụng với easy bonus của FSRS. Nếu thiếu `elapsedMs` thì không bao giờ cho Easy, nên các bản app cũ vẫn chạy bình thường.
- `memory_observations.grade` có thể là `'easy'`.
- **Rủi ro:** thời gian do client gửi lên. Easy chỉ làm giãn lịch ôn của chính người học, và LP không đọc giá trị này, nên gian lận không được lợi gì.
- **Về sau:** chuyển sang so tốc độ với trung vị của chính người học, khi đã có đủ dữ liệu thời gian.

## 4. Màn kết quả, LP

- `src/modules/session-commit/domain/result-summary.ts`
  - `reviewGroupOf`: chia theo đúng/sai.
    - solid: tự nhớ ra không trợ giúp và không primed, **hoặc** chọn đúng đáp án
    - shaky: có trợ giúp hoặc bị primed
    - relearn: sai
    - Bỏ cause `RECOGNIZED_ONLY` khỏi review. Chỉ giữ hằng số nếu nơi khác còn dùng.
  - `countedAsReview`: từ đã đến hạn trước commit + grade GOOD + không primed.
  - Bỏ comment nói nhóm hiển thị phải khớp với nhánh SRS.
- LP (`src/modules/learning-points/domain/lp-awards.ts`): giữ nguyên. Nó chỉ đọc `nextReviewAt` trước commit.

## 5. Migration DB `drizzle/0019_fsrs_form_skills.sql`

Thêm vào `_journal.json`, và cập nhật tương ứng trong `spec/001_initial_schema_v0.4_FULL_SPEC_PROPOSED.sql` và `src/db/schema.ts`.

**`user_meaning_progress`**
- Thêm `stability numeric(12,4) NOT NULL CHECK (> 0)` và `difficulty numeric(6,4) NOT NULL CHECK (BETWEEN 1 AND 10)`.
- Điền dữ liệu bằng một câu UPDATE:
  - S = greatest(interval_hours/24, 0.1)
  - D = least(10, D0(Good) + lapse_count)
  - scheduler_version = giá trị mới
- Xóa `interval_hours`, `unaided_streak` và `recognition_grace_used`.

**`memory_observations`**
- Thêm `grade varchar(8) NULL CHECK (grade IN ('again','hard','good','easy'))` và `evidence_weight numeric(4,3) NULL`.

**`skill_evidence`**
- `DELETE WHERE skill = 'reading'`.
- `UPDATE skill = 'spelling' WHERE skill = 'writing'`.
- Thay `skill_evidence_skill_check` và check về phạm vi: spelling → meaning_id; listening/speaking → pronunciation_id.

**Ghi lúc commit**
- `commit.repository.ts:127-134` (đọc JSON) và `:200-243` (upsert bằng `jsonb_to_recordset`, insert observation): đổi các cột.
- Cập nhật `src/seed/seed-polysemy.ts:110-119`.

## 6. Planner

- `src/modules/session-planner/domain/plan-builder.ts:183-202` `reviewTasks`, Daily:
  - đúng một bài chính cho mỗi target
  - không có bài thưởng `skillBonusChance`
  - `pickWeighted` theo `POLICY.review.classPickWeight[class]`, thay cho `semanticWeight` đồng đều (ví dụ recognize 2, recognize_context 2, recall_assembled 1.5, recall_produce 1)
- Ưu tiên theo skill: target có issue listening đang mở thì nhân đôi các ứng viên đề audio; có issue spelling đang mở thì nhân đôi các ứng viên tự nhớ.
- Checkpoint giữ `recallOnly`; Random/Weak giữ đường đi theo skill.
- `src/modules/session-planner/repositories/planner.repository.ts:117-145` `dueTargets`: một query duy nhất, không thêm round trip.
  - Select `stability` và `last_reviewed_at`.
  - `ORDER BY` retrievability tăng dần, tính trong SQL từ hằng số decay/factor của FSRS (truyền vào dạng `::float8`), rồi theo `meaning_id`.
  - Gộp các issue skill đang mở của từng target trong cùng câu lệnh, dùng lại `openSkillIssuesSql` (`skill-issue.sql.ts:11`).

## 7. Skill chỉ đo mặt chữ và âm

- `domain.ts:96-117`
  - `SKILL` = { LISTENING, SPEAKING, SPELLING: 'spelling' }
  - `SKILL_STATUS` bỏ `VERIFIED`, giữ not_verified / demonstrated
  - `SKILL_CHANGE` giữ leveledUp / cleared / pendingConfirm / regressed
- `src/modules/skill-verification/skill-evidence.ts`
  - `skillOf` / `evidenceFor`:
    - nhận diện đề audio → listening
    - nhận diện đề chữ → null
    - pairing → null
    - meaning_recall → spelling
    - spelling_repair → spelling (vẫn là template yếu)
    - transcription đề audio → listening
    - sound_discrimination → listening (template yếu)
    - pronunciation → speaking
  - `deriveSkillStatus`: bỏ quy tắc verified. Xóa `POLICY.skill`.
  - `WordScopes` / `isWordFullyVerified`: xóa.
- `skill-issue.sql.ts`, `progress.service.ts:55-85`, `progress.repository.ts`:
  - Chi tiết từ trả về `skills: { spelling, listening?, speaking? }`.
  - Bỏ `fullyVerified`.
  - Mỗi nghĩa có thêm `memory: { stabilityDays, retrievability, nextReviewAt }`.
- `planner.service.ts:25-26`: enum `skills` bỏ `reading`. `taskForSkill` (`plan-builder.ts:128`): spelling → fly/typing.
- `result-summary.ts`: chỉ điền `struggledAt` khi skill của task là skill mặt chữ hoặc âm. `practiceSummary` / `skillChanges` chạy như cũ trên bộ skill mới.

## 8. Tài liệu

- `docs/DECISIONS.md`: thêm một mục mới gồm:
  - FSRS cùng nhóm bằng chứng và trọng số
  - Daily với một bài nghĩa cho mỗi từ
  - skill chỉ đo mặt chữ và âm
  - nhóm kết quả theo đúng/sai
  - công thức quy đổi dữ liệu cũ
  - Mục này thay thế các dòng :13–:27 và :106–:119 ở những chỗ mâu thuẫn.
- `docs/FRONTEND_FLOW.md`, ở bảng skill :197-206, chi tiết từ :166-172, màn kết quả :1069-1129 và skills của Random :183:
  - key skill mới
  - không còn `verified` / `fullyVerified`
  - block `memory` mới
  - `reading` bị từ chối
  - trường tùy chọn `elapsedMs` trên event của task
  - **Frontend phải release cùng lúc với thay đổi này.**
- `spec/Vocab_Flow_Backend_FULL_SPEC_v0.4_2026-10-30.md:736-742,1009-1036,1045`: đánh dấu công thức SRS và phần xác nhận bốn skill là đã được thay bằng DECISIONS.

## Kiểm tra

- **Unit:**
  - `fsrs.spec.ts`: đối chiếu với `ts-fsrs`; S tăng đơn điệu theo W; nhánh ôn trong ngày; các giới hạn kẹp.
  - `evidence-weight.spec.ts`: các nhóm; số đáp án (n = 2 thì thấp hơn, n = 1 thì bằng 0); giới hạn của hệ số audio; cách gộp.
  - Quy tắc Easy:
    - gõ đúng sạch và nhanh → EASY
    - gõ chậm → GOOD
    - select nhanh → GOOD
    - thiếu `elapsedMs` → GOOD
    - `elapsedMs` giảm dần → `INVALID_SUBMISSION`
  - Cập nhật `memory-srs.spec.ts`, `result-summary.spec.ts` (nhận diện đúng hết → solid), `skill-evidence.spec.ts`, `resolver.spec.ts:131`.
  - Thêm test Daily `reviewTasks` trong `plan-builder.spec.ts`: một bài cho mỗi target, không có recording/transcription, tuân theo trọng số nhóm.
- **Integration:**
  - Sửa các chỗ tua đồng hồ đang giả định interval 12/24/48/168h: `api.test.ts:393,421,640-692`, `scope-review.test.ts:306,338` và các chỗ còn lại trong kết quả khảo sát. Khi được, kiểm tra bằng `nextReviewAt > now` và stability thay vì số giờ chính xác.
  - Sửa `skill-practice.test.ts`: `reading` → 400; thêm đường đi spelling.
  - Sửa `session-summary.test.ts` (C65, C69–C72).
  - `test/schema.test.ts` phải pass với spec SQL đã cập nhật.
  - Số query trong `test/api.test.ts:1062-1101` phải bằng nhau giữa 1 và 20 Meaning, với `commit < 8`.
- **Hồi quy cho bug đã báo:** một test integration mới.
  - Daily với 5 từ đến hạn, mỗi task là một `cloze_select` trả lời đúng.
  - Kỳ vọng cả 5 là solid.
  - Kỳ vọng mọi `nextReviewAt` > now và stability tăng.
- **Chạy:** `pnpm lint && pnpm test && pnpm build`, rồi `pnpm db:migrate` trên một bản sao dữ liệu prod. Kiểm tra bước điền dữ liệu không tạo S/D bị NULL hay nằm ngoài khoảng cho phép.
