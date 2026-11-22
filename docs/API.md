# API

JSON UTF-8, cùng origin với frontend. Mọi response có `X-Request-ID` và các security header (`X-Frame-Options: DENY`, CSP, `X-Content-Type-Options`, `Referrer-Policy`); lỗi có `error` và `requestId`. API private mặc định `Cache-Control: no-store`. Các endpoint đọc công khai (`/api/categories`, `/api/public/articles`, `/api/public/articles/:slug`) trả `Cache-Control: public, max-age=0, s-maxage=30, must-revalidate`, `ETag` mạnh và hỗ trợ `If-None-Match` → `304 Not Modified` (rỗng body). Mọi endpoint `GET` đều hỗ trợ `HEAD` (trả header tương ứng, không có body); method không hợp lệ trả `405`.

Local dùng cookie session HttpOnly, SameSite=Lax; tài khoản do quản trị tạo, mật khẩu hash scrypt. Production dùng Cognito access token qua `Authorization: Bearer …`. State-changing local API client ngoài browser cần `X-Campus-Client: 1`; browser phải có Origin hợp lệ. Không dùng API key frontend.

| Method     | Endpoint                       | Quyền / hành vi                                                                                                                                                 |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET / HEAD | `/health`                      | Kiểm tra kết nối database                                                                                                                                       |
| GET / HEAD | `/api/config`                  | Cấu hình đăng nhập công khai, không có secret                                                                                                                   |
| POST       | `/api/auth/login`              | Local: email/password, có rate limit                                                                                                                            |
| GET / HEAD | `/api/auth/me`                 | Thông tin người đang đăng nhập hoặc null                                                                                                                        |
| POST       | `/api/auth/logout`             | Thu hồi session local; frontend xóa token/đăng xuất Cognito                                                                                                     |
| POST       | `/api/auth/password`           | Người đăng nhập: currentPassword/newPassword                                                                                                                    |
| GET / HEAD | `/api/categories`              | Danh sách danh mục (`ETag` + `304 Not Modified`)                                                                                                                |
| POST       | `/api/categories`              | Editor: tạo danh mục                                                                                                                                            |
| GET / HEAD | `/api/public/articles`         | Bài công khai; query `category`, `q` (NFC tiếng Việt, escape `LIKE`, `ETag`/`304`)                                                                              |
| GET / HEAD | `/api/public/articles/:slug`   | Chi tiết phiên bản công khai, `ETag` phiên bản + `304`                                                                                                          |
| GET / HEAD | `/api/editorial`               | Author xem bài của mình; editor xem hàng biên tập (loại `superseded` và `published` cũ; trả `published_version`, `category_id`, `scheduled_at`, `scheduled_by`) |
| POST       | `/api/articles`                | Author/editor: tạo bài và draft đầu tiên                                                                                                                        |
| PUT        | `/api/versions/:id`            | Sửa draft/rejected (hỗ trợ đổi `category_id`, xóa `image`); `published` sao sang draft mới                                                                      |
| POST       | `/api/versions/:id/submit`     | Chủ bài/editor: gửi draft/rejected để duyệt                                                                                                                     |
| POST       | `/api/versions/:id/approve`    | Editor: submitted → approved                                                                                                                                    |
| POST       | `/api/versions/:id/reject`     | Editor: submitted/approved/scheduled → rejected (xóa lịch hẹn)                                                                                                  |
| POST       | `/api/versions/:id/schedule`   | Editor: approved/scheduled → scheduled; body `{ scheduled_at }` ISO-8601 (UTC/offset, hợp lệ lịch Gregorian, tương lai)                                         |
| POST       | `/api/versions/:id/unschedule` | Editor: scheduled → approved (xóa `scheduled_at`/`scheduled_by`)                                                                                                |
| POST       | `/api/versions/:id/publish`    | Editor: approved/scheduled → published; retry cùng phiên bản an toàn; bản `published` cũ chuyển `superseded`                                                    |
| GET / HEAD | `/api/history`                 | Author xem lịch sử bài của mình; editor xem toàn bộ                                                                                                             |
| POST       | `/api/uploads`                 | Author/editor: raw image body, PNG/JPEG/WebP, tối đa 5 MB                                                                                                       |
| GET / HEAD | `/media/:key`                  | Ảnh bài công khai hoặc ảnh private có quyền; không shared-cache                                                                                                 |
| POST       | `/api/users`                   | Editor: tạo local account hoặc mời user Cognito và gán group                                                                                                    |
| GET / HEAD | `/api/ops/metrics`             | Editor: số request thực tế của process hiện tại                                                                                                                 |
| POST       | `/api/ops/origin`              | Chỉ local/editor: diễn tập 503 cho public API                                                                                                                   |
| POST       | `/api/ops/scheduler/run`       | Editor: chạy scheduler idempotent xuất bản bài `scheduled` đã đến hạn; trả `{ ok, count, published }` (`503` khi `PUBLIC_READ_ONLY`)                            |

Body tạo/sửa bài: `title` (1–180), `summary` (1–500), `body` (1–50.000), `category_id`, `image` (đường dẫn ảnh đã upload hoặc chuỗi rỗng `""` để xóa). Các trường text và `category_id` được trim trước khi kiểm tra. Phiên bản `draft` và `rejected` cho phép cập nhật `category_id` (cập nhật `articles.category_id` ngay nếu bài chưa từng xuất bản, hoặc khi xuất bản nếu đã có bản công khai); sửa phiên bản `published` tạo bản nháp mới mang `category_id` đã chọn.

Response bài công khai trả `summary`, `body` của phiên bản đã xuất bản và các trường `document_url`, `document_title` (null nếu không có tài liệu nguồn). Nội dung nguồn UTH là bản tóm tắt đã đối chiếu; `source_url` trỏ tới toàn văn. Liên kết PDF gắn với phiên bản, không nhúng HTML từ website ngoài.

Response lỗi: `400` dữ liệu/JSON/lịch hẹn không hợp lệ hoặc URI malformed (`URIError`/null byte), `401` chưa đăng nhập, `403` thiếu quyền, `405` phương thức HTTP không hỗ trợ, `409` xung đột trạng thái hoặc dữ liệu đã tồn tại, `413` quá giới hạn upload, `429` quá nhiều lần đăng nhập, `503` khi `PUBLIC_READ_ONLY` chặn thao tác ghi hoặc đang diễn tập lỗi origin.

`GET / HEAD /api/history/:versionId`: author xem bản đã xuất bản của bài mình, editor xem mọi bản đã xuất bản; reader/anonymous bị chặn. Trả snapshot chính xác của version, luôn `no-store`; không công khai bản nháp.
