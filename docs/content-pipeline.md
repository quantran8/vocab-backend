# Content pipeline

Pipeline nạp nội dung học (từ, nghĩa, ví dụ, IPA, bản dịch, topic) vào DB. Dùng chung cho mọi collection.
Nguồn dữ liệu và phân công data/AI: `docs/content-sources.md`. Code: `src/content-pipeline/`.

Cách chạy từng bước: [`content/README.md`](../content/README.md).

**Phần AI do Claude Code làm**, không gọi API: `tasks` xuất việc ra file, Claude Code ghi `<id>.out.json`,
`ingest` kiểm tra theo schema và luật rồi mới lưu. Prompt và schema nằm trong `stages/generate.ts` và `stages/translate.ts`,
dùng chung cho `check` và `ingest`.

## Stage và file

| Stage | Đọc | Ghi | Commit? |
|---|---|---|---|
| `fetch` | URL trong `sources.ts` | `content/sources/*` + `manifest.json` (sha256, license) | Có: bản lưu nguồn, phòng URL gốc mất |
| `lexicon` | `content/sources` | `content/build/lexicon.json` | Không: dựng lại được |
| `tasks generate` / `review` / `rank` / `translate` | lexicon / generated | `content/build/<slug>/tasks/*.json` | Không |
| `ingest` | `tasks/*.out.json` | `generated.jsonl`, `reviews.jsonl`, `ranks.jsonl`, `translations/<locale>.jsonl`, `<locale>.catalog.json` | **Có**: kết quả AI |
| `load` | tất cả | DB, `load-report.json` | Không |

## Quy tắc

- **Cache và chạy tiếp:** `tasks generate` bỏ qua mục đã có cùng `promptVersion` hoặc đang nằm trong task chưa xong. Đổi prompt hoặc luật thì tăng
  `promptVersion` trong spec của collection. `--retry-issues` chỉ chạy lại các mục có lỗi luật, `--only key,key` chạy
  đúng các mục chỉ định, `--force` chạy lại tất cả.
- **Id ổn định:** id của meaning và ví dụ được tạo khi generate và lưu trong `generated.jsonl`. Khi chạy lại một mục,
  id được giữ theo WordNet sense đầu tiên, nên tiến độ học của user gắn với meaning vẫn đúng nghĩa.
- **Bản dịch gắn với nguồn:** mỗi bản dịch lưu `sourceHash` của phần tiếng Anh. Sửa tiếng Anh thì bản dịch cũ hết hiệu lực,
  và `tasks translate` chỉ xuất lại những meaning đó.
