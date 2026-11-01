# Review thiết kế DB — các vấn đề cần xử lý

Ngày review: 2026-10-31. Phạm vi: `drizzle/`, `spec/`, các luồng commit, planner, progress và maintenance.

Mức độ: **Cao** là sai dữ liệu, chặn phát hành hoặc rất tốn kém nếu để sau. **Trung bình** là nên làm trước khi có tải thật. **Thấp** là dọn dẹp hoặc phòng ngừa.

Kiểm chứng: **Tái hiện** là đã chạy qua API hoặc lệnh SQL trên Postgres thật. **Đo** là `EXPLAIN ANALYZE` trên dữ liệu tổng hợp (1 triệu dòng evidence, 50 nghìn word). **Đọc code** là kết luận từ code, chưa chạy.

## Tổng hợp

| # | Vấn đề | Nhóm | Mức độ | Kiểm chứng |
|---|---|---|---|---|
| 1 | Lịch SRS tăng hai lần khi có hai plan song song | Memory | Cao | Tái hiện |
| 2 | Pronunciation gắn sai cấp | Evidence | Cao | Tái hiện |
| 3 | Evidence giữ chặt snapshot, không dọn được dữ liệu (đã xử lý) | Retention | Cao | Đo, đọc code |
| 4 | Không xoá được tài khoản | Vận hành | Cao | Tái hiện |
| 5 | Đổi locale làm tiến trình biến mất khỏi màn hình | Progress | Trung bình | Tái hiện |
| 6 | Đọc evidence đang full scan | Evidence | Trung bình | Đo |
| 7 | Thiếu bảng trạng thái skill (đã nâng mức vì scheduler phụ thuộc vào nó) | Evidence | Cao | Đọc code |
| 8 | Toàn vẹn dữ liệu đang dựa vào service | Evidence | Trung bình | Đọc code |
| 9 | Thiếu index cho FK | Vận hành | Trung bình | Đo |
| 10 | Thiếu ràng buộc unique trong nội dung | Catalog | Trung bình | Tái hiện |
| 11 | `memory_observations` chưa đủ để audit | Memory | Trung bình | Đọc code |
| 12 | Accent bị hardcode | Evidence | Trung bình | Đọc code |
| 13 | Receipt "tạm thời" tồn tại vĩnh viễn | Retention | Trung bình | Đọc code |
| 20 | `skill_evidence` lưu phần lớn dòng không ai đọc | Evidence | Trung bình | Đọc code |
| 15 | Streak và lapse sai ở chế độ non-Daily | Memory | Thấp | Đọc code |
| 16 | `source_task_ids` không có FK | Memory | Thấp | Đọc code |
| 17 | Thứ tự evidence trong session là ngầm định | Evidence | Thấp | Tái hiện |
| 18 | ~~Weekly quét toàn bộ progress mỗi giờ~~ (đã bỏ cron) | Vận hành | Thấp | Đọc code |
| 19 | Trigger bất biến chưa phủ đủ | Vận hành | Thấp | Đọc code |

## Mức độ cao

### 1. Lịch SRS tăng hai lần khi có hai plan song song

Hai session cùng chứa một Meaning đến hạn đều commit thành công, và mỗi lần đều giãn lịch.

- Kết quả tái hiện: commit A đưa interval từ 24h lên 48h. Commit B chỉ sau 1 giờ đưa lên 84h, streak thành 2.
- Nguyên nhân: `src/modules/session-commit/commit.service.ts:77` chỉ kiểm tra Meaning mới. Nhánh unaided ở `src/modules/memory-srs/srs.ts:50` không kiểm tra Meaning có đang đến hạn không.
- Cột `user_meaning_progress.version` được tăng ở `commit.service.ts:250` nhưng không ai đọc.

**Hướng sửa:** chỉ giãn lịch khi `next_review_at <= now` lúc commit; thất bại vẫn được kéo lịch sớm lại. Bỏ cột `version`, vì khoá user đã tuần tự hoá commit. Thêm test tái hiện kịch bản hai plan.

