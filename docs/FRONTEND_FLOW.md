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
        │      PUT /me/levels → GET /catalog/collections → PUT /me/scope (+ PUT /me/settings)
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
| `POST /v1/auth/refresh` | `{refreshToken}` | `200 session` |

```jsonc
// session
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 3600, "user": { "id": "<supabase user id>", "email": "a@b.com" } }
```

- Password 8–72 ký tự. Email được backend trim và lowercase.
- **Signup:** nếu project bật xác nhận email, response là `{session: null, confirmationRequired: true}`. Hiện màn "kiểm tra email", sau khi xác nhận thì gọi `login`.
- **Google:** dùng Google Sign-In SDK trên iOS lấy ID token, gửi `idToken`. Nếu SDK yêu cầu nonce, gửi nonce **gốc** (chưa hash) vào `nonce`. Không có redirect OAuth.
- **Lưu token:** Keychain. Refresh token dùng một lần, mỗi lần refresh nhận cặp token mới và phải thay cả hai.
- **Refresh:** gọi khi `expiresIn` sắp hết, hoặc khi bất kỳ request nào nhận `401 UNAUTHORIZED`: refresh một lần rồi retry request gốc một lần. Nếu refresh cũng `401` thì đăng xuất.
- Lỗi: `401 UNAUTHORIZED` (sai thông tin/token hỏng), `409 EMAIL_ALREADY_REGISTERED`, `400 VALIDATION_FAILED`, `503 AUTH_PROVIDER_UNAVAILABLE` (retryable).

## 3. Onboarding và cài đặt

`GET /v1/me` trả hồ sơ:

```jsonc
{
  "id": "...", "proficiencyLevel": "B1" | null,
  "settings": { "explanationLocale": "vi-VN", "uiLocale": "vi-VN", "timeZone": "...", "dailyNewWordGoal": 5, "...": "..." },
  "scope": { "collectionId": "...", "topicIds": ["..."] } | null
}
```

User mới: `proficiencyLevel` và `scope` là `null` thì đi onboarding. Chưa có scope thì không có Meaning nào để học, plan trả về rỗng. `settings` còn có thêm vài trường nội bộ (`learningLanguage`, `updatedAt`), client bỏ qua được.

| Bước | Request |
|---|---|
| Chọn level | `PUT /v1/me/levels` `{proficiencyLevel: "A1".."C2"}`; level chỉ dùng để sắp xếp từ mới (từ ≥ level trước), không loại từ nào |
| Danh sách nội dung | `GET /v1/catalog/collections` → `{collections:[{id,slug,title,description,topics:[{id,slug,title,description}]}]}`, đã localize theo `uiLocale` |
| Chọn phạm vi học | `PUT /v1/me/scope` `{collectionId, topicIds:[1..100]}`. Topic phải published và thuộc collection, nếu không thì `400` |
| Cài đặt | `PUT /v1/me/settings` (strict, ít nhất 1 trường): `explanationLocale`, `uiLocale` (`en-US` hoặc `vi-VN`), `timeZone` (IANA, ví dụ `Asia/Ho_Chi_Minh`), `dailyNewWordGoal` (1–30) |

- `explanationLocale` quyết định ngôn ngữ của nghĩa, câu hỏi và nội dung trong task. Đổi locale ảnh hưởng đến session sau đó, không ảnh hưởng session đã plan.
- `dailyNewWordGoal` là số từ mới **mỗi session** daily, không phải mỗi ngày: hoàn tất một session thì luôn có thể plan session tiếp theo.

## 4. Màn hình Home và tiến độ

- `GET /v1/me/learn-home` → `{dueCount, checkpointAvailable, checkpointSessionsDone, checkpointSessionsRequired, learnedTotal}`. Một request cho cả Home. Tiến độ tới challenge kế tiếp = `checkpointSessionsDone / checkpointSessionsRequired`; chỉ session có học từ mới mới được đếm, và số này về 0 khi challenge mở.
- `GET /v1/me/checkpoint-challenges` → `{challenges:[{id, sequence, state:"available", createdAt, meaningCount}]}`. Mở một challenge sau mỗi 7 session có học từ mới, nên có thể nhiều challenge trong một ngày.
- `GET /v1/me/words?limit=50&offset=0` (limit 1–100) và `GET /v1/words/{wordId}`: từ đã học, trạng thái 4 kỹ năng.
  - Mỗi meaning có `skills: {reading, writing, listening?, speaking?}`, mỗi kỹ năng là `{status: "not_verified"|"demonstrated"|"verified", needsPractice}`.
  - `listening/speaking` vắng mặt khi Meaning không có phát âm.
  - `fullyVerified` ở cấp Word.

## 5. Plan một session

`POST /v1/sessions/plan`

```jsonc
{
  "mode": "daily" | "checkpoint_challenge" | "random_practice" | "weak_words_practice",
  "capabilities": { "audioPlayback": true, "microphone": true },
  "challengeId": "uuid"   // chỉ cho checkpoint_challenge, tuỳ chọn, mặc định thử thách cũ nhất còn available
}
```

