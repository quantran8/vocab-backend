# Vocab Flow: hướng dẫn tích hợp cho Frontend

Flow từ đăng nhập đến hoàn thành một session practice, và chi tiết từng template. Trạng thái: khớp code backend v0.4 (spec v0.4 chưa được duyệt, các số liệu policy là giá trị thử nghiệm).

Quy ước chung:

- Base path `/v1`. Body và response là JSON, camelCase. Id là UUID v7 dạng string, **trừ** `option/tile/pair id` bên trong task là số nguyên.
- Mọi route yêu cầu `Authorization: Bearer <accessToken>` trừ `/v1/auth/*`.
- Không gửi `userId` ở bất kỳ đâu. Backend lấy user từ token. User được tạo tự động ở request đầu tiên có token hợp lệ.
- Thời gian trả về là ISO 8601 UTC.
- Swagger: `/docs`.

## 1. Tổng quan flow

```
signup / login / google ──► token
        │
        ▼
GET /me ──► (chưa có level/scope?) ──► onboarding:
        │      PUT /me/levels hoặc bài test (GET + POST /me/placement-test)
        │      → GET /catalog/collections → PUT /me/scope (+ PUT /me/settings)
        ▼
GET /me/learn-home ──► chọn mode
        │
        ▼
POST /sessions/plan ──► steps[] (learn + practice)
        │
        ▼
Client chạy từng step, chấm ngay tại máy, ghi lại events
        │   (recording: POST /sessions/{id}/recording-assess)
        ▼
POST /sessions/{id}/commit ──► summary
```

Nguyên tắc quan trọng nhất: **client chấm đúng/sai ngay lập tức** bằng khối `evaluation` trong payload để phản hồi tức thì, nhưng backend **chấm lại toàn bộ từ danh sách events** khi commit. Kết quả học tập chỉ được tính khi commit thành công. Client không gửi "đúng/sai", chỉ gửi những gì người dùng đã làm.

## 2. Auth

Backend proxy sang Supabase Auth. Mọi route đều public.

| Endpoint | Body | Response |
|---|---|---|
| `POST /v1/auth/signup` | `{email, password}` | `201 {session, confirmationRequired}` |
| `POST /v1/auth/login` | `{email, password}` | `200 session` |
| `POST /v1/auth/google` | `{idToken, nonce?}` | `200 session` |
| `POST /v1/auth/apple` | `{idToken, nonce?}` | `200 session` |
| `POST /v1/auth/recover` | `{email}` | `200 {sent: true}` |
| `POST /v1/auth/recover/verify` | `{email, code, password}` | `200 session` |
| `POST /v1/auth/refresh` | `{refreshToken}` | `200 session` |

```jsonc
// session
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 3600, "user": { "id": "<supabase user id>", "email": "a@b.com" } }
```

- Password 8–72 ký tự. Mật khẩu tạo mới (`signup`, `recover/verify`, `PUT /me/password`) còn phải có ít nhất một chữ cái và một chữ số, nếu không trả `400 VALIDATION_FAILED`. `login` chỉ kiểm tra độ dài. Email được backend trim và lowercase.
- **Signup:** nếu project bật xác nhận email, response là `{session: null, confirmationRequired: true}`. Hiện màn "kiểm tra email", sau khi xác nhận thì gọi `login`.
- **Google:** dùng Google Sign-In SDK trên iOS lấy ID token, gửi `idToken`. Nếu SDK yêu cầu nonce, gửi nonce **gốc** (chưa hash) vào `nonce`. Không có redirect OAuth.
- **Apple:** Sign in with Apple trên iOS lấy `identityToken`, gửi vào `idToken`. Gửi SHA-256 của nonce cho Apple, nonce **gốc** vào `nonce`. Supabase phải bật provider Apple với bundle ID của app làm client ID.
- **Quên mật khẩu:** `recover` gửi email chứa mã (template "Reset Password" của Supabase phải có `{{ .Token }}`). Luôn trả `200` dù email có tài khoản hay không. App hỏi mã + mật khẩu mới rồi gọi `recover/verify`: đúng mã thì đặt mật khẩu mới và trả session (đăng nhập luôn). Sai hoặc hết hạn: `400 RESET_CODE_INVALID`.
- **Đổi mật khẩu:** `PUT /v1/me/password` (bearer) body `{currentPassword, newPassword}` trả `200 {changed: true}`. Sai mật khẩu hiện tại: `403 WRONG_PASSWORD` (không dùng 401 để client không đăng xuất). Tài khoản chỉ đăng nhập bằng Google/Apple chưa có mật khẩu: dùng "Quên mật khẩu" để tạo.
- **Lưu token:** Keychain. Refresh token dùng một lần, mỗi lần refresh nhận cặp token mới và phải thay cả hai.
- **Refresh:** gọi khi `expiresIn` sắp hết, hoặc khi bất kỳ request nào nhận `401 UNAUTHORIZED`: refresh một lần rồi retry request gốc một lần. Nếu refresh cũng `401` thì đăng xuất.
- Lỗi: `401 UNAUTHORIZED` (sai thông tin/token hỏng), `409 EMAIL_ALREADY_REGISTERED`, `400 VALIDATION_FAILED`, `503 AUTH_PROVIDER_UNAVAILABLE` (retryable).

### Xoá tài khoản

`DELETE /v1/me` (cần bearer token, không có body) trả `200 { deleted: true }`.

- Xoá vĩnh viễn dữ liệu học, từ tự thêm, nghĩa riêng tư, bản sửa riêng và cả user bên Supabase Auth. Không khôi phục được, nên phải hỏi xác nhận trước khi gọi. Sau khi thành công, xoá token và dữ liệu cục bộ.
- Thao tác là tất cả hoặc không có gì: `503 AUTH_PROVIDER_UNAVAILABLE` (retryable) nghĩa là chưa có gì bị xoá, cho user thử lại.
- Access token cũ của tài khoản đã xoá nhận `401` ở mọi request và không tạo lại user. Nếu mất response rồi gọi lại, request đó cũng nhận `401`, và refresh cũng `401` nên client đăng xuất như bình thường.
- Nội dung đã thuộc kho chung vẫn được giữ, chỉ bỏ liên kết với user: từ, phát âm, audio, nghĩa thường và nghĩa riêng đã được admin duyệt.

## 3. Onboarding và cài đặt

`GET /v1/me` trả hồ sơ:

```jsonc
{
  "id": "...", "proficiencyLevel": "B1" | null,
  "settings": { "explanationLocale": "vi-VN", "uiLocale": "vi-VN", "timeZone": "...", "dailyNewWordGoal": 5, "weeklySessionGoal": 7, "...": "..." },
  "scope": { "collectionId": "...", "topicIds": ["..."] } | null
}
```

User mới: `proficiencyLevel` và `scope` là `null` thì đi onboarding. Chưa có scope thì không có Meaning nào để học, plan trả về rỗng. `settings` còn có thêm vài trường nội bộ (`learningLanguage`, `updatedAt`), client bỏ qua được.

| Bước | Request |
|---|---|
| Chọn level | `PUT /v1/me/levels` `{proficiencyLevel: "A1".."C2"}`; level chỉ dùng để sắp xếp từ mới (từ ≥ level trước), không loại từ nào |
| Chưa biết level | Làm bài test ngắn thay cho bước trên, xem bên dưới |
| Danh sách nội dung | `GET /v1/catalog/collections` → `{collections:[{id,slug,title,description,topics:[{id,slug,title,description}]}]}`, đã localize theo `uiLocale` |
| Chọn phạm vi học | `PUT /v1/me/scope` `{collectionId, topicIds:[1..100]}`. Topic phải published và thuộc collection, nếu không thì `400` |
| Cài đặt | `PUT /v1/me/settings` (strict, ít nhất 1 trường): `explanationLocale`, `uiLocale` (`en-US` hoặc `vi-VN`), `timeZone` (IANA, ví dụ `Asia/Ho_Chi_Minh`), `dailyNewWordGoal` (1–30), `weeklySessionGoal` (1–7) |

- `explanationLocale` quyết định ngôn ngữ của nghĩa, câu hỏi và nội dung trong task. Đổi locale ảnh hưởng đến session sau đó, không ảnh hưởng session đã plan.
- `dailyNewWordGoal` là số từ mới **mỗi session** daily, không phải mỗi ngày: hoàn tất một session thì luôn có thể plan session tiếp theo.
- `weeklySessionGoal` là số buổi học mỗi tuần user chọn (mặc định 7). Chỉ dùng để hiển thị (`checkpointSessionsRequired`, độ dài chặng Journey cũ): không còn mở challenge, và không ảnh hưởng Challenge Map. `dailyNewWordGoal` cũng không ảnh hưởng Challenge Map.

### Bài test xếp level

Dành cho user chưa biết mình ở level nào. Chỉ có câu `select`, không có audio.

`GET /v1/me/placement-test`:

```jsonc
{ "questions": [{
  "id": "<questionId>", "template": "select", "variant": "gloss",
  "prompt": { "type": "text", "text": "clarify" },
  "question": "Từ này có nghĩa là gì?",
  "options": [{ "id": "<uuid>", "text": "làm rõ" }, { "id": "<uuid>", "text": "..." }]   // 2 đến 4 lựa chọn
}] }
```

- Tối đa 3 câu mỗi level, A1 đến C2 (tối đa 18 câu), dễ trước khó sau. Giữ nguyên thứ tự câu và thứ tự `options`.
- **Khác task thường:** option `id` là **UUID string**, không phải số, và không có `evaluation`. Client không chấm và không hiện đúng/sai, mỗi câu chỉ chọn một lần.
- `questions` rỗng nghĩa là chưa đủ nội dung: chuyển sang cho user tự chọn level bằng `PUT /v1/me/levels`.