### 2. Pronunciation gắn sai cấp

`UNIQUE(type_id, accent_locale)` (`drizzle/0000_init.sql:415`) cho rằng mỗi từ loại chỉ có một cách đọc.

- Từ đồng dạng khác âm trong cùng từ loại như `bow`, `lead`, `tear`, `wind` không biểu diễn được. Lệnh insert cách đọc thứ hai bị DB từ chối.
- Ngược lại, `run` (n) và `run` (v) đọc giống nhau nhưng bị tách thành hai scope, nên phải verify Listening và Speaking hai lần.
- Đây là thay đổi tốn kém nhất nếu để sau, vì `skill_evidence` trỏ thẳng vào `pronunciation_id`.

**Hướng sửa:**

```sql
pronunciations(id, word_id, accent_locale, ipa, audio_asset_key)  -- thuộc Word
meaning_pronunciations(meaning_id, pronunciation_id)              -- quan hệ M:N
```

FK tới bảng M:N này cũng thay được validator "cùng Word/Type" ở tầng service.

Nghe và Nói đã chốt tính theo Pronunciation thuộc Word, nên mục này là điều kiện để skill dùng chung giữa các nghĩa.

### 3. Evidence giữ chặt snapshot, không dọn được dữ liệu

Chuỗi FK là `skill_evidence → practice_target_results → session_task_targets → session_tasks`. Evidence cần giữ lâu dài, nên snapshot của session đã commit không xoá được. Trigger bất biến còn cấm cả việc trim payload.

- Đo trên mẫu seed: khoảng 1,6 KB mỗi task, khoảng 44 KB mỗi session, chưa tính index.
- Ước tính với 10 nghìn user active, mỗi người một session mỗi ngày: khoảng 160 GB/năm. Con số này lấy từ mẫu nhỏ, chỉ dùng để hình dung độ lớn.
- `practice_task_results.normalized_result` chỉ lặp lại dữ liệu của `practice_target_results` (`commit.service.ts:182`).

Đo một session 160 task: `session_tasks` chiếm 119 KB, trong đó JSONB là 101 KB. Cùng dữ liệu đó, kể cả targets, gộp thành một JSONB còn 20 KB nhờ nén TOAST. `session_tasks` chỉ được đọc ở commit và speech assess, nên về bản chất là dữ liệu tạm.

**Đã xử lý** ở migration `drizzle/0002_session_history.sql`: một session là một dòng lịch sử practice của user.

