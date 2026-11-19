# Content pipeline: cách chạy

Pipeline nạp nội dung học (từ, nghĩa, ví dụ, IPA, bản dịch, topic) cho một collection vào DB.
Phần cần AI **do Claude Code làm**, qua task file. Pipeline không gọi API AI nào.

- Nguồn dữ liệu và license: [`docs/content-sources.md`](../docs/content-sources.md)
- Quy tắc và thiết kế: [`docs/content-pipeline.md`](../docs/content-pipeline.md)
- Code: [`src/content-pipeline/`](../src/content-pipeline/)

## Tổng quan

```
fetch → lexicon → tasks generate → ingest → tasks review → ingest ⟲ → tasks rank → ingest → tasks translate → ingest → report → load
             (mỗi `tasks …` cần Claude Code làm task rồi mới `ingest`)
```

| Lệnh | Việc | AI? |
|---|---|---|
| `fetch` | Tải nguồn còn thiếu vào `content/sources/` | Không |
| `lexicon` | Dựng kho tra cứu `content/build/lexicon.json` | Không |
| `tasks generate` | Xuất task: chọn nghĩa, level, ví dụ, IPA, topic | Tạo việc |
| `tasks review` | Xuất task: một AI khác soát lại từng từ (gộp mọi từ loại) | Tạo việc |
| `tasks rank` | Xuất task: xếp thứ tự các nghĩa của mỗi từ (gộp mọi từ loại) | Tạo việc |
| `tasks translate` | Xuất task: dịch nghĩa, ví dụ, tên collection/topic sang **mọi** ngôn ngữ app hỗ trợ | Tạo việc |
| `check <id>` | Kiểm tra một file đầu ra, không ghi gì | Không |
| `ingest` | Kiểm tra mọi đầu ra đã xong và lưu vào `content/build/<slug>/` | Không |
| `report` | Lỗi luật, độ phủ bản dịch, số meaning mỗi topic | Không |
| `load` | Ghi vào DB (`DIRECT_URL`, không có thì `DATABASE_URL`) | Không |

Mọi lệnh có dạng `pnpm content <lệnh> [tuỳ chọn]`. Lệnh này build trước rồi chạy `dist/content-pipeline/cli.js`.
Khi đã build rồi, có thể chạy thẳng `node --env-file=.env dist/content-pipeline/cli.js <lệnh>`.
Collection mặc định là `essential-english`; collection khác thì thêm `--collection <slug>`.

## Chạy từ đầu

```bash
pnpm content fetch          # lần đầu tải ~24MB; các lần sau dùng lại bản trong content/sources
pnpm content lexicon
```

## Bước AI: sinh nội dung

```bash
pnpm content tasks generate --limit 100 --batch 10   # 100 mục, 10 mục một task
```

Lệnh tạo `content/build/<slug>/tasks/gen-0001.json`… Mỗi file gồm:

- `instructions`: yêu cầu cho AI
- `outputSchema`: JSON Schema của đầu ra
- `input`: các mục cần làm
- `output`: tên file kết quả, ví dụ `gen-0001.out.json`

**Claude Code làm task:** bảo Claude Code “làm các task trong `content/build/essential-english/tasks`”. Với mỗi task,
Claude Code (hoặc subagent, mỗi agent vài task) sẽ:

1. đọc `<id>.json` và làm theo `instructions`;
2. ghi JSON thuần vào `<id>.out.json`;
3. chạy `node dist/content-pipeline/cli.js check <id>` rồi sửa đến khi in ra `ok`.

Subagent chỉ được ghi file `.out.json`. Chỉ phiên chính chạy `ingest`, để tránh hai nơi cùng ghi một file JSONL.
Mỗi subagent để script phụ trong thư mục riêng (ví dụ `scratchpad/<task-id>/`); dùng chung tên file như `emit.py` thì các agent ghi đè lên nhau.

Khi các task đã có đầu ra:

```bash
pnpm content ingest          # lưu vào generated.jsonl, xoá task đã xong; đầu ra hỏng thì giữ lại và in lỗi
pnpm content report --verbose
```

Meaning lỗi luật không được nạp. Để làm lại những mục đó: `pnpm content tasks generate --retry-issues`.
Để làm lại vài mục cụ thể: `--only "run|verb,bank|noun"`.

## Bước AI: review (lặp đến khi sạch)

```bash
pnpm content tasks review        # mỗi task 10 từ
# Claude Code làm task, rồi:
pnpm content ingest
pnpm content tasks generate --fixes-only   # chỉ xuất lại các mục bị từ chối (review hoặc trùng bản dịch), kèm ghi chú
# ... làm task, ingest, rồi review lại các mục vừa sinh lại
```

Reviewer là một lượt AI độc lập. Nó xem mọi nghĩa của một từ (gộp các từ loại) và báo các lỗi: nghĩa bị gộp (`merged`),
nghĩa trùng (`duplicate`), ví dụ sai nghĩa (`example_mismatch`), ví dụ sai từ loại (`wrong_part_of_speech`), thiếu nghĩa
cốt lõi (`missing_core`), định nghĩa sai (`wrong_definition`), level sai (`wrong_level`). Mục bị từ chối được sinh lại
tối đa 3 lần; sau đó `report` liệt kê để người xem. **Mục chưa được review hoặc bị từ chối thì không được nạp.**
Sửa nội dung một mục thì review cũ hết hiệu lực.