`POST /v1/me/placement-test` gửi một lần khi làm xong, kèm mọi câu đã nhận:

```jsonc
{ "answers": [{ "questionId": "...", "optionId": "..." }, { "questionId": "...", "optionId": null }] }   // null = "Không biết"
```

Response `200 {proficiencyLevel, correctCount, totalCount}`. Level được lưu luôn, không cần gọi thêm `PUT /v1/me/levels`.

- Nên có nút "Không biết": đoán bừa làm level bị cao hơn thực tế.
- Một level đạt khi đúng từ 60% số câu. Kết quả là level cao nhất mà nó và mọi level dưới nó đều đạt; không đạt level nào thì là `A1`.
- User vẫn đổi được kết quả bằng `PUT /v1/me/levels`, và làm lại test được. Bài test không tạo tiến độ học hay skill evidence.
- `400 VALIDATION_FAILED`: trùng `questionId`, hoặc không có câu nào hợp lệ.

## 4. Màn hình Home và tiến độ

- `GET /v1/me/learn-home` → `{dueCount, checkpointAvailable, checkpointSessionsDone, checkpointSessionsRequired, learnedTotal}`. Một request cho cả Home. Các trường `checkpoint*` là **legacy**: không còn challenge mới nên `checkpointSessionsDone` dừng ở `checkpointSessionsRequired`. Phần Challenge Map trên Home lấy từ `GET /v1/me/challenge-map` (mục 12). Hai khối `scope` và `reviewLoad`: xem §13.
- **Deprecated** `GET /v1/me/checkpoint-challenges` → `{challenges:[{id, sequence, state:"available", createdAt, meaningCount}]}`. Backend không tạo challenge mới nữa; chỉ còn các challenge đã mở trước đây, vẫn chơi được một lần bằng mode `checkpoint_challenge`.
- **Không còn khoá từ mới:** challenge đang chờ không chặn plan `daily`. Challenge Map cũng không bao giờ chặn Daily.
- **Deprecated** (thay bằng Challenge Map, xoá khi client cũ hết hỗ trợ) `GET /v1/me/journey?historyLimit=2&futureLimit=1&before=` → Journey: mỗi chặng (segment) là N session học từ mới + 1 Tổng ôn (chính là checkpoint challenge, `segmentNo` = `sequence`). Backend quyết định mọi trạng thái; client chỉ vẽ.
  ```jsonc
  { "currentSegmentNo": 2, "focusNodeId": "segment:2:learning:1", "completedReviewCount": 1,
    "segments": [ // chặng tương lai trên cùng → chặng hiện tại → chặng cũ
      { "segmentNo": 2, "status": "active", "completedLearningCount": 0, "nodes": [
        { "id": "segment:2:learning:1", "segmentNo": 2, "type": "learning", "ordinal": 1, "state": "current" },
        // ... learning 2–7 "locked"
        { "id": "segment:2:review", "segmentNo": 2, "type": "review", "ordinal": 8, "state": "locked" } ] },
      { "segmentNo": 1, "status": "completed", "completedLearningCount": 7, "nodes": [
        { "id": "segment:1:learning:1", "segmentNo": 1, "type": "learning", "ordinal": 1, "state": "completed", "sessionId": "..." },
        // ...
        { "id": "segment:1:review", "segmentNo": 1, "type": "review", "ordinal": 8, "state": "completed", "reviewId": "<challengeId>",
          "result": { "reviewedCount": 7, "unaidedRecalledCount": 4, "needsReviewCount": 3 } } ] } ],
    "hasMoreHistory": false, "nextHistoryCursor": null }
  ```
  - Số node mỗi chặng = số session + 1 (review luôn cuối, `ordinal` = số session + 1). Chặng đã có challenge giữ số session nó đã lấy; chặng hiện tại và tương lai theo `weeklySessionGoal` hiện tại, nên các chặng có thể dài khác nhau. `checkpointSessionsRequired` trong learn-home cũng theo giá trị này. `id` không đổi khi node đổi trạng thái. `state`: `locked | current | completed`; cả hệ thống chỉ có một node `current`.
  - `status`: `completed` (đã Tổng ôn), `active` (chặng hiện tại), `preview` (chặng sau, chưa mở).
  - Node `review` có `reviewId` (= challenge id) khi challenge đã mở: plan `checkpoint_challenge` với `challengeId` này. `result` chỉ có khi đã hoàn thành.
  - `historyLimit` 0–10, `futureLimit` 0–3. Trang lịch sử tiếp theo: `before=nextHistoryCursor`, chỉ trả các chặng cũ hơn.
  - Chỉ session `daily` có học từ mới mới chiếm một slot; ôn tập, Random/Weak practice và commit gửi lại thì không.
- `GET /v1/me/words?limit=50&offset=0&q=` (limit 1–100): từ đã học, mới học nhất trước. Trang ngắn hơn `limit` là hết.
  - `q` (tuỳ chọn, tối đa 64 ký tự) tìm trên từ tiếng Anh và nghĩa, không phân biệt hoa thường và dấu tiếng Việt.
  - Mỗi meaning có `meaningId`, `learnedAt`, `nextReviewAt` và `meaning: {partOfSpeech, text, ipa?, definition, audio?, examples}`, cùng dữ liệu với learn card (đã áp bản sửa của user). `audio` vắng khi không phát được.
  - `meaningCount`: tổng số meaning của từ mà user thấy được (cùng phạm vi với `GET /v1/words/{wordId}`), để hiện "1 / 4 nghĩa đã học". `meanings` chỉ gồm nghĩa đã học.
  - Không có trạng thái kỹ năng: endpoint này không đọc skill evidence.
- `GET /v1/me/words/stats` → `{learnedWords, needPracticeWords}`: số liệu toàn thư viện, không phụ thuộc trang hay `q`.
- `GET /v1/words/{wordId}`: chi tiết một từ, gọi khi user mở từ đó. Có mọi meaning của từ, kể cả chưa học (`learnedAt = null`).
  - Mỗi meaning có thêm `skills: {reading, writing, listening?, speaking?}` và `needsPractice` (bật khi có kỹ năng cần luyện).
  - Mỗi kỹ năng là `{status: "not_verified"|"demonstrated"|"verified", needsPractice, issue: "failed"|"assisted"|null}`. Dùng `skills` để biết kỹ năng nào của nghĩa này đang có vấn đề. Một kỹ năng có thể vừa `verified` vừa có `issue: "assisted"`.
    - `failed`: trả lời sai hoặc show answer, kể cả khi có hint; đã mất `verified`.
    - `assisted`: đúng nhờ hint, hoặc recall đúng ở lần 2; vẫn giữ `verified`.
    - `issue` tắt sau một lần tự trả lời đúng của kỹ năng đó, cách lần có vấn đề ít nhất 12h.
  - `listening/speaking` vắng mặt khi Meaning không có phát âm.
  - `needsPractice` và `fullyVerified` ở cấp Word.

## 5. Plan một session

`POST /v1/sessions/plan`

```jsonc
{
  "mode": "daily" | "checkpoint_challenge" | "random_practice" | "weak_words_practice",
  "capabilities": { "audioPlayback": true, "microphone": true },
  "challengeId": "uuid",  // chỉ cho checkpoint_challenge, tuỳ chọn, mặc định thử thách cũ nhất còn available
  "skills": ["listening", "reading"]   // chỉ cho random_practice, tuỳ chọn; 1–4 kỹ năng, không trùng
  // "skill": "listening"              // dạng cũ một kỹ năng, vẫn nhận; không gửi kèm "skills"
}
```

| Mode | Nội dung |
|---|---|
| `daily` | Ôn các Meaning đến hạn (tối đa 10) rồi học từ mới (tối đa `dailyNewWordGoal` mỗi session, plan lại được ngay sau khi session trước hoàn tất; mỗi session bắt đầu bằng phần ôn). Duy nhất mode này có từ mới và cập nhật lịch ôn |
| `checkpoint_challenge` | **Deprecated.** Ôn lại các Meaning của một challenge cũ còn `available`, chỉ dạng nhớ lại (typing/flyReorder, không có select-recognition) |
| `random_practice` | Từ các Meaning đã học, tối đa 10 từ. Không gửi `skills` là practice tổng hợp; gửi `skills` là practice theo kỹ năng |
| `weak_words_practice` | Các nghĩa có kỹ năng đang có `issue` trong 30 ngày qua, luyện đúng kỹ năng đó; sau đó đến các từ hay sai/dùng hint (cần tối thiểu 3 lần thử). Tối đa 10 task |

`capabilities` là cam kết của client: `audioPlayback=false` thì không có task nào có `prompt.type = "audio"`. `microphone=false` thì task `recording` **vẫn được phát hành**, client gửi event `unavailable` (xem 7.7).

**Practice theo kỹ năng:** mỗi từ đúng một task, mọi task đều luyện một trong các kỹ năng đã chọn. Chọn nhiều kỹ năng thì các kỹ năng chia lượt đều giữa các từ; từ không luyện được kỹ năng tới lượt (vd. không có audio cho `listening`) dùng kỹ năng khác đã chọn. Commit như session thường.

| `skill` | Task có thể nhận |
|---|---|
| `reading` | `select` gloss (text), `reverse_gloss`; `cloze_select` và `select/meaning_clash` nếu có nội dung Curated |
| `writing` | `typing/meaning_recall`, `fly_reorder/spelling_recall`; `surgery` nếu có nội dung Curated |
| `listening` | `select/gloss` (audio), `typing/transcription`; `phonetic_choice`, `stress_choice` nếu có nội dung Curated. Chỉ dùng từ có audio |
| `speaking` | `recording` |