- **Chia nghĩa như từ điển cho người học** (Cambridge/Oxford Learner's): một nghĩa là một ý cốt lõi. Cùng ý cốt lõi thì gộp
  dù đối tượng khác nhau (take "cầm, nắm" gồm cầm tay, lấy sách; take "đem đi" gồm mang vật, dẫn người), bản dịch được ghi vài từ
  gần nghĩa. Tách khi ý cốt lõi khác nhau (get "nhận" / "mua"; year "năm" / "tuổi"). Mỗi meaning là một thẻ học, nên hai thẻ
  của cùng một từ phải phân biệt được. Gloss chứa ";" hoặc "/" bị `check` từ chối. Trần số nghĩa theo độ phổ biến (`maxMeanings`:
  5 cho 500 từ đầu NGSL, 3 cho phần còn lại).
- **Cụm từ không phải nghĩa của từ đơn:** phrasal verb và cụm cố định (look for, take off, used to, as well) để dành cho mục cụm từ
  riêng (`phrasal_verb`) ở đợt sau.
- **Trùng bản dịch** (`stages/clashes.ts`): hai nghĩa của cùng một từ có chung một từ tương đương tiếng Việt (bỏ phần trong ngoặc)
  thì người học không phân biệt được. Các nghĩa đó không được nạp, và mục được đưa về sinh lại kèm ghi chú để gộp hoặc bỏ.
- **Review độc lập** (`stages/review.ts`): một lượt AI khác soát từng từ (gộp mọi từ loại). Mục bị từ chối được sinh lại kèm
  ghi chú, tối đa `MAX_ATTEMPTS` lần; mục chưa review hoặc bị từ chối không được nạp.
- **Determiner:** app không có từ loại này; mục determiner của CEFR-J gộp vào pronoun của cùng từ ("more water", "some more").
- **Dạng từ theo từ loại** (`lexicon/inflect.ts`, `posForms`): NGSL gộp cả họ từ (time: timing; I: me, my), nên mỗi mục chỉ nhận
  dạng chia đúng từ loại của nó. Đại từ, giới từ, liên từ chỉ nhận chính từ đó: "me", "my", "whose" là mục riêng. Đầu vào có
  `alsoTaughtAs` để AI không viết nghĩa thuộc từ loại khác của cùng từ.
- **Sense WordNet:** nghĩa nên map về sense WordNet, nhưng nghĩa phổ biến mà WordNet thiếu ("there is", look "tìm", take "quan điểm")
  được thêm với `senses: []`. Reviewer chịu trách nhiệm bắt nghĩa bịa.
- **Popularity** (`stages/rank.ts`): planner dạy nghĩa có `popularity` cao nhất của mỗi từ trước (gộp mọi từ loại), nên điểm
  được tính theo từ, không theo cặp (từ, từ loại). AI cho điểm 1–100 khi thấy mọi nghĩa của từ cùng số đếm SemCor. Code chỉ chặn
  việc xếp ngược bằng chứng mạnh giữa hai từ loại (gấp ≥5 lần và ≥50 lần xuất hiện; SemCor nhỏ nên dưới 50 là bằng chứng yếu); trong cùng từ loại, SemCor không đủ tin
  (gộp sense, "used to" đếm 0) nên không ép. Thứ hạng NGSL chỉ dùng để sắp thứ tự trong topic.
- **Kiểm tra bằng code** (`rules.ts`): target của ví dụ phải là một dạng của từ, từ trong ví dụ không vượt level (cho
  lệch 2 từ), level không thấp hơn level nền và không vượt `maxLevel`, IPA hợp lệ và lấy từ CMUdict, sense có thật.
  Meaning lỗi luật **không được nạp**; xem bằng `report --verbose`, sửa bằng `tasks generate --retry-issues`.
- **Đủ mọi ngôn ngữ app hỗ trợ:** `APP_LOCALES` (constants) là danh sách duy nhất. Một task dịch trả về mọi locale còn
  thiếu của các meaning trong task; meaning thiếu bất kỳ locale nào thì không được nạp. Topic không còn meaning nào được chuyển về `draft`.
- **Nạp:** một transaction, ghi theo lô. Gắn vào từ đã có cùng lemma (seed hoặc custom word) thay vì tạo trùng. Meaning
  có `origin = curated`, nên không lọt vào hàng chờ duyệt AI hay worker tự sinh audio. Pronunciation chỉ ghi IPA, không
  đụng audio. Thứ tự trong topic: level, rồi thứ hạng NGSL, rồi `popularity`; `topic_meanings` của collection được ghi lại toàn bộ.
- **Publish:** `--publish` duyệt bản dịch và publish qua cùng hàm `toMeaningSnapshot` mà API admin dùng. Chạy lại
  không tạo revision nếu snapshot không đổi. Không có `--publish` thì bản dịch ở trạng thái `draft` để admin duyệt.
- **Từ đồng tự:** không dùng `homograph_key`; IPA gắn theo meaning (lead /liːd/ và /led/), AI chọn trong các cách đọc
  của CMUdict, có cách đọc theo homograph của OEWN làm gợi ý.

## Chưa làm

- IPA UK (Britfone) mới có trong lexicon, chưa nạp: cần chuẩn hoá ký hiệu (ɹ, ɛ, vị trí dấu trọng âm) và app chưa chọn giọng.
- Audio: bạn tự sinh; pipeline không ghi `audio_asset_key`.
- Item curated (`cloze_select`…): đợt 1.5, dùng `confusables` và ví dụ có sẵn (`docs/content-sources.md` §6).
