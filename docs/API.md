# API

JSON UTF-8, cùng origin với frontend. Mọi response có `X-Request-ID`; lỗi có `error` và `requestId`. API private mặc định `Cache-Control: no-store`.

Local dùng cookie session HttpOnly, SameSite=Lax; tài khoản do quản trị tạo, mật khẩu hash scrypt. Production dùng Cognito access token qua `Authorization: Bearer …`. State-changing local API client ngoài browser cần `X-Campus-Client: 1`; browser phải có Origin hợp lệ. Không dùng API key frontend.

| Method | Endpoint                     | Quyền / hành vi                                                 |
| ------ | ---------------------------- | --------------------------------------------------------------- |
| GET    | `/health`                    | Kiểm tra kết nối database                                       |
| GET    | `/api/config`                | Cấu hình đăng nhập công khai, không có secret                   |
| POST   | `/api/auth/login`            | Local: email/password, có rate limit                            |
| GET    | `/api/auth/me`               | Thông tin người đang đăng nhập hoặc null                        |
| POST   | `/api/auth/logout`           | Thu hồi session local; frontend xóa token/đăng xuất Cognito     |
| POST   | `/api/auth/password`         | Người đăng nhập: currentPassword/newPassword                    |
| GET    | `/api/categories`            | Danh sách danh mục                                              |
| POST   | `/api/categories`            | Editor: tạo danh mục                                            |
| GET    | `/api/public/articles`       | Bài công khai; query `category`, `q`                            |
| GET    | `/api/public/articles/:slug` | Chi tiết phiên bản công khai, ETag phiên bản                    |
| GET    | `/api/editorial`             | Author xem bài của mình; editor xem hàng biên tập               |
| POST   | `/api/articles`              | Author/editor: tạo bài và draft đầu tiên                        |
| PUT    | `/api/versions/:id`          | Sửa draft/rejected; phiên bản published được sao sang draft mới |
| POST   | `/api/versions/:id/submit`   | Chủ bài/editor: gửi draft/rejected để duyệt                     |
| POST   | `/api/versions/:id/approve`  | Editor: submitted → approved                                    |
| POST   | `/api/versions/:id/reject`   | Editor: submitted/approved → rejected                           |
| POST   | `/api/versions/:id/publish`  | Editor: approved → published; retry cùng phiên bản an toàn      |
| GET    | `/api/history`               | Author xem lịch sử bài của mình; editor xem toàn bộ             |
| POST   | `/api/uploads`               | Author/editor: raw image body, PNG/JPEG/WebP, tối đa 5 MB       |
| GET    | `/media/:key`                | Ảnh bài công khai hoặc ảnh private có quyền; không shared-cache |
| POST   | `/api/users`                 | Editor: tạo local account hoặc mời user Cognito và gán group    |
| GET    | `/api/ops/metrics`           | Editor: số request thực tế của process hiện tại                 |
| POST   | `/api/ops/origin`            | Chỉ local/editor: diễn tập 503 cho public API                   |

Body tạo/sửa bài: `title` (1–180), `summary` (1–500), `body` (1–50.000), `category_id`, `image` (đường dẫn ảnh đã upload hoặc rỗng). Danh mục của bài đã tạo được giữ nguyên khi sửa phiên bản.

Response bài công khai trả `summary`, `body` của phiên bản đã xuất bản và các trường `document_url`, `document_title` (null nếu không có tài liệu nguồn). Nội dung nguồn UTH là bản tóm tắt đã đối chiếu; `source_url` trỏ tới toàn văn. Liên kết PDF gắn với phiên bản, không nhúng HTML từ website ngoài.

Response lỗi quyền: `401` chưa đăng nhập, `403` thiếu quyền, `409` xung đột trạng thái hoặc dữ liệu đã tồn tại, `413` quá giới hạn upload, `429` quá nhiều lần đăng nhập.

`GET /api/history/:versionId`: author xem bản đã xuất bản của bài mình, editor xem mọi bản đã xuất bản; reader/anonymous bị chặn. Trả snapshot chính xác của version, luôn `no-store`; không công khai bản nháp.