Kỹ năng thiết bị không luyện được bị bỏ: `speaking` với `microphone=false`, `listening` với `audioPlayback=false`. Trả plan rỗng (`sessionId: null`) khi không còn kỹ năng nào, hoặc chưa có từ đã học phù hợp (nhiều từ catalog chưa có audio). Gửi `skills`/`skill` với mode khác `random_practice`, `skills` rỗng hoặc trùng, hay gửi cả hai trường nhận `400`.

Response:

```jsonc
{
  "sessionId": "uuid", "mode": "daily", "expiresAt": "...",   // TTL 72 giờ
  "steps": [
    { "type": "learn",    "id": "uuid", "card": { ... } },
    { "type": "practice", "phase": "new_practice", "task": { "id": "uuid", "template": "...", ... } }
  ]
}
```

- **Plan rỗng** (không có gì để học/ôn): `{sessionId: null, mode, steps: []}`. Hiện empty state, không có session để commit.
- `checkpoint_challenge` mà không có thử thách nào: `404 NOT_FOUND`.
- `steps` đã sắp xếp đúng thứ tự, **render theo thứ tự này**, không sắp xếp lại.
- `phase` của practice: `due_review | new_practice | checkpoint_challenge | random_practice | weak_words_practice`. Dùng để hiển thị nhãn, không ảnh hưởng gì đến gửi kết quả.
- Mỗi lần gọi plan là tạo session mới. Session cũ chưa commit bị bỏ rơi (không ghi gì). Muốn tiếp tục dở dang thì lưu `sessionId` + tiến độ cục bộ và dùng lại trong 72 giờ.

### 5.1 Learn step

```jsonc
{ "type": "learn", "id": "...", "card": {
  "wordId": "01a0...", "meaningId": "01a1...", "word": "clarify", "partOfSpeech": "verb", "meaning": "làm rõ", "definition": "...", "ipa": "/ˈklærɪfaɪ/",
  "audio": { "url": "https://...", "locale": "en-US" },   // có thể vắng
  "examples": [{ "text": "...", "translation": "..." }]
} }
```

Hiển thị thẻ, người dùng bấm tiếp tục. Chỉ cần ghi nhớ `id` để đưa vào `learnStepsCompleted` khi commit. `ipa` và `audio` có thể vắng.

`wordId` dùng để gọi `GET /v1/words/{wordId}` khi cần hiện các nghĩa khác của từ (chỉ để tham khảo, không thuộc session); `meaningId` là nghĩa của thẻ này, dùng để loại nó ra khỏi danh sách đó. Plan tạo trước khi có hai field này thì không có chúng.

### 5.2 Thứ tự từ mới (mode daily)

Từ mới được chia thành nhóm 2-3 Meaning (tối đa `introBatchSize` = 3). Mỗi nhóm gồm các `learn` card liên tiếp, rồi mới đến 5 vòng practice, **xen kẽ** giữa các Meaning trong nhóm; nhóm sau bắt đầu khi nhóm trước xong:

1. `select/gloss` (sau khi cả nhóm đã có `learn` card)
2. `select/reverseGloss`
3. Recall: `typing/meaningRecall` hoặc `flyReorder/spellingRecall` (task này là "first recall", **bắt buộc có ít nhất một lần submit**)
4. `recording/scriptedPronunciation`
5. `select/gloss` lần nữa

Task ôn tập (due review) đứng trước phần từ mới.

Từ user tự thêm (mục 11) luôn được xếp trước các từ từ topic đã chọn.

## 6. Cấu trúc chung của Task

```jsonc
{
  "id": "uuid",
  "template": "select",            // quyết định UI
  "variant": "gloss",              // quyết định ý nghĩa/nhãn, cùng template có thể khác variant
  "prompt":   { "type": "text", "text": "clarify" }
            | { "type": "audio", "audio": { "url": "https://...", "locale": "en-US" } },
  "question": "Từ này có nghĩa là gì?",   // đã localize; có thể vắng
  "...": "phần riêng theo template (xem mục 7)",
  "evaluation": { ... }            // đáp án để chấm ngay tại máy
}
```

- **Prompt** là phần "đề": text thì hiển thị chữ; audio thì hiển thị nút phát. Một task chỉ có **một** kiểu prompt. Không tự đổi audio thành text.
- **Audio mù** (nghe để chọn nghĩa, chép chính tả): URL và `question` không chứa đáp án. Không hiển thị bất kỳ thứ gì có thể lộ từ đích.
- **`evaluation` là bí mật tương đối**: dùng để phản hồi tức thì (đúng/sai, tô màu). Không log, không hiển thị đáp án cho đến khi người dùng đúng hoặc reveal.
- Task không có `wordId/meaningId`; client không cần và không được suy ra.
- **Template → UI** (UI do client quyết định theo `template`; `variant` chỉ để biết ngữ nghĩa):

| template | variants | Nguồn | `evaluation` |
|---|---|---|---|
| `select` | `gloss`, `reverse_gloss` | Generated | `{correctOptionId}` |
| `select` | `meaning_clash`, `phonetic_choice`, `stress_choice` | Curated | `{correctOptionId}` |
| `typing` | `meaning_recall`, `transcription` | Generated (có thể Curated) | `{acceptedResponses[]}` |
| `fly_reorder` | `spelling_recall` (`transcription` nếu Curated) | Generated (có thể Curated) | `{acceptedResponses[]}` |
| `match` | `meaning_pairs` (`word_pairs` nếu Curated) | Generated (có thể Curated) | `{correctPairs[]}` |
| `recording` | `scripted_pronunciation` | Generated | `{acceptedResponses: [text cần đọc]}` (đúng 1 phần tử) |
| `cloze_select` | `single_blank`, `context_meaning` | Curated only | `{correctOptionId}` |
| `surgery` | `fix_spelling` | Curated only | `{wrongGraphemeIndex, replacement}` |

Curated cần tác giả soạn trước, nên có thể chưa xuất hiện trong bản dev ban đầu. Client vẫn phải hỗ trợ tất cả 7 template. Gặp `template` hoặc `variant` lạ thì coi là lỗi nghiêm trọng của client (không nên bỏ qua task, vì commit yêu cầu có kết quả cho **mọi** task).

## 7. Chi tiết từng template

Mọi event có `seq` là số nguyên dương, **tăng ngặt** trong mỗi task (1, 2, 3, ...). Mỗi task cần ít nhất một event kết thúc (`submit`, `reveal`, hoặc event đặc thù của template).

Quy tắc chung của events trong một task:

- Sau một `submit` **đúng** thì không được có thêm event nào.
- Cho phép thử lại sau `submit` sai, tối đa theo `maxRetries` của task: tổng số lần thử là 1 + `maxRetries`. Hết lượt thì client tự chuyển câu, không gửi event riêng. Task kết thúc ở submit sai vẫn hợp lệ, kết quả là `incorrect`. Gửi submit vượt giới hạn làm cả commit fail với `422`. `match` tính riêng cho từng item bên trái, `recording` tính theo số receipt kể cả audio invalid. Session cũ không có field này thì không giới hạn.
- `hint`: ghi lại mỗi lần người dùng dùng gợi ý. Nội dung gợi ý do client tự định nghĩa (backend không cung cấp). Gợi ý làm giảm giá trị bằng chứng, nên bắt buộc gửi event nếu có dùng.
- `reveal`: người dùng chọn xem đáp án / bỏ cuộc. Kết quả là `revealed`.
- Kết quả suy ra: đúng ngay lần đầu và không reveal → `correct`; đúng sau khi thử lại → `corrected_after_retry`; có reveal → `revealed`; còn lại → `incorrect`.

### 7.1 `select`, `cloze_select`: chọn một đáp án

```jsonc
{ "template": "select", "variant": "gloss",
  "prompt": { "type": "text", "text": "clarify" },
  "question": "Từ này có nghĩa là gì?",
  "options": [{ "id": 1, "text": "làm rõ" }, { "id": 2, "text": "..." }, ...],   // 2 đến 4 lựa chọn
  "evaluation": { "correctOptionId": 1 } }
```

- `gloss`: prompt là từ tiếng Anh (text) hoặc phát âm của nó (audio), chọn nghĩa. `reverse_gloss`: prompt là nghĩa, chọn từ tiếng Anh.
- `meaning_clash`, `phonetic_choice` (nghe chọn từ), `stress_choice` (chọn âm tiết nhấn): cùng payload và cùng cách chấm với `select`.
- `prompt` dạng text có thể kèm `highlight: {start, end}`, là vị trí từ cần đánh dấu trong `text` (offset UTF-16, `end` không tính). `meaning_clash` dùng field này cho từ mà câu hỏi nhắc tới; client không tự tìm từ trong câu.
- Option id là số của backend (thường 1..n), **không phải** vị trí hiển thị. Giữ nguyên thứ tự `options` như backend đã xáo.
- `cloze_select` thêm `sentenceParts: {before, after}`. Render `before` + ô trống + `after`, chọn option điền vào chỗ trống. `prompt` là tuỳ chọn và chỉ có khi có gợi ý thật (bản dịch, audio); câu nằm ở `sentenceParts`, không có ký tự ô trống nào trong dữ liệu.

Events: `{seq, action:"submit", optionId}` (optionId phải nằm trong `options`).

```jsonc
[{ "seq": 1, "action": "submit", "optionId": 3 }, { "seq": 2, "action": "submit", "optionId": 1 }]  // sai rồi đúng
```

### 7.2 `typing`: gõ từ

```jsonc
{ "template": "typing", "variant": "meaning_recall",
  "prompt": { "type": "text", "text": "làm rõ" },
  "question": "Write the English word for this meaning:",
  "evaluation": { "acceptedResponses": ["clarify"] } }
```