**Review phải độc lập:** agent review không được là agent (hoặc phiên chính) đã viết hay sửa mục đó, và không ai sửa tay
`reviews.jsonl`. Nếu thấy reviewer sai luật, sửa hướng dẫn review rồi review lại bằng một agent khác.
Sau `MAX_ATTEMPTS` lần sinh lại mà vẫn bị từ chối, `report` liệt kê mục đó để người quyết định.

## Bước AI: xếp hạng nghĩa

```bash
pnpm content tasks rank          # mỗi task 30 từ; từ chỉ có một nghĩa thì không cần
```

App dạy nghĩa có `popularity` cao nhất của mỗi từ trước. Thứ tự là **nghĩa người học nên học trước**: nghĩa cốt lõi mà từ điển cho người học xếp đầu (take "cầm, lấy"), sau đó tới tần suất. Đổi tiêu chí thì chạy lại bằng `tasks rank --force`. Task gom **mọi nghĩa của một từ, gộp các từ loại**, kèm số lần
xuất hiện của nghĩa trong corpus SemCor (`semcorCount`). Claude Code cho điểm tần suất 1–100 và điểm đó là `popularity`.
`check`/`ingest` từ chối đầu ra xếp ngược bằng chứng SemCor rõ ràng giữa hai từ loại (ví dụ *take* "cảnh quay" trên *take* "lấy").
Trong cùng một từ loại thì không ép theo SemCor, vì SemCor gộp sense và bỏ sót cách dùng phổ biến ("used to" đếm 0). Sinh lại nghĩa của một từ thì hạng cũ hết hiệu lực.
Meaning chưa có hạng thì không được nạp.

## Bước AI: dịch

```bash
pnpm content tasks translate
```

**Một lần dịch ra đủ mọi ngôn ngữ app hỗ trợ.** Danh sách nằm ở `APP_LOCALES` trong `src/common/constants/domain.ts`:
vi-VN, en-US, hi-IN, es-MX, ja-JP, pt-BR, ko-KR, zh-TW, th-TH, ar-SA, id-ID. `en-US` lấy thẳng từ nguồn tiếng Anh,
không cần dịch.

Lệnh tạo các file sau:

- `tr-0001.json`…: mỗi task 8 meaning, đầu ra chứa bản dịch của từng meaning cho mọi locale trong `locales` của task.
- `cat-0001.json`: tên collection và topic, cho mọi locale.

Nếu một meaning đã có sẵn vài locale, task chỉ hỏi những locale còn thiếu. `check` báo lỗi khi đầu ra thiếu bất kỳ locale nào.
Claude Code làm các task này giống bước trên, rồi:

```bash
pnpm content ingest
pnpm content report
```

**Trùng bản dịch:** sau khi ingest bản dịch, `report` liệt kê các nghĩa của cùng một từ có chung từ tương đương tiếng Việt.
Các nghĩa đó không được nạp; `tasks generate` tự xuất lại mục đó kèm ghi chú để gộp, rồi lại review và dịch.

**Đủ bộ hoặc không nạp:** meaning thiếu bất kỳ locale nào trong `APP_LOCALES` thì không được nạp. Thêm ngôn ngữ mới cho app
thì thêm vào `APP_LOCALES` (kèm ghi chú dịch trong `stages/translate.ts`), rồi chạy `tasks translate` để bù cho mọi meaning đã có.

## Nạp vào DB

```bash
pnpm content load --dry-run       # chỉ in số liệu sẽ ghi
pnpm content load --publish       # ghi, duyệt bản dịch và publish
```

Không có `--publish` thì bản dịch được ghi ở trạng thái `draft` để admin duyệt. Chạy lại `load` là an toàn:
dòng cũ được cập nhật tại chỗ, và chỉ tạo revision mới khi nội dung thật sự đổi.
Kết quả lần chạy ghi vào `content/build/<slug>/load-report.json`.

## Làm tiếp, làm lại

- **Dừng giữa chừng:** chạy lại `tasks generate`. Mục đã có kết quả hoặc đang nằm trong task chưa xong sẽ không bị xuất lại.
- **Đổi prompt hoặc luật:** tăng `promptVersion` trong spec của collection, rồi chạy `tasks generate`. Mọi mục sẽ được làm lại, id của meaning được giữ theo WordNet sense.
- **Sửa tiếng Anh của một meaning:** bản dịch cũ hết hiệu lực; `tasks translate` sẽ chỉ xuất lại những meaning đó.
- **Thêm collection:** tạo `src/content-pipeline/collections/<slug>.ts`, thêm vào `collections/index.ts`, rồi chạy các bước trên với `--collection <slug>`.

## Thư mục

```
content/
  sources/                       nguồn tải về + manifest.json (URL, sha256, license)      commit
  build/lexicon.json             kho tra cứu                                               dựng lại được, không commit
  build/<slug>/generated.jsonl   kết quả AI đã kiểm tra, có id                             commit
  build/<slug>/reviews.jsonl     kết quả review theo mục                                   commit
  build/<slug>/ranks.jsonl       điểm tần suất theo từ                                     commit
  build/<slug>/translations/     bản dịch theo locale                                      commit
  build/<slug>/tasks/            task đang chờ Claude Code                                 không commit
  build/<slug>/load-report.json  kết quả lần load gần nhất                                 không commit
```
