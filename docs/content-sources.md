# Nguồn nội dung từ vựng

Nguồn dữ liệu cho nội dung học (tiếng Anh), phần nào lấy từ data, phần nào do AI làm, collection nào làm trước,
và thứ tự làm curated template. App phát hành công khai nên mọi nguồn phải **dùng thương mại được**.

## 1. Nguồn dữ liệu

| Nguồn | Dùng cho | License |
|---|---|---|
| CEFR-J Wordlist (Tono Lab, TUFS) | Lemma, từ loại, CEFR A1–B2 | Free cả thương mại, phải ghi nguồn |
| Octanove Vocabulary Profile | CEFR C1–C2 | CC BY-SA 4.0 |
| NGSL 1.2, NAWL, TSL, BSL | Tập từ lõi, thứ hạng dạy, collection theo mục tiêu | CC BY-SA 4.0 (đã xác nhận trên trang NGSL 1.2) |
| Open English WordNet 2025 | Danh sách nghĩa theo thứ tự phổ biến, lexname, cách đọc của từ đồng tự | CC BY 4.0 |
| Princeton WordNet 3.0 (`index.sense`) | Số đếm SemCor theo nghĩa, để xếp nghĩa phổ biến trước | WordNet 3.0 license (kiểu BSD) |
| CMUdict | IPA US (đổi từ ARPAbet), trọng âm | Kiểu BSD |
| Britfone | IPA UK, trọng âm | MIT |
| wordfreq | Tần suất bổ trợ cho từ ngoài NGSL, chỉ tính nội bộ | Data CC BY-SA 4.0 |

Cần đọc lại văn bản gốc trước khi phát hành: điều khoản trên cefr-j.org (hiện mới xác nhận qua README của
`openlanguageprofiles/olp-en-cefrj`). Bản tải về và license từng nguồn nằm trong `content/sources/manifest.json`.

**Không dùng:** Oxford 3000/5000, English Vocabulary Profile (Cambridge), COCA, Longman, Collins, list chính thức
của các kỳ thi riêng từng nước (Eiken, GEPT, 수능), và mọi repo scrape lại các nguồn này. CEFRLex/EFLLex nghi là
license phi thương mại, chưa dùng.

**ShareAlike:** dữ liệu CC BY-SA (OVP, NGSL, wordfreq) nếu gửi nguyên văn xuống app thì phần đó phải giữ CC BY-SA.
Lấy A1–B2 từ CEFR-J, chỉ dùng OVP cho C1–C2, và dùng thứ hạng NGSL/wordfreq để sắp xếp nội bộ.

**Wiktionary/Kaikki, Tatoeba:** chỉ dùng tham khảo khi gen. Wiktionary vướng CC BY-SA kèm GFDL; câu Tatoeba không
gắn với nghĩa cụ thể nên không khớp được `target_locator` đúng sense.

App phải có trang ghi nguồn: CEFR-J, Octanove, NGSL project, Open English WordNet, Princeton WordNet 3.0, CMUdict, Britfone.

## 2. Hai lớp dữ liệu

| Lớp | Phạm vi | Nơi lưu |
|---|---|---|
| **Kho tra cứu**: lemma, từ loại, CEFR, thứ hạng NGSL, synset, IPA, trọng âm, cặp từ dễ nhầm | Toàn bộ, chỉ từ data, không AI, không dịch | Staging, **không** ghi vào `words`/`meanings` |
| **Nội dung học**: nghĩa, định nghĩa, ví dụ, bản dịch, audio | Chỉ collection đã chốt (§4) | `words` → `meanings` → `topic_meanings` |

AI gen và dịch rất tốn, vì mỗi nghĩa và mỗi câu ví dụ nhân 11 ngôn ngữ (xem `LOCALIZATION_MARKETS.md` của app iOS).
Chỗ nghẽn thật là người bản ngữ duyệt, nên chỉ gen cho collection đã chốt. Kho tra cứu thì import đủ, để mở collection
mới không phải nhập lại và để code có dữ liệu kiểm tra đầu ra AI (§5).

## 3. Phân công theo bảng

| Bảng / trường | Làm bằng | Quy tắc |
|---|---|---|
| `words.lemma`, `language` | Data | Hợp nhất CEFR-J, OVP và NGSL. Dò khóa unique `lower(btrim(lemma))` trước khi ghi |
| `words.homograph_key` | Không dùng | Từ đồng tự phân biệt bằng IPA theo meaning |
| `word_types.part_of_speech` | Data | CEFR-J/OVP. Determiner gộp vào pronoun (app không có từ loại determiner). NGSL gộp mọi từ loại nên không dùng để tách từ loại |
| Danh sách `meanings` | Data làm khung, AI chọn, AI khác review | Synset OEWN → chia như từ điển cho người học (một ý cốt lõi một nghĩa); hai nghĩa của một từ không được trùng bản dịch; tối đa 5 (từ cốt lõi) hoặc 3 nghĩa |
| `meanings.popularity` | AI cho điểm, data kiểm tra | Xếp theo từ (gộp từ loại); số đếm SemCor là bằng chứng và chặn việc xếp ngược rõ ràng giữa hai từ loại |
| `meanings.cefr_level` | Data làm nền, AI chỉnh | Nghĩa phổ biến nhất lấy level của cặp (từ, từ loại). Nghĩa phụ do AI gán, **không thấp hơn level nền** |
| `meanings.core_definition` | AI | Tiếng Anh đơn giản, không chép nguyên gloss WordNet |
| `meaning_localizations` | AI | |
| `pronunciations.ipa` | Data | CMUdict (đổi sang IPA). AI chỉ chọn cách đọc nào trong CMUdict ứng với nghĩa nào ở từ đồng tự (*read*, *lead*) |
| `pronunciations.audio_asset_key` | TTS | |
| `meaning_examples.source_text` | AI | Đúng nghĩa, đúng level, theo spec câu ví dụ (§6) |
| `meaning_examples.target_locator` | Code | Tìm vị trí từ đích trong câu, kể cả dạng chia. Không lấy offset do AI trả |
| `example_localizations` | AI | |
| `collections` | Data | §4 |
| `topics` + localizations | Người chốt danh sách, AI xếp meaning vào topic | Danh sách topic nằm trong spec của collection |
| `topic_meanings.curated_rank` | Data | Level, rồi thứ hạng NGSL, rồi `popularity` |
| `practice_items` (curated) | AI sinh, người duyệt | §6 |