- `meaning_recall`: prompt là nghĩa, gõ từ tiếng Anh. `transcription`: prompt là audio (nghe và chép).
- So khớp: Unicode NFC, trim, gộp khoảng trắng liên tiếp thành một, **không phân biệt hoa thường**. Client phải dùng đúng quy tắc này để phản hồi khớp với backend: `value.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase()`. Có thể có nhiều đáp án chấp nhận.
- Dấu câu, dấu thanh không bị bỏ. `cafe` ≠ `café`.

Events: `{seq, action:"submit", value:"clarify"}` (`value` tối đa 200 ký tự).

### 7.3 `fly_reorder`: xếp chữ

```jsonc
{ "template": "fly_reorder", "variant": "spelling_recall",
  "prompt": { "type": "text", "text": "làm rõ" },
  "question": "Arrange the letters to form the English word:",
  "tiles": [{ "id": 1, "text": "r" }, { "id": 2, "text": "c" }, ...],   // đã xáo; mỗi tile là một grapheme
  "evaluation": { "acceptedResponses": ["clarify"] } }
```

- Các tile là kết quả cắt theo **grapheme cluster** (không phải UTF-16). Chữ lặp lại là tile khác nhau, mỗi tile có id riêng.
- Backend **phát lại** các thao tác để dựng trạng thái, nên phải gửi đủ từng bước:
  - `{action:"tap_tile", tileId}`: đưa tile từ kho vào dãy (cuối dãy). Tile chưa nằm trong dãy.
  - `{action:"remove_tile", tileId}`: bỏ tile khỏi dãy (đưa về kho). Tile phải đang trong dãy.
  - `{action:"move_tile", tileId, toIndex}`: đổi vị trí trong dãy, `toIndex` < độ dài dãy hiện tại.
  - `{action:"submit", tileIds:[...]}`: **`tileIds` phải đúng bằng thứ tự dãy hiện tại** theo replay, nếu lệch thì cả commit bị `422 INVALID_SUBMISSION`. Luôn lấy `tileIds` từ state thật của UI.
- `seq` tăng liên tục qua cả tap/remove/move/submit.

```jsonc
[{seq:1,action:"tap_tile",tileId:2},{seq:2,action:"tap_tile",tileId:1},{seq:3,action:"remove_tile",tileId:1},
 {seq:4,action:"tap_tile",tileId:3},{seq:5,action:"submit",tileIds:[2,3]}]
```

### 7.4 `match`: nối cặp

```jsonc
{ "template": "match", "variant": "meaning_pairs",
  "prompt": { "type": "text", "text": "Match the pairs." },
  "pairs": { "left": [{ "id": 1, "text": "clarify" }, ...], "right": [{ "id": 5, "text": "làm rõ" }, ...] },
  "evaluation": { "correctPairs": [{ "leftId": 1, "rightId": 5 }, ...] } }
```

- Id trái và phải khác nhau (không trùng). Giữ thứ tự mà backend đã xáo.
- Mỗi lần người dùng nối một cặp (đúng hay sai) gửi `{action:"pair", leftId, rightId}`. Cặp đã nối đúng không được gửi lại.
- Task chỉ kết thúc hợp lệ khi **tất cả** cặp trái đã được nối đúng, hoặc có `reveal`. Nếu người dùng thoát sớm, task vẫn phải gửi `reveal` (hoặc bạn cho phép thoát session thì không commit).
- Kết quả được tính riêng cho từng cặp (mỗi cặp ứng với một Meaning).
- `match` chỉ xuất hiện ở các mode luyện tập (random/weak), không có trong daily và checkpoint. Weak không có `match` khi đang luyện theo `issue`.

### 7.5 `surgery`: sửa lỗi chính tả (Curated)

```jsonc
{ "template": "surgery", "variant": "fix_spelling",
  "prompt": { ... }, "question": "...",
  "word": "clarrify",
  "evaluation": { "wrongGraphemeIndex": 4, "replacement": "" } }
```

- Hiển thị `word`, người dùng sửa **một hoặc nhiều** ký tự (thay hoặc xóa) rồi bấm kiểm tra. `replacement` rỗng nghĩa là xóa ký tự đó.
- `graphemeIndex` đếm theo grapheme cluster của chuỗi đã NFC, bắt đầu từ 0, trên `word` gốc (không dịch theo các ký tự đã xóa).
- Event: `{seq, action:"submit", edits: [{graphemeIndex: 4, replacement: ""}, ...]}`: 1–64 edits, mỗi `graphemeIndex` xuất hiện một lần và nhỏ hơn số grapheme của `word`, `replacement` tối đa 32 ký tự. Gửi `edits` thì không gửi kèm `graphemeIndex`/`replacement`.
- Dạng cũ `{seq, action:"submit", graphemeIndex: 4, replacement: ""}` vẫn được nhận, tương đương một edit.
- Chấm đúng khi từ sau khi áp các edit khớp với từ đúng (so khớp như typing). Vì vậy cách sửa khác nhưng ra cùng từ vẫn đúng (xóa `r` nào trong `clarrify` cũng được), còn sửa thêm ký tự không cần sửa thì sai.

### 7.6 `cloze_select`

Xem 7.1.

### 7.7 `recording`: đọc to (chấm phát âm)

```jsonc
{ "template": "recording", "variant": "scripted_pronunciation",
  "prompt": { "type": "text", "text": "clarify" },      // hoặc audio: nghe mẫu rồi đọc lại
  "question": "Read this word aloud.",
  "assessment": { "kind": "azurePronunciation" },
  "evaluation": { "acceptedResponses": ["clarify"] } }   // text cần đọc, dùng để chấm on-device
```

Client chọn một trong hai cách chấm **cho mỗi task** (không trộn trong cùng một task):

- **Backend (Azure)**: flow bên dưới, commit `assessed`.
- **On-device**: client tự speech-to-text rồi so với `evaluation.acceptedResponses[0]` để phản hồi ngay, không gọi `recording-assess`. Mỗi lần đọc là một event `{seq, action:"transcribed", transcript}` (`transcript` tối đa 200 ký tự, chuỗi rỗng nếu không nhận ra gì). Tổng số event `transcribed` ≤ 1 + `maxRetries`. Khi commit, backend chấm lại **lần cuối**: chuẩn hoá (bỏ dấu, chữ thường, bỏ dấu câu), chỉ có đúng hoặc sai và không có điểm (`accuracyScore` là `null`): đúng khi khớp 100% `referenceText`, client chỉ xét kết quả nhận dạng đầu tiên; transcript rỗng là `invalid`. Kết quả được tính như bằng chứng Speaking từ Azure (cùng luật direct/supporting).

Flow chấm bằng backend:

Flow:

1. Người dùng đọc, client ghi âm.
2. `POST /v1/sessions/{sessionId}/recording-assess`, `multipart/form-data`:
   - field `taskId` (text, id của task)
   - field `audio` (file, tối đa **2 MB**). Nên dùng WAV PCM 16 kHz mono (phù hợp Azure Speech REST); `Content-Type` của phần file được chuyển nguyên cho Azure.
3. Response `200`:

```jsonc
{ "assessmentReceiptId": "uuid", "validity": "valid" | "invalid", "passed": true | false | null, "accuracyScore": 87.5 | null }
```

   - Điểm đạt: `accuracyScore >= 80` (`passed`). `validity: "invalid"` nghĩa là không đánh giá được (im lặng, nhiễu, không nhận ra giọng) và `passed = null`: cho phép đọc lại, không phải là fail.
   - Nên hiển thị kết quả ngay. Được gọi assess nhiều lần (đọc lại), mỗi lần ra một receipt riêng.
4. Event kết thúc, **đúng một event** trong `events` của task này (trừ khi chấm on-device, xem trên):
   - `{seq:1, action:"assessed", assessmentReceiptId}`: dùng receipt của lần đánh giá cuối cùng người dùng chấp nhận. Receipt thuộc đúng task đó, còn hạn (72 giờ), chưa dùng.
   - `{seq:1, action:"unavailable", reason:"micPermissionDenied"}`: dùng khi không ghi âm được (không có quyền mic, `microphone=false`, thiết bị lỗi, hoặc `503 SPEECH_PROVIDER_UNAVAILABLE`). `reason` tối đa 64 ký tự. Task này không bị tính là sai kỹ năng nói.
   - Nếu `prompt.type = "audio"` phải gửi `deliveryMode` (xem mục 8).
5. Audio không được lưu ở server. `503 SPEECH_PROVIDER_UNAVAILABLE` là retryable: cho thử lại, nếu vẫn lỗi thì gửi `unavailable`.

Lỗi của assess: `422 INVALID_SUBMISSION` (thiếu audio, task không phải recording, sai body), `403 SESSION_NOT_OWNED`, `409 SESSION_STALE` (session đã commit), `410 SESSION_EXPIRED`, `404`, `413 PAYLOAD_TOO_LARGE`.

## 8. Commit

`POST /v1/sessions/{sessionId}/commit`

```jsonc
{
  "learnStepsCompleted": ["<learn step id>", ...],
  "taskResults": [
    { "taskId": "uuid", "deliveryMode": "audio", "events": [ { "seq": 1, "action": "submit", "optionId": 2 } ] }
  ]
}
```

Quy tắc, vi phạm là `422 INVALID_SUBMISSION` và **cả commit bị từ chối**:

- Phải có kết quả cho **mọi** task đã phát hành (mỗi `taskId` đúng một lần) và mọi learn step phải có trong `learnStepsCompleted`. Không commit từng phần, không commit session đang làm dở.
- Mỗi task có tối đa 200 events, một commit tối đa 500 task.
- `events` của mỗi task phải tuân theo quy tắc từng template ở mục 7.
- **Task "first recall"** (task recall trong vòng học từ mới) phải có ít nhất một lần `submit`.
- **`deliveryMode`**: bắt buộc khi `prompt.type = "audio"`, giá trị `audio | fallback | none`. Chỉ `audio` được tính là audio đã đến tai người dùng (bằng chứng Listening/Speaking trực tiếp). Gửi `audio` khi đã phát được; `fallback` hoặc `none` khi không phát được (thiết bị lỗi, tải thất bại). Gửi đúng sự thật, đừng luôn gửi `audio`. Với prompt text: bỏ trống hoặc `none`. Gửi `audio`/`fallback` cho prompt text là lỗi.