- `learning_sessions` thêm `plan jsonb` (tasks, targets, learn steps, answer key), `result jsonb` (kết quả từng task và target) và `raw_events jsonb`. Xoá `plan` và `raw_events` theo retention, giữ `result`.
- Bỏ 5 bảng: `session_tasks`, `session_task_targets`, `session_learn_steps`, `practice_task_results`, `practice_target_results`.
- Truy vấn xuyên session chỉ dùng `user_meaning_progress`, `memory_observations`, `skill_evidence`.
- `speech_assessment_receipts` giữ làm bảng staging, FK tới session, xoá sau khi consumed (#13).
- **Đánh đổi:** CHECK `session_task_prompt_shape` chuyển sang validator ở tầng ứng dụng; mất FK tới task và `practice_items`; speech assess đọc cả `plan`; Weak chuyển sang đọc `memory_observations`, nên đếm theo session và chỉ tính tín hiệu semantic; thống kê theo template chạy trên JSONB. Phải sửa spec §2.2, §3, §4.3.

### 4. Không xoá được tài khoản

Xoá `app_user` lỗi ở `learning_sessions_user_id_fkey`. Các bảng thuộc user đều là `ON DELETE NO ACTION`, trừ settings và scope. Repo chưa có luồng xoá tài khoản.

App iOS có tạo tài khoản thì Apple bắt buộc phải có xoá tài khoản trong app, nên việc này chặn phát hành.

**Hướng sửa:** thêm `ON DELETE CASCADE` cho mọi bảng thuộc user, kèm endpoint xoá cả user bên Supabase Auth.

## Mức độ trung bình

### 5. Đổi locale làm tiến trình biến mất khỏi màn hình

Chuyển `explanation_locale` sang `en-US` khi Meaning chưa có bản dịch: `learnedTotal` vẫn là 10 nhưng `/me/words` trả 0 từ. Nguyên nhân là INNER JOIN `active_meaning_publications` theo locale hiện tại (`src/modules/progress/progress.service.ts:119`, `:136`). Cùng kiểu join đó cũng làm Meaning đến hạn rơi khỏi due count và planner.

**Hướng sửa:** các màn hình về tiến trình dùng LEFT JOIN và fallback sang publication còn lại. Chỉ planner mới cần fail closed.

### 6. Đọc evidence đang full scan

Hai partial index `idx_skill_meaning`, `idx_skill_pronunciation` (`drizzle/0000_init.sql:746-747`) không dùng được cho query ở `progress.service.ts:147`, vì query không có điều kiện `meaning_id IS NOT NULL`.

- Đo với 1 triệu dòng: Parallel Seq Scan, loại khoảng 1 triệu dòng để lấy 3.334 dòng, hết 32 ms.
- Query chạy ở cả `/me/words` và `/words/:id`, và luôn tải toàn bộ evidence của user dù chỉ xem một từ.
- Mỗi task tạo khoảng một dòng evidence, nên một Daily session mặc định tạo khoảng 38 dòng và goal 30 tạo khoảng 163 dòng (xem #20).

**Hướng sửa:** thêm index theo `(user_id, committed_at, id) WHERE directness = 'direct' AND validity = 'valid'`, và lọc theo scope của trang đang xem.

### 7. Thiếu projection trạng thái skill

Status được tính lại bằng TypeScript mỗi lần đọc, dẫn đến ba hệ quả:

- Đổi `requiredSessions` sẽ âm thầm đổi trạng thái `verified` của user cũ.
- Không thể lọc hay đếm "từ đã verified" bằng một câu SQL.
- Trái với rule aggregate của repo.

**Hướng sửa:** thêm `user_skill_state(user_id, skill, scope_id, status, needs_practice, last_passed, last_assessed_at, next_check_at, policy_version)`, khoá `(user_id, skill, scope_id)`, index `(user_id, next_check_at)`. Cập nhật trong commit cho các scope bị chạm và dùng lại `deriveSkillStatus`. Status luôn dựng lại được từ evidence.

Mục này đã nâng lên mức cao: planner đọc bảng này để xếp lịch, xem phần Quyết định đã chốt.

### 8. Toàn vẹn dữ liệu đang dựa vào service

`learning_sessions` có `UNIQUE(id, user_id)` nhưng không FK nào dùng. `user_id`, `meaning_id`, `pronunciation_id` trên evidence là bản sao, không có gì buộc chúng khớp với target của task.

**Hướng sửa:** thêm FK `(session_id, user_id)` cho `skill_evidence`, `memory_observations`, `practice_task_results`, và FK ghép từ evidence tới `session_task_targets`.

### 9. Thiếu index cho FK

| Index cần thêm | Ảnh hưởng | Kiểm chứng |
|---|---|---|
| `word_types(word_id)` | `/words/:id` | Đo: Seq Scan |
| `meanings(type_id)` | `/words/:id` | Đo: Seq Scan |
| `topic_meanings(meaning_id)` | Due count, planner | Đo: Seq Scan |
| `speech_assessment_receipts(session_id)` | Mọi commit | Đo: Seq Scan |
| `meaning_examples(meaning_id)` | Đọc ví dụ của Meaning | Đọc code |

### 10. Thiếu ràng buộc unique trong nội dung

- `words` cho phép trùng lemma; insert trùng đã thành công.
- `word_types` thiếu `UNIQUE(word_id, part_of_speech)`.
- `UNIQUE(id, word_id)` (`drizzle/0000_init.sql:412`) thừa và không FK nào dùng.

**Hướng sửa:** dùng `UNIQUE NULLS NOT DISTINCT (language, lemma, homograph_key)` cho `words`, thêm unique cho `word_types`, bỏ unique thừa.

### 11. `memory_observations` chưa đủ để audit

Bảng chỉ có ghi, chưa có đường đọc nào. Log không lưu kết quả scheduler, và `scheduler_version` trên progress bị ghi đè mỗi lần commit, nên không debug được vì sao một lịch ra như vậy.

**Hướng sửa:** thêm `prev_interval_hours`, `new_interval_hours`, `new_next_review_at`, `scheduler_version` vào observation. Weak ranking đã đọc từ bảng này.

### 12. Accent bị hardcode

`DEFAULT_ACCENT` nằm ở `src/modules/session-planner/planner.service.ts:70` và `progress.service.ts:45`, trong khi spec §2.5 tách riêng `pronunciationAccent`. Meaning không có pronunciation của accent này thì Listening và Speaking luôn là `notVerified`, nên Word không bao giờ verified.

**Hướng sửa:** thêm `pronunciation_accent` vào `user_settings`. Pronunciation tách theo accent nên đổi accent sẽ verify lại Nghe và Nói. MVP chỉ có `en-US` nên chưa phát sinh.

### 13. Receipt "tạm thời" tồn tại vĩnh viễn

`src/modules/maintenance/maintenance.service.ts:46` phải giữ receipt đã consumed vì evidence có FK tới nó, trong khi evidence không có điểm số.

**Hướng sửa:** copy `accuracy_score` sang evidence và đặt FK `ON DELETE SET NULL`, để receipt thật sự hết hạn theo TTL.

### 20. `skill_evidence` lưu phần lớn dòng không ai đọc

Số task của Daily session là `n × 5` cho từ mới (`dailyNewWordGoal`, tối đa 30) cộng tối đa 10 review và khoảng 30% task bonus. Mỗi task tạo khoảng một dòng evidence.

| Goal | Task mới (supporting) | Review (trung bình tối đa) | Tổng | Tỉ lệ không được đọc |
|---|---|---|---|---|
| 5 | 25 | 13 | 38 | 66% |
| 30 | 150 | 13 | 163 | 92% |

- Đọc duy nhất ở `progress.service.ts:158`, chỉ lấy `direct` + `valid`.
- Evidence ở phase `newPractice` luôn là `supporting` (`src/modules/skill-verification/skill-evidence.ts:32`), nên không ảnh hưởng status.
- `learning_sessions.result` đã lưu cùng độ chi tiết: outcome, hint, số lần thử, delivery mode.

**Hướng sửa:** `skill_evidence` chỉ lưu dòng `direct` + `valid`, tức dòng có thể đổi status. Lượng ghi khi đó chỉ theo số review, không theo `n × m`. Dữ liệu chi tiết nằm ở `learning_sessions.result` (#3), cần lưu cả `intent` và `accuracy_score` để vẫn phân tích được sau khi `plan` bị dọn. Cần cập nhật spec §2.2 và các test `test/api.test.ts:469`, `:482`.

## Mức độ thấp

### 15. Streak và lapse sai ở chế độ non-Daily

`applyNonDaily` (`srs.ts:88`) không reset `unaided_streak` và không tăng `lapse_count` khi recall sai ở Random, Weak, Checkpoint. Streak bonus vì thế vẫn giữ nguyên sau một lần quên thật.

### 16. `source_task_ids` không có FK

Cột JSONB này chứa mọi task của Meaning chứ không chỉ task quyết định signal (`src/modules/memory-srs/memory-reducer.ts:60`). Nên thay bằng FK tới task quyết định.

### 17. Thứ tự evidence trong session là ngầm định

`ORDER BY committed_at, id` hiện khớp thứ tự task, nhưng chỉ nhờ uuidv7 tăng đơn điệu và thứ tự sinh id trong commit. Nên lưu `task_ordinal` vào evidence.

### 18. ~~Weekly quét toàn bộ progress mỗi giờ~~

Đã xử lý: Checkpoint Challenge được tạo trong transaction commit, theo từng user, không còn cron.

### 19. Trigger bất biến chưa phủ đủ

Trigger chưa chặn DELETE và chưa bảo vệ `session_task_targets`. App lại kết nối bằng role `postgres`, như đã ghi trong `docs/DECISIONS.md`.

## Quyết định đã chốt

Các quyết định sau thay đổi spec §1, §2.2, §6 và `docs/DECISIONS.md`, chưa được triển khai.

1. **Skill dùng chung giữa các nghĩa của một từ, trừ Đọc.** Đã pass thì không verify lại ở nghĩa khác.
   - Đọc: theo Meaning. Viết: theo Word. Nghe và Nói: theo Pronunciation, sau khi #2 chuyển Pronunciation về Word.
   - Từ có hai cách đọc như `bow` có hai Pronunciation, nên pass cách đọc này không tính cho cách đọc kia. Từ có một cách đọc thì Nghe và Nói thực chất tính theo Word.
   - Khoá trạng thái là `(user_id, skill, scope_id)`; `skill` xác định `scope_id` là loại id nào.
2. **Lần học đầu không tính vào `verified`.** Nó chỉ cập nhật kết quả gần nhất và đưa skill vào lịch kiểm tra.
3. **Skill điều khiển scheduler.** Mỗi Meaning giữ một `next_review_at` cho trí nhớ, thêm `next_check_at` cho từng skill. Không làm 4 SRS.
   - Pass lần đầu hoặc fail: kiểm tra lại sau 24h. Đã `verified`: không xếp lịch riêng.
   - Planner ưu tiên skill yếu nhất, thay cho task bonus random 30%.
4. **Giới hạn interval khi chưa đủ 4 skill `verified`.** Ví dụ 14 ngày, giá trị cần thử nghiệm và đặt trong `src/config/policy.ts`. Skill `unavailable` không được giữ từ ở trạng thái bị giới hạn.

## Cần quyết định

`daily_new_word_goal` hiện tính theo session, nên user có thể học không giới hạn trong ngày (`planner.repository.ts:46`), trong khi tên cột và spec là theo ngày. Comment trong code cho thấy đây là chủ ý. Nếu muốn cap theo ngày thì `time_zone` và `idx_progress_learned` đã đủ, không cần đổi schema.

## Thứ tự sửa đề xuất

Nếu DB chưa có dữ liệu thật, nên viết lại `drizzle/0000_init.sql` thay vì thêm migration nối tiếp. Cần cập nhật cả `src/db/schema.ts` và `spec/*.sql`, vì `test/schema.test.ts` so khớp các bên.

1. **Thay đổi cấu trúc khó sửa về sau:** #7, #20, #2, #8, #4, #10.
2. **Sửa logic:** #1 kèm test tái hiện, scheduler theo skill, rồi #5.
3. **Thêm dần:** #9, #6, #11, #12, #13.
4. **Dọn dẹp:** #15 đến #19.

## Giữ nguyên, không cần sửa

- Khoá progress `(user, meaning)` không phụ thuộc locale.
- Tách log `memory_observations` khỏi state hiện tại, và khoá `(session, meaning)` cho một observation mỗi session.
- Evidence append-only, tách khỏi SRS, có CHECK buộc đúng scope theo skill.
- Commit một transaction, khoá theo user, idempotency bằng hash của request.
- Publication bất biến dùng con trỏ active, session giữ snapshot.

## Để sau được

Các thay đổi sau chỉ là thêm cột hoặc bảng, MVP chưa cần: lifecycle cho progress (suspend, "đã biết từ này", reset), cột state riêng cho FSRS, `publication_id` trên task, tách hoặc gộp Meaning, học nhiều ngôn ngữ.