## 4. Collection

Chốt danh sách collection trước rồi mới gen. Mỗi user học một collection (`user_learning_scope`), nên collection là
mục tiêu học chọn theo thị trường, không suy ngược từ kho từ.

| Đợt | Collection | Nguồn | Quy mô | Thị trường chính |
|---|---|---|---|---|
| 1 | Essential English (A1→B2, topic theo chủ đề) | NGSL ∩ CEFR-J | ~2.8k từ | Tất cả |
| 2 | TOEIC | TSL | ~1.2k từ | JP, KR, TW, VN, TH, ID |
| 2 | Business English | BSL | ~1.7k từ | IN, MX, BR, SA, ES |
| 3 | Academic | NAWL | ~960 từ | IN, VN, SA, KR |
| 3 | Advanced C1–C2 | OVP | tuỳ chọn | JP, KR |

TSL, BSL, NAWL loại sẵn các từ đã có trong NGSL, nên giả định người học biết từ cơ bản. Nghĩa NGSL mang nghĩa riêng
trong ngữ cảnh chuyên đề (*bill* = hoá đơn) có thể thêm vào topic của collection đó.

## 5. Kiểm tra đầu ra AI bằng code

- Câu ví dụ chứa lemma hoặc dạng chia của nó và tìm được `target_locator`.
- Các từ còn lại trong câu ví dụ nằm trong CEFR-J ở level ≤ level của nghĩa (cho lệch 1–2 từ).
- `cefr_level` của nghĩa phụ không thấp hơn level nền.
- IPA chỉ chứa ký tự IPA hợp lệ, và khớp CMUdict/Britfone khi từ có trong nguồn.
- Mỗi nghĩa AI giữ lại map được về một synset gốc.

Bản ghi không qua kiểm tra giữ ở `editorial_state = draft` để người duyệt.

## 6. Curated template

Template curated (`cloze_select`, `surgery`, `select` biến thể `meaning_clash`/`phonetic_choice`/`stress_choice`)
**làm sau** nội dung đợt 1:

- App vẫn chạy đủ với template generated; curated chỉ xuất hiện khi có item đã duyệt (`DECISIONS.md`, "Generated vs curated").
- Curated không quyết định độ nhớ: `cloze_select` có trọng số 0.4, `surgery` là `weak_template`.
- `practice_item_targets` trỏ tới meaning. Soạn khi nghĩa còn đổi sẽ phải tạo bản thay thế (`supersedes_item_id`).

Ba việc phải làm ngay trong đợt 1 để khỏi làm lại:

1. **Spec câu ví dụ:** ngữ cảnh đủ để **chỉ** từ đích điền vừa, có `context_cefr_level`. Khi đó `meaning_examples` dùng lại được làm nguồn `cloze_select`.
2. **Giữ trọng âm** (dấu 0/1/2 của CMUdict, Britfone) trong kho tra cứu, cho `phonetic_choice`/`stress_choice`.
3. **Tính sẵn cặp từ dễ nhầm** trong kho tra cứu (khoảng cách chỉnh sửa, đồng âm theo CMUdict, synset gần nhau), cho `meaning_clash`/`surgery`.

Thứ tự:

1. Đợt 1: kho tra cứu → Essential với template generated → chạy thử ở một thị trường.
2. Đợt 1.5, khi nghĩa của Essential đã publish ổn định: AI sinh item curated từ dữ liệu đã có, người duyệt. Làm `cloze_select` trước (template curated duy nhất có memory signal).
3. Đợt 2 trở đi: gen nghĩa và item curated trong cùng một đợt cho mỗi collection mới.

## 7. Locale nội dung

Backend lưu nội dung theo đúng `uiLocale` (`vi-VN`, `hi-IN`…), không theo mã ngôn ngữ. Danh sách là `APP_LOCALES`
trong `src/common/constants/domain.ts`, khớp với 11 ngôn ngữ của app iOS. **Nội dung phải có đủ mọi locale**: meaning thiếu
một locale thì không được nạp. Tiếng Anh (`en-US`) lấy thẳng từ nguồn. Mexico và Tây Ban Nha dùng chung `es-MX` (tiếng Tây Ban Nha
trung tính).

Chưa xong ở backend: `practice-resolver/locale-copy.ts` mới có text hệ thống cho `vi-VN` và `en-US`, nên
`PUT /v1/me/settings` từ chối các `uiLocale` khác. Cần thêm file text cho 9 locale còn lại thì user ở các thị trường đó mới dùng được.

Cách chạy pipeline: `content/README.md`.