Response `200`:

```jsonc
{ "sessionId": "...", "status": "committed", "committedAt": "...",
  "summary": { "newWordGoalSlots": 5, "reviewedMeanings": 8, "practiceTasks": 30 } }
```

Session `checkpoint_challenge` có thêm `summary.checkpoint: {reviewedCount, unaidedRecalledCount, needsReviewCount}`. Chỉ trả lời tự nhớ (không hint, không phải chọn đáp án) mới tính vào `unaidedRecalledCount`. Không có ngưỡng đạt: làm xong là challenge hoàn thành.

**Idempotent:** commit lại cùng một body (giống từng byte sau khi chuẩn hoá JSON) trả về đúng response cũ. Vì vậy khi mất mạng hoặc không chắc đã commit, **retry nguyên body** an toàn. Body khác cho session đã commit → `409 SESSION_PAYLOAD_CONFLICT`.

`GET /v1/sessions/{sessionId}/commit-status` → `{sessionId, status: "issued"|"committed"|"expired", committedAt, expiresAt, response}`. Gọi khi không chắc commit trước đó đã thành công.

Sau commit: gọi lại `learn-home` để làm mới Home. Kết quả chi tiết từng task không được trả về trong response commit; dùng `GET /v1/words/{wordId}` để xem trạng thái kỹ năng.

Bỏ session giữa chừng: không gọi gì. Không có kết quả nào được ghi, các từ mới vẫn còn "chưa học".

## 9. Lỗi

Mọi lỗi có dạng `{code, message, retryable, requestId}`, một số lỗi có thêm `details` (xem mục 12.7). Gửi `requestId` khi báo lỗi.

| HTTP | code | Xử lý ở client |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Lỗi body/input, hiển thị `message` hoặc sửa client |
| 401 | `UNAUTHORIZED` | Refresh token một lần; thất bại thì về màn đăng nhập |
| 403 | `FORBIDDEN` | Không đủ quyền |
| 403 | `SESSION_NOT_OWNED` | Session không phải của user. Bỏ session |
| 404 | `NOT_FOUND` | Không có dữ liệu (ví dụ không có checkpoint challenge) |
| 409 | `EMAIL_ALREADY_REGISTERED` | Gợi ý đăng nhập |
| 409 | `SESSION_PAYLOAD_CONFLICT` | Session đã commit với dữ liệu khác. Gọi `commit-status`, đồng bộ trạng thái |
| 409 | `SESSION_STALE` | Session đã commit, hoặc một Meaning đã được học ở session khác. Bỏ session, plan lại |
| 410 | `SESSION_EXPIRED` | Quá 72 giờ. Bỏ session, plan lại |
| 413 | `PAYLOAD_TOO_LARGE` | Audio vượt 2 MB |
| 422 | `INVALID_SUBMISSION` | Events không hợp lệ hoặc thiếu kết quả, là lỗi của client. Kiểm tra mục 7 và 8 |
| 422 | `TASK_DATA_INVALID` | Dữ liệu task lỗi phía server. Báo lỗi, cho bỏ session |
| 503 | `SPEECH_PROVIDER_UNAVAILABLE`, `AUTH_PROVIDER_UNAVAILABLE` | `retryable: true`, retry với backoff |
| 500 | `INTERNAL_ERROR` | `retryable: true` |

Với `retryable: true`, retry có backoff. Riêng commit retry nguyên body.

## 10. Checklist triển khai

1. Auth: Keychain, refresh tự động, Google Sign-In (ID token + nonce).
2. Onboarding: levels → catalog → scope → settings; chặn plan khi chưa có scope.
3. Plan truyền đúng `capabilities` theo thực tế thiết bị (audio output, quyền mic).
4. Renderer theo `template` cho cả 7 template, đọc `prompt.type` để chọn text/audio.
5. Phản hồi tức thì bằng `evaluation`, dùng đúng quy tắc normalize (mục 7.2).
6. Ghi events: `seq` tăng ngặt theo task; flyReorder gửi đủ tap/remove/move và `submit.tileIds` khớp UI.
7. Recording: ghi âm, upload, dùng receipt cuối cùng; hoặc chấm on-device và gửi mỗi lần đọc là một `transcribed`; `unavailable` khi không ghi âm được.
8. `deliveryMode` cho mọi task có audio prompt.
9. Chỉ commit khi hoàn tất toàn bộ session, retry nguyên body khi lỗi mạng.
10. Lưu `sessionId` và tiến độ cục bộ nếu muốn tiếp tục dở dang trong 72 giờ.

## 11. Custom word: user tự thêm từ

User nhập một từ bất kỳ để đưa vào lộ trình học. Backend tìm trong toàn bộ kho từ trước. Có sẵn thì gắn vào lộ trình; chưa có thì AI tạo bản nháp, user xem trước, xác nhận thì từ vào kho chung và vào lộ trình của họ.

Điều client cần nhớ:

- Nội dung được tạo và dịch theo `explanationLocale` của user. Client không gửi locale.
- **Sửa nội dung chỉ có hiệu lực với chính user đó.** Người khác vẫn học bản gốc. Không sửa được từ gốc, IPA và CEFR.
- **Nghĩa tạo từ `context` chỉ thuộc riêng user đó**, cho tới khi admin duyệt phần nội dung AI. Sau khi duyệt, mọi người tra thấy nghĩa này. Bản sửa của user vẫn luôn là của riêng họ.
- Từ custom chạy qua đúng flow hiện có: sau khi thêm, nó tự xuất hiện trong `POST /sessions/plan`. Không có màn học riêng và không cần đổi renderer.
- Backend không yêu cầu scope để thêm từ.

### 11.1 Flow

```
User nhập từ
    │
    ▼
POST /custom-words/lookup { text }
    │
    ├─ result = "existing" ──► hiện các nghĩa, user chọn
    │       ├─ status = "available" ──────────► POST /custom-words { meaningId }
    │       ├─ status = "translation_draft" ──► POST /custom-words { draftId }
    │       ├─ status = "unavailable" ────────► hiện mờ, không cho chọn
    │       └─ "Không có nghĩa tôi cần" ──────► lookup lại với { text, context }
    │
    ├─ result = "draft" ─────────────► hiện tối đa 3 nghĩa, user chọn và sửa
    │                                  ──► POST /custom-words { draftId, senseIndex, edits? }
    │
    ├─ result = "new_meaning_draft" ─► như "draft", nhưng nghĩa chỉ thuộc riêng user này
    │
    └─ result = "invalid" ───────────► báo không phải từ hợp lệ
```

Lưu ý: nhập dạng biến thể như "ran" có thể trả về `existing` với `lemma` là "run". Hiện `lemma` trong response, không hiện text user gõ.

### 11.2 `POST /v1/custom-words/lookup`

Body:

| Field | Kiểu | Ràng buộc |
|---|---|---|
| `text` | string | Bắt buộc, 1 đến 64 ký tự. Chỉ chữ cái, dấu cách, `-`, `'`; phải bắt đầu bằng chữ cái |
| `context` | string | Tuỳ chọn, tối đa 200 ký tự. Mô tả nghĩa cần học; chỉ có tác dụng khi từ đã tồn tại. Nghĩa tạo ra chỉ thuộc riêng user này |

Trả `200`. Khi phải gọi AI, request có thể mất vài chục giây: đặt timeout client ít nhất **65 giây** và hiện trạng thái đang tải.

`result = "existing"`:

```json
{
  "result": "existing",
  "wordId": "01a1...",
  "lemma": "bank",
  "meanings": [
    {
      "meaningId": "01a1...",
      "status": "available",
      "partOfSpeech": "noun",
      "inRoadmap": false,
      "learned": false,
      "ipa": "/bæŋk/",
      "meaningText": "bờ sông",
      "definitionText": "Dải đất ven sông.",
      "examples": [
        { "text": "We sat on the bank.", "translation": "Chúng tôi ngồi trên bờ sông.", "targetLocator": { "start": 14, "end": 18 } }
      ]
    },
    {
      "meaningId": "01a2...",
      "status": "translation_draft",
      "partOfSpeech": "verb",
      "inRoadmap": false,
      "learned": false,
      "draftId": "01a3...",
      "ipa": "/bæŋk/",
      "meaningText": "nghiêng",
      "definitionText": "Nghiêng sang một bên khi rẽ.",
      "examples": [
        { "text": "The plane began to bank.", "translation": "Máy bay bắt đầu nghiêng.", "targetLocator": { "start": 19, "end": 23 } }
      ]
    },
    { "meaningId": "01a4...", "status": "unavailable", "partOfSpeech": "noun", "inRoadmap": false, "learned": false }
  ]
}
```

| `status` | Ý nghĩa | Cách thêm |
|---|---|---|
| `available` | Đã có bằng ngôn ngữ của user | `{ meaningId }` |
| `translation_draft` | Có sẵn nhưng chưa có ngôn ngữ của user; AI vừa dịch để xem trước | `{ draftId }` từ chính phần tử đó |
| `unavailable` | Admin đã gỡ hoặc đang biên tập. Không có `meaningText`, `definitionText`, `examples` | Không thêm được |

`ipa` là phiên âm en-US, có thể vắng (luôn vắng với `unavailable`).

Nếu `inRoadmap = true`, hiện "Đã có trong lộ trình" thay cho nút thêm.

`learned = true` khi user đã học nghĩa này (có tiến độ ôn tập), dù từ lộ trình riêng hay chủ đề chung. Thêm lại nghĩa đã học không có tác dụng, nên hiện "Đã học" thay cho nút thêm.