| Mode | Nội dung |
|---|---|
| `daily` | Ôn các Meaning đến hạn (tối đa 10) rồi học từ mới (tối đa `dailyNewWordGoal` mỗi session, plan lại được ngay sau khi session trước hoàn tất; mỗi session bắt đầu bằng phần ôn). Duy nhất mode này có từ mới và cập nhật lịch ôn |
| `checkpoint_challenge` | Ôn lại các Meaning đã học trong 7 session đó, chỉ dạng nhớ lại (typing/flyReorder, không có select-recognition) |
| `random_practice` | Tối đa 10 task từ các Meaning đã học |
| `weak_words_practice` | Các từ hay sai/dùng hint trong 30 ngày qua (cần tối thiểu 3 lần thử), tối đa 10 task |

`capabilities` là cam kết của client: `audioPlayback=false` thì không có task nào có `prompt.type = "audio"`. `microphone=false` thì task `recording` **vẫn được phát hành**, client gửi event `unavailable` (xem 7.7).

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
  "word": "clarify", "meaning": "làm rõ", "definition": "...", "ipa": "/ˈklærɪfaɪ/",
  "audio": { "url": "https://...", "locale": "en-US" },   // có thể vắng
  "examples": [{ "text": "...", "translation": "..." }]
} }
```

Hiển thị thẻ, người dùng bấm tiếp tục. Chỉ cần ghi nhớ `id` để đưa vào `learnStepsCompleted` khi commit. `ipa` và `audio` có thể vắng.

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
  "evaluation": { ... }            // đáp án để chấm ngay tại máy; KHÔNG có ở recording
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
| `recording` | `scripted_pronunciation` | Generated | không có |
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
- `match` chỉ xuất hiện ở các mode luyện tập (random/weak), không có trong daily và checkpoint.

### 7.5 `surgery`: sửa lỗi chính tả (Curated)

```jsonc
{ "template": "surgery", "variant": "fix_spelling",
  "prompt": { ... }, "question": "...",
  "word": "clarrify",
  "evaluation": { "wrongGraphemeIndex": 4, "replacement": "" } }
```

- Hiển thị `word`, người dùng chọn **một** ký tự sai và nhập ký tự thay thế. `replacement` rỗng nghĩa là xóa ký tự đó.
- `graphemeIndex` đếm theo grapheme cluster của chuỗi đã NFC, bắt đầu từ 0.
- Event: `{seq, action:"submit", graphemeIndex: 4, replacement: ""}` (`replacement` tối đa 32 ký tự; nếu bỏ qua thì coi là rỗng).
- Chấm đúng khi đúng cả vị trí và ký tự thay (so khớp như typing).

### 7.6 `cloze_select`

Xem 7.1.

### 7.7 `recording`: đọc to (chấm phát âm)

```jsonc
{ "template": "recording", "variant": "scripted_pronunciation",
  "prompt": { "type": "text", "text": "clarify" },      // hoặc audio: nghe mẫu rồi đọc lại
  "question": "Read this word aloud.",
  "assessment": { "kind": "azurePronunciation" } }       // không có evaluation
```

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
4. Event kết thúc, **đúng một event** trong `events` của task này:
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

**Idempotent:** commit lại cùng một body (giống từng byte sau khi chuẩn hoá JSON) trả về đúng response cũ. Vì vậy khi mất mạng hoặc không chắc đã commit, **retry nguyên body** an toàn. Body khác cho session đã commit → `409 SESSION_PAYLOAD_CONFLICT`.

`GET /v1/sessions/{sessionId}/commit-status` → `{sessionId, status: "issued"|"committed"|"expired", committedAt, expiresAt, response}`. Gọi khi không chắc commit trước đó đã thành công.

Sau commit: gọi lại `learn-home` để làm mới Home. Kết quả chi tiết từng task không được trả về trong response commit; dùng `/me/words` để xem trạng thái kỹ năng.

Bỏ session giữa chừng: không gọi gì. Không có kết quả nào được ghi, các từ mới vẫn còn "chưa học".

## 9. Lỗi

Mọi lỗi có dạng `{code, message, retryable, requestId}`. Gửi `requestId` khi báo lỗi.

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
7. Recording: ghi âm, upload, dùng receipt cuối cùng; `unavailable` khi không ghi âm được.
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
      "draftId": "01a3...",
      "meaningText": "nghiêng",
      "definitionText": "Nghiêng sang một bên khi rẽ.",
      "examples": [
        { "text": "The plane began to bank.", "translation": "Máy bay bắt đầu nghiêng.", "targetLocator": { "start": 19, "end": 23 } }
      ]
    },
    { "meaningId": "01a4...", "status": "unavailable", "partOfSpeech": "noun", "inRoadmap": false }
  ]
}
```

| `status` | Ý nghĩa | Cách thêm |
|---|---|---|
| `available` | Đã có bằng ngôn ngữ của user | `{ meaningId }` |
| `translation_draft` | Có sẵn nhưng chưa có ngôn ngữ của user; AI vừa dịch để xem trước | `{ draftId }` từ chính phần tử đó |
| `unavailable` | Admin đã gỡ hoặc đang biên tập. Không có `meaningText`, `definitionText`, `examples` | Không thêm được |

Nếu `inRoadmap = true`, hiện "Đã có trong lộ trình" thay cho nút thêm.

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