Với `available` và `translation_draft`, user sửa được trước khi thêm: gửi kèm `edits` khi gọi `POST /custom-words` (mục 11.3).

`result = "draft"` hoặc `"new_meaning_draft"`:

```json
{
  "result": "draft",
  "draftId": "01a5...",
  "lemma": "serendipity",
  "senses": [
    {
      "partOfSpeech": "noun",
      "ipa": "/ˌserənˈdɪpəti/",
      "cefrLevel": "C1",
      "popularity": 35,
      "meaningText": "sự tình cờ may mắn",
      "definitionText": "Việc tìm thấy điều tốt đẹp một cách tình cờ.",
      "examples": [
        {
          "text": "Meeting her was pure serendipity.",
          "translation": "Gặp cô ấy hoàn toàn là một sự tình cờ may mắn.",
          "targetLocator": { "start": 21, "end": 32 }
        }
      ]
    }
  ]
}
```

`targetLocator` là vị trí từ cần highlight trong `text` (`start` tính từ 0, `end` không bao gồm). Bản nháp chưa có audio; audio được tạo khi xác nhận.

`result = "invalid"`: chỉ có `{ "result": "invalid" }`.

### 11.3 Thêm vào lộ trình: `POST /v1/custom-words`

Gửi đúng một trong hai dạng:

```json
{ "meaningId": "01a1...", "edits": { "meaningText": "bờ sông, bờ hồ" } }
```

```json
{ "draftId": "01a5...", "senseIndex": 0, "edits": { "meaningText": "may mắn tình cờ" } }
```

- `senseIndex` mặc định `0`, là vị trí trong `senses`. Bỏ qua với `translation_draft`.
- `edits` tuỳ chọn. Chỉ gửi khi user thật sự sửa; schema ở mục 11.5.
- Không gửi lại nội dung nháp. Backend đọc từ bản đã lưu và từ chối field lạ bằng `400`.

Trả `201`:

```json
{ "meaningId": "01a1...", "added": true }
```

`added = false` nghĩa là từ đã có trong lộ trình, vẫn coi là thành công. Gọi lại an toàn, không tạo trùng. Nếu tạo audio thất bại, từ vẫn được thêm; backend tự bổ sung sau, và khi đó learn step dùng text như trường hợp không có audio.

### 11.4 Danh sách và xoá

`GET /v1/custom-words` trả toàn bộ lộ trình riêng, mới nhất trước, không phân trang (tối đa 500 từ):

```json
{
  "words": [
    {
      "meaningId": "01a1...",
      "wordId": "01a0...",
      "lemma": "serendipity",
      "partOfSpeech": "noun",
      "meaningText": "may mắn tình cờ",
      "definitionText": "Việc tìm thấy điều tốt đẹp một cách tình cờ.",
      "examples": [
        { "text": "Meeting her was pure serendipity.", "translation": "Gặp cô ấy hoàn toàn là một sự tình cờ may mắn.", "targetLocator": { "start": 21, "end": 32 } }
      ],
      "ipa": "/ˌserənˈdipəti/",
      "audioUrl": "https://...mp3",
      "overridden": true,
      "translationPending": false,
      "recalled": false
    }
  ]
}
```

| Field | Xử lý trên UI |
|---|---|
| `meaningText`, `definitionText`, `examples` | Đã áp bản sửa của user. `null` khi `translationPending` hoặc `recalled` |
| `ipa` | `null` khi `translationPending` hoặc `recalled` |
| `audioUrl` | Có thể `null`: ẩn nút phát |
| `overridden` | `true`: hiện nút "Khôi phục bản gốc" |
| `translationPending` | `true` sau khi user đổi `explanationLocale`: hiện "Đang dịch". Từ tạm không vào session, backend tự dịch dần, có thể mất tới vài chục phút |
| `recalled` | `true`: admin đã gỡ. Hiện "Không còn khả dụng", chỉ cho xoá |

`DELETE /v1/custom-words/{meaningId}` trả `200 { meaningId, removed: true }`, hoặc `404` nếu từ không có trong lộ trình. Từ không còn được lên lịch ôn, bản sửa riêng bị xoá. Lịch sử học được giữ nguyên, và từ vẫn có thể xuất hiện trong mode `random`.

### 11.5 Sửa nội dung riêng

`PUT /v1/custom-words/{meaningId}/override` trả `200 { meaningId, overridden: true }`. Cùng schema với `edits`. Backend **gộp theo field**: field không gửi giữ nguyên bản sửa trước, nên sửa nghĩa không làm mất ví dụ đã sửa. `POST /custom-words` kèm `edits` cũng gộp như vậy.

```json
{
  "meaningText": "may mắn tình cờ",
  "definitionText": "Định nghĩa theo cách của tôi.",
  "examples": [
    { "text": "What a serendipity!", "translation": "Thật may mắn!", "targetLocator": { "start": 7, "end": 18 } }
  ]
}
```

- Cả ba field đều tuỳ chọn, nhưng phải có ít nhất một. Field chưa từng sửa dùng theo bản gốc. Muốn bỏ một field đã sửa thì không có cách riêng: `DELETE .../override` khôi phục cả ba.
- `meaningText`, `definitionText`, `text`, `translation`: 1 đến 500 ký tự.
- `examples`: 1 đến 3 phần tử, thay toàn bộ danh sách ví dụ. Khi user chỉ sửa một ví dụ, gửi cả danh sách lấy từ `GET /custom-words`.
- `targetLocator` chỉ cần nằm trong `text`, **không bắt buộc khớp đúng từ gốc**. Câu dùng dạng biến thể ("ran" với từ "run") vẫn hợp lệ: nếu client không tự tìm được vị trí, cho user chọn đoạn cần highlight trong câu, rồi gửi `start`, `end` của đoạn đó.
- `404` nếu từ không có trong lộ trình.

`DELETE /v1/custom-words/{meaningId}/override` trả `200 { meaningId, overridden: false }`. Bản sửa áp dụng cho session tạo sau đó; session đang chạy giữ nội dung cũ. Bản sửa gắn với ngôn ngữ hiện tại, nên đổi `explanationLocale` thì user sẽ thấy bản gốc của ngôn ngữ mới.

### 11.6 Lỗi

Theo định dạng ở mục 9.

| HTTP | `code` | Khi nào | Client xử lý |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | Text sai định dạng, field lạ, `targetLocator` sai | Sửa lỗi nhập |
| 409 | `WORD_ALREADY_EXISTS` | Bản nháp đã cũ vì từ vừa được thêm từ nguồn khác | Tự gọi lại lookup |
| 422 | `CUSTOM_WORD_INVALID` | `draftId` không tồn tại, thuộc ngôn ngữ khác, hoặc sai `senseIndex` | Tự gọi lại lookup |
| 422 | `CUSTOM_WORD_UNAVAILABLE` | Nghĩa đã bị gỡ hoặc chưa có ở ngôn ngữ này | Gọi lại lookup để cập nhật trạng thái |
| 429 | `CUSTOM_WORD_LIMIT_REACHED` | Hết 30 lần tạo bằng AI trong ngày (UTC), lộ trình đủ 500 từ, hoặc từ đã đủ 8 nghĩa | Hiện thông báo chung. Không tự retry |
| 503 | `LEXICAL_PROVIDER_UNAVAILABLE` | AI lỗi hoặc chưa cấu hình; `retryable: true` | Cho user thử lại |

Từ đã có sẵn hoặc bản nháp đã lưu không tính vào hạn mức 30 lần.

Các số trên là giá trị thử nghiệm và có thể đổi. Không hardcode ở client.

### 11.7 Checklist

1. Màn thêm từ: ô nhập, kiểm tra độ dài và ký tự ở client, trạng thái tải dài cho lookup.
2. Xử lý đủ 4 giá trị `result` và 3 giá trị `status`, kèm `inRoadmap`.
3. Nút "Không có nghĩa tôi cần" để lookup lại với `context`. Nói rõ nghĩa này chỉ dành cho riêng user.
4. Xem trước bản nháp: chọn nghĩa, sửa, highlight theo `targetLocator`. Nói rõ phần sửa chỉ áp dụng cho riêng user.
5. Nhãn cho biết nội dung do AI tạo.
6. Màn "Từ của tôi": danh sách, xoá, sửa, khôi phục bản gốc, các trạng thái `translationPending` và `recalled`.
7. `409` và `422 CUSTOM_WORD_INVALID`: tự lookup lại, không báo lỗi cho user.
8. Sau khi thêm từ, làm mới `GET /me/learn-home`.

## 12. Challenge Map (Match Madness)

Màn chơi tuỳ chọn, tách hẳn khỏi Daily. Chỉ dùng từ **đã học** trong Daily. Không bao giờ chặn từ mới, không đổi lịch ôn (SRS), không tính bằng chứng kỹ năng: thắng hay thua đều không ảnh hưởng `dueCount`, `nextReviewAt` hay `skills`. Mọi con số dưới đây là giá trị thử nghiệm (`POLICY.challenge`), đọc từ response, không hardcode.

- **Chapter** = 12 nghĩa mới ("core") + tối đa 3 nghĩa ôn lại từ các chapter trước (chapter 1 không có). Mỗi chapter có 3 level, chơi liền nhau được, không cần quay về Daily.
- Một nghĩa chỉ làm core cho đúng một chapter. Trong một chapter, không có 2 thẻ trùng chữ tiếng Anh hoặc trùng nghĩa hiển thị (so sánh không phân biệt hoa thường/khoảng trắng). Vì vậy học 12 từ nhưng có thể chỉ đủ 11 nghĩa hợp lệ.
- Chapter được tạo (đóng băng nội dung) khi user **bắt đầu run đầu tiên** của nó, theo `explanationLocale` lúc đó. Đổi ngôn ngữ sau đó không đổi chapter cũ (`explanationLocale` trong response cho biết ngôn ngữ của chapter).
- Chỉ chapter/level sớm nhất chưa qua là mở. Level đã qua chơi lại được; sao và điểm cao nhất chỉ tăng, không bao giờ giảm.

```
GET /me/challenge-map ──► currentNode
        │
POST /challenge/chapters/{c}/levels/{l}/runs ──► plan (status issued, 15 phút để start)
        │
POST /challenge/runs/{id}/start ──► startedAt (bắt đầu đếm 90 s SAU response này)
        │   client chơi, chấm tại máy, ghi events
POST /challenge/runs/{id}/commit ──► result, unlock, nextAction
```

### 12.1 `GET /v1/me/challenge-map`

Chỉ đọc, không tạo gì.

```jsonc
{ "configVersion": "match-madness-trial-v1", "gameMode": "match_madness",
  "chapters": [
    { "id": "...", "chapterNo": 1, "state": "active", "titleKey": "challenge.chapter.1", "explanationLocale": "vi-VN",
      "coreMeaningCount": 12, "reviewMeaningCount": 0, "starsEarned": 2, "maxStars": 9,
      "levels": [
        { "levelNo": 1, "state": "cleared", "bestStars": 2, "bestScore": 1020,
          "goalMatches": 8, "visiblePairs": 3, "timeLimitMs": 90000,
          "starCriteria": { "two": { "maxElapsedMs": 80000, "maxMistakes": 2 }, "three": { "maxElapsedMs": 60000, "maxMistakes": 0 } } },
        { "levelNo": 2, "state": "available", "bestStars": 0, "bestScore": 0, "goalMatches": 12, ... },
        { "levelNo": 3, "state": "locked", "bestStars": 0, "bestScore": 0, "goalMatches": 16, ... } ] } ],
  "nextChapter": { "chapterNo": 2, "state": "locked", "eligibleNewCount": 5, "requiredNewCount": 12 },
  "currentNode": { "chapterNo": 1, "levelNo": 2 } }
```

- `chapters[].state`: `active` (đang chơi), `completed` (level 3 có ≥ 1 sao), `content_unavailable` (một số từ đã bị gỡ và không còn từ đã học nào thay thế được: hướng user về Daily).
- `levels[].state`: `locked | available | cleared` (cleared = có ≥ 1 sao).
- `levels[]` có sẵn mục tiêu của level (`goalMatches`, `visiblePairs`, `timeLimitMs`, `starCriteria`) theo policy hiện tại, để sheet của level hiện trước khi tạo run. Run đã tạo thì dùng số trong plan (12.2).
- `nextChapter.state`: `locked` (chapter hiện tại chưa qua), `needs_vocabulary` (hiện `eligibleNewCount / requiredNewCount`, CTA về Daily), `ready` (bấm vào là tạo chapter khi start run).
- Chưa có chapter nào: `chapters: []`, `nextChapter.chapterNo = 1`.
- `currentNode`: node cần focus, `null` khi không có gì chơi được.

### 12.2 Tạo run: `POST /v1/challenge/chapters/{chapterNo}/levels/{levelNo}/runs`

Body `{}`. Response `201`:

```jsonc
{ "runId": "...", "status": "issued", "gameMode": "match_madness", "chapterNo": 1, "levelNo": 2,
  "policyVersion": "match-madness-trial-v1", "contentVersion": 1, "explanationLocale": "vi-VN",
  "goalMatches": 12, "visiblePairs": 4, "timeLimitMs": 90000, "minMatchesBetweenRepeats": 3,
  "starCriteria": { "two": { "maxElapsedMs": 80000, "maxMistakes": 3 }, "three": { "maxElapsedMs": 60000, "maxMistakes": 1 } },
  "score": { "match": 100, "streakStep": 10, "maxStreakSteps": 5, "mistake": 20, "perSecondLeft": 5 },
  "boardSeed": "9f2c...", "expiresAt": "2026-11-10T14:45:00.000Z",
  "pairs": [ { "pairId": "...", "wordTileId": "...", "meaningTileId": "...", "word": "reimburse", "meaning": "hoàn trả chi phí" } ] }
```

- `pairs` có đúng `goalMatches` phần tử, theo **thứ tự hàng đợi**. Level 3 có 16 lượt từ 12–15 nghĩa: một nghĩa có thể xuất hiện 2 lần, mỗi lần một `pairId`/tile id riêng, cùng `word`/`meaning`.
- Mỗi user chỉ có **một** run đang mở (issued hoặc started). Tạo run khi đã có run mở → `409 CHALLENGE_RUN_ACTIVE` với `details.runId`: cho user tiếp tục (`status`) hoặc bỏ (`quit`).
- Run `issued` hết hạn sau 15 phút nếu chưa start.
- 1 sao = qua màn trong 90 s. 2 và 3 sao cần cả điều kiện thời gian và số lần sai của `starCriteria`. Không hardcode ngưỡng.

### 12.3 Luật bàn chơi (client phải làm giống hệt server)

Server chấm lại bằng đúng các luật này, nên client lệch luật sẽ bị `422`.

1. **Thẻ đang hiện:** ban đầu lấy từ hàng đợi tối đa `visiblePairs` cặp. Sau mỗi cặp **đúng**: bỏ cặp đó khỏi bàn, rồi lấp chỗ trống bằng cặp **đầu tiên còn trong hàng đợi** thoả cả hai điều kiện: (a) nghĩa của nó không đang hiện trên bàn, (b) nghĩa đó chưa được nối đúng trong `minMatchesBetweenRepeats` lần nối đúng gần nhất. Cặp không thoả thì giữ nguyên vị trí trong hàng đợi. Nếu không cặp nào thoả và bàn trống thì lấy cặp đầu hàng đợi. "Cùng nghĩa" = cùng `word` (một chapter không có 2 nghĩa trùng `word`).
2. **Thứ tự cột** (tính lại lúc đầu và sau mỗi cặp đúng; sai thì không đổi): với mỗi tile đang hiện, `h = lowercase hex SHA256(UTF8(boardSeed + "|" + correctCount + "|" + side + "|" + tileId))`, `side` là `word` hoặc `meaning`; xếp tăng dần theo `h` (trùng thì theo `tileId`). Hai cột xếp độc lập. Test vector (seed `00112233445566778899aabbccddeeff`, tileId `018f0000-0000-7000-8000-000000000001`, count 0, side `word`) → `a1eedcdd4a2b5f8ffd4f2133437cc340a0fcb76214ccc2dd789dbc2aac1a8158`. Có thể animate ≤ 200 ms; reduce-motion thì đổi ngay.
3. **Nối:** chạm một thẻ word + một thẻ meaning, thứ tự nào cũng được; chạm thẻ khác cùng cột thì đổi lựa chọn. Đúng khi cả hai thẻ cùng `pairId`. Sai: hai thẻ vẫn ở lại, combo về 0. Không có hint, check hay reveal.
4. **Điểm** (chỉ để vui, không dùng mở khoá), theo `score` của plan: mỗi cặp đúng `match + streakStep × min(combo, maxStreakSteps)` với combo tính cả cặp vừa nối; mỗi lần sai `−mistake`; qua màn cộng `perSecondLeft × floor((timeLimitMs − elapsedMs) / 1000)`; tổng không âm (chỉ kẹp ở cuối, không kẹp từng bước). Luật điểm đóng băng trong plan lúc tạo run. Client hiện điểm tạm thời; điểm chính thức là `result.score` sau commit.

### 12.4 Start, commit, quit, status

- `POST /v1/challenge/runs/{runId}/start` body `{}` → `200 {runId, status: "started", startedAt, timeLimitMs}`. Gọi lại trả đúng `startedAt` cũ. Chỉ bắt đầu đếm giờ **sau** khi có response. Từ lúc start có 15 phút để commit (kể cả retry).
- `POST /v1/challenge/runs/{runId}/commit`:
  ```jsonc
  { "events": [
      { "seq": 1, "type": "match", "elapsedMs": 1840, "wordTileId": "...", "meaningTileId": "..." },
      { "seq": 2, "type": "match", "elapsedMs": 3020, "wordTileId": "...", "meaningTileId": "..." } ],
    "endedReason": "quit", "endedElapsedMs": 3020 }
  ```
  - Mỗi lần nối (đúng hoặc sai) là một event. `seq` liên tiếp từ 1. `elapsedMs` = thời gian monotonic từ lúc nhận response start, số nguyên, tăng ngặt, ≤ 90000. Tối đa 200 events.
  - `goal_reached`: event cuối là cặp đúng thứ `goalMatches`, `endedElapsedMs` = `elapsedMs` của event đó. `time_up`: chưa đủ, `endedElapsedMs = 90000`. `quit`: chưa đủ, `lastEvent.elapsedMs ≤ endedElapsedMs < 90000`.
  - Đồng hồ không dừng khi app vào background: quay lại mà quá hạn thì commit `time_up`.
  - Response `200`:
    ```jsonc
    { "runId": "...", "status": "committed",
      "result": { "outcome": "cleared", "starsThisRun": 2, "bestStars": 2, "correctMatches": 12, "mistakes": 1,
                  "longestCombo": 8, "elapsedMs": 68600, "score": 1685, "bestScore": 1685 },
      "unlock": { "kind": "level", "chapterNo": 1, "levelNo": 3 }, "nextAction": "play_next_level" }
    ```
  - `outcome`: `cleared | failed | quit`. `failed`/`quit` luôn 0 sao.
  - `unlock.kind`: `level` (qua level lần đầu, mở level sau), `chapter_ready` (qua level 3 lần đầu và đã đủ từ cho chapter sau), `needs_vocabulary` (qua level 3 nhưng thiếu từ; có `eligibleNewCount`, `requiredNewCount`), `none` (chơi lại, thua hoặc bỏ).
  - `nextAction`: `play_next_level | open_map | learn_more | retry`.
  - **Idempotent:** retry nguyên body trả đúng response cũ. Body khác → `409 CHALLENGE_COMMIT_CONFLICT`.
- `POST /v1/challenge/runs/{runId}/quit` body `{}`: dùng khi **mất events** (crash, đổi máy). Run `issued` → `{runId, status: "abandoned"}`, không tính lượt chơi. Run `started` → kết thúc với 0 sao, trả `{runId, status: "committed", response}` (cùng dạng response commit). Còn events thì nên commit với `endedReason: "quit"`. Gọi lại trả trạng thái cuối.
- `GET /v1/challenge/runs/{runId}/status` → `{runId, status, chapterNo, levelNo, startedAt, expiresAt, response, run}`. `status`: `issued | started | committed | abandoned | expired`. `response` là response commit khi đã commit. `run` là plan (cùng dạng 12.2) khi run còn mở, để khôi phục sau khi app bị tắt.

### 12.5 Nội dung thay đổi

- Từ bị admin gỡ, hoặc từ riêng bị user xoá khỏi danh sách, không xuất hiện trong run tạo sau đó. Lần tạo run tiếp theo, backend thay đúng các ô đó bằng từ đã học sớm nhất còn hợp lệ, tăng `contentVersion`; sao và mở khoá giữ nguyên. Run đang chơi vẫn chơi hết được.
- Không đủ từ thay thế: map hiện `content_unavailable`, tạo run trả `409 CHALLENGE_CONTENT_UNAVAILABLE`. Học thêm trong Daily là mở lại.

### 12.6 Home

`learn-home` chưa có tóm tắt Challenge Map: gọi `GET /v1/me/challenge-map` (một request) và hiện `currentNode`, `starsEarned` hoặc tiến độ `nextChapter`.

### 12.7 Lỗi

| HTTP | `code` | Client xử lý |
|---|---|---|
| 403 | `CHALLENGE_LEVEL_LOCKED` | Level/chapter chưa mở. Về map |
| 404 | `CHALLENGE_RUN_NOT_FOUND` | Run không tồn tại hoặc của user khác. Về map |
| 409 | `CHALLENGE_RUN_ACTIVE` | Còn run đang mở, `details.runId`. Tiếp tục hoặc `quit` |
| 409 | `CHALLENGE_RUN_NOT_STARTED` | Commit khi chưa start. Gọi start |
| 409 | `CHALLENGE_COMMIT_CONFLICT` | Run đã kết thúc với body khác. Gọi `status`, không tạo lại body |
| 409 | `CHALLENGE_NOT_ENOUGH_VOCABULARY` | `details: {eligibleNewCount, requiredNewCount}`. CTA về Daily |
| 409 | `CHALLENGE_CONTENT_UNAVAILABLE` | Học thêm từ rồi thử lại |
| 410 | `CHALLENGE_RUN_EXPIRED` | Run hết hạn hoặc đã bỏ. Tạo run mới |
| 422 | `CHALLENGE_INVALID_EVENTS` | Events không khớp luật 12.3 hoặc `elapsedMs` dài hơn thời gian thực từ lúc start. Bỏ run, log `requestId` |

## 13. Hết từ mới, nợ ôn và "Tôi biết từ này"

Theo spec "Scope Completion & Review Load" v1.0. Mọi ngưỡng nằm trong `POLICY.reviewLoad` và đang là giá trị thử nghiệm.

### 13.1 Nguồn từ
- Scope (Collection + các Topic đã chọn) chỉ quyết định **từ mới**. Phần ôn của daily, Random "Tất cả" và Weak lấy mọi nghĩa đã học, trừ nghĩa chỉ thuộc Collection đang tạm dừng (§13.5).
- Đổi scope không đổi tiến trình. Nghĩa đã học ở chỗ khác không bị dạy lại.

### 13.2 `GET /v1/me/learn-home`: thêm hai khối
```jsonc
"scope": { "status": "ok | low | exhausted", "remainingNewMeanings": 14, "pendingCustomMeanings": 0, "sessionsLeftEstimate": 3,
           "topics": [{ "topicId": "...", "remainingNewMeanings": 0, "totalMeanings": 120 }] },
"reviewLoad": { "backlog": 34, "dueCap": 10, "effectiveNewPerSession": 2,
                "newWordReason": "goal | user_override | auto_balanced | checkpoint_gate | scope_limited | scope_exhausted",
                "override": { "value": 2, "mode": "until_date", "until": "2026-11-15T16:59:59.000Z" } /* hoặc null */,
                "autoBalance": false, "promptChoice": true }
```
- `dueCount` bằng `reviewLoad.backlog`: chỉ đếm nghĩa thuộc diện ôn.
- `low` nghĩa là còn ít hơn một chặng (`weeklySessionGoal` buổi). `sessionsLeftEstimate` chỉ là ước lượng, null khi không có từ mới mỗi buổi.
- `promptChoice: true` thì hiện màn Review Load Choice, nhưng **không** hiện giữa session và tối đa một lần mỗi lần mở app. Chọn bất kỳ lựa chọn nào thì gọi `POST /v1/me/review-load/ack {backlog}` (trả `{backlog}`), sau đó `promptChoice` thành false trên mọi thiết bị.
- `checkpoint_gate` được giữ chỗ và hiện không bao giờ xuất hiện.

### 13.3 Plan daily
- Body nhận thêm:
  - `reviewOnly: true`: chỉ ôn, không từ mới, không chiếm slot Journey;
  - `knownCheck: true` (§13.6).

  Gửi các trường này với mode khác daily thì trả 400.
- Response daily có thêm `newWords: {requested, issued, withheldReason}`, kể cả khi plan rỗng (`sessionId: null`).
  - `withheldReason` là `null | review_only | user_override | auto_balanced | scope_limited | scope_exhausted | checkpoint_gate`.
  - **Client chỉ tự plan tiếp daily khi `withheldReason == null`.** Mọi lý do khác thì đi thẳng tới màn kết quả.
- Step ôn (`phase: "due_review"`) có thêm `sourceTopic: {id, name}`, tên đã localize. Từ tự thêm có tên "Từ của bạn" / "Your words".
- Plan daily có thêm `reviewWords: [{wordId, meaningId, lemma, sourceTopic}]`, gồm đúng các từ plan này ôn, dùng cho màn "Ôn từ bạn đã học".

### 13.4 Commit
- Response có thêm `scopeEvents: {completedTopicIds, scopeExhausted, collectionCompleted}`. Trường này chỉ có giá trị ở commit làm số từ mới về 0. Retry trả đúng sự kiện cũ.
- `summary.knownMeanings` là số từ qua "Tôi biết từ này".

### 13.5 Settings, giảm tạm thời, tạm dừng ôn
- `PUT /v1/me/settings` nhận thêm `autoBalanceNewWords`. Đổi `dailyNewWordGoal` thì override bị hủy. `GET /v1/me` trả các cột mới trong `settings` và `reviewPauses: [{collectionId, pausedAt}]`.
- `PUT /v1/me/new-word-override {value, mode, until?}` trả `{override}`:
  - `value` từ 1 đến goal − 1, ngoài khoảng thì trả 400;
  - `mode` là `until_date` hoặc `until_backlog_clear`;
  - với `until_date`, thiếu `until` thì server đặt đến hết Chủ Nhật tuần này theo `timeZone`; `until` ở quá khứ thì trả 400.

  `DELETE /v1/me/new-word-override` để hủy. `until_backlog_clear` tự hết ở commit đầu tiên còn ≤ 10 từ chờ ôn.
- `PUT|DELETE /v1/me/review-pauses/{collectionId}`:
  - collection không tồn tại hoặc chưa publish: 404;
  - là active collection: `422 REVIEW_PAUSE_ACTIVE_COLLECTION`.

  Nghĩa thuộc cả Collection tạm dừng và active collection vẫn được ôn. Từ tự thêm không bao giờ bị tạm dừng.
- Random practice nhận `filter`: `{collectionId}`, `{topicIds: [...]}` (1–100) hoặc `{customOnly: true}`.
  - Collection hoặc Topic không tồn tại: 404. Mảng rỗng: 400.
  - Không có nghĩa nào khớp thì trả plan rỗng.
  - Lọc theo đúng Collection đang tạm dừng vẫn lấy được từ của nó.
- `GET /v1/catalog/collections`: mỗi Collection và Topic có thêm `learnedMeanings` và `totalMeanings`.
- `GET /v1/me/journey` và `GET /v1/me/challenge-map` có thêm `newWordsBlockedReason`: `scope_exhausted` hoặc null.

### 13.6 "Tôi biết từ này" (thử nghiệm, bật bằng `knownCheck: true`)
- Ngay trước mỗi Learn card có một task `typing` với `phase: "known_check"`. Learn step có thêm `knownCheckTaskId` và `skippableTaskIds`.
- Hỏi người dùng trước khi hiện card:
  - **Chọn "Học":** bỏ qua task check (không gửi kết quả), học như bình thường.
  - **Chọn "Tôi biết từ này":** hiện task check.
    - Đúng ngay lần đầu, không gợi ý: bỏ qua card và các task trong `skippableTaskIds`. Không cần gửi chúng, cũng không cần đưa learn step vào `learnStepsCompleted`. Từ được tính là đã học, lần ôn đầu sau 7 ngày.
    - Sai: hiện card và học như bình thường. Lần sai này không bị tính là quên.
- Task nối cặp (match) có cả từ khác vẫn phải làm. Server tự kiểm: check sai mà bỏ task thì trả `422 INVALID_SUBMISSION`.
