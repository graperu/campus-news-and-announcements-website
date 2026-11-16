# Triển khai bản Vercel

Đích triển khai là project `uth-campus-news` trong tài khoản Vercel `graperu`. Đây là một bản triển khai riêng; đề gốc vẫn yêu cầu hạ tầng trên AWS, Azure hoặc GCP. Không dùng kết quả Vercel để đánh dấu hoàn tất các tiêu chí VPC, ALB, IAM, Cognito hay CloudWatch.

URL production: **https://uth-campus-news.vercel.app**. PostgreSQL Neon Free được tạo riêng ở Singapore, tên `uth-campus-db`; production API chạy ở region `sin1`. Đã restore 30 tin thật với tóm tắt đã đối chiếu nguồn và 20 liên kết PDF gốc; tài khoản quản trị local không được đưa lên cloud.

## Thành phần

| Phần                       | Vercel                                                         |
| -------------------------- | -------------------------------------------------------------- |
| HTML, CSS, JS và ảnh nguồn | Phục vụ từ `frontend/` qua CDN                                 |
| HTTP API                   | `api/index.mjs` chuyển tới handler trong `backend/server.mjs`  |
| Database                   | PostgreSQL riêng trên Neon, chọn gói `free_v3`, vùng Singapore |
| Đăng nhập                  | Giữ Cognito theo lựa chọn của chủ dự án; chờ thiết lập AWS     |
| Ảnh tải lên                | Giữ private S3; chờ thiết lập AWS                              |
| AWS                        | Giữ cấu hình Cognito/S3 và Terraform riêng trong `infra/aws/`  |

Không dùng SQLite hoặc thư mục `/tmp` làm nơi lưu dữ liệu thật trên Vercel. Các bản ghi phải tồn tại sau cold start và redeploy.

## Các bước

1. Liên kết project Vercel với đúng repository.
2. Chủ dự án đã đồng ý Neon Free và yêu cầu giữ Cognito/S3, chờ thiết lập AWS.
3. Tạo Neon Free riêng cho dự án, chỉ nối production; không dùng chung database của ứng dụng khác.
4. Thiết lập `DATABASE_URL`, `DB_SSL=true`, `PUBLIC_READ_ONLY=true`, `APP_ORIGIN` bằng HTTPS. Biến `VERCEL=1` do nền tảng cung cấp.
5. Khôi phục snapshot 30 tin thật vào PostgreSQL bằng `scripts/data/restore-source.mjs`. Không đưa tài khoản hoặc session local lên cloud; không tạo người dùng demo.
6. Kiểm thử và deploy production: `/health`, tin thật, tìm kiếm/chuyên mục/phân trang; kiểm tra mọi thao tác ghi bị từ chối và giao diện báo biên tập chưa mở.

`PUBLIC_READ_ONLY` chỉ có hiệu lực khi cả `NODE_ENV=production` và `VERCEL=1`. Chế độ này chặn tất cả POST/PUT, không chấp nhận session local và không tạo cơ chế xác thực thay thế Cognito. Bản local vẫn giữ đầy đủ tính năng biên tập hiện có.

Khi có AWS, cấu hình Cognito/S3 cùng quyền truy cập cần thiết, đặt `PUBLIC_READ_ONLY=false` và redeploy. Kiểm tra lại đăng nhập OIDC, author/editor, ảnh nháp, lịch sử và xuất bản trước khi mở khu biên tập. Khi tắt chế độ đọc công khai, ứng dụng từ chối khởi động nếu thiếu cấu hình AWS bắt buộc.

Mật khẩu database, token Vercel và thông tin đăng nhập không nằm trong Git, static frontend hoặc log build. File `storage/` và `config/local.env` bị loại khỏi deployment context bằng `.vercelignore`.

## File cấu hình

- `vercel.json`: Node function, thư mục frontend, routing và security headers.
- `.vercelignore`: loại dữ liệu, secrets và công cụ local khỏi upload.
- `api/index.mjs`: adapter nhỏ cho nền tảng; logic API ở `backend/`.

Khi mở upload qua Vercel sau này, cần xử lý giới hạn request/response 4.5 MB của Functions bằng upload trực tiếp vào private S3 có xác thực và kiểm tra ảnh. Chưa mở upload trong bản đọc tin hiện tại.

Vercel không tự đồng bộ SQLite trên máy với PostgreSQL sau triển khai. Khi bắt đầu dùng bản online, dữ liệu tạo trên website nằm trong database online.

Nguồn kỹ thuật: [Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js), [giới hạn Functions](https://vercel.com/docs/functions/limitations), [Neon qua Marketplace CLI](https://vercel.com/docs/cli/integration).

## Kiểm tra bản online

```powershell
$env:TEST_BASE_URL='https://uth-campus-news.vercel.app'
npm run test:deployment
npm run test:news
npm run test:browser
```

Kiểm tra deployment chỉ đọc không ghi dữ liệu vào database; các request POST/PUT thử nghiệm phải trả 503. API private phải trả 401 và `no-store`; session local bị bỏ qua. `test:browser` chụp màn hình và kiểm tra lỗi JavaScript/tràn ngang.

## AWS là gì trong dự án này?

AWS (Amazon Web Services) là nền tảng điện toán đám mây của Amazon: thuê tài nguyên xử lý, database, lưu trữ và mạng qua Internet thay vì vận hành máy chủ vật lý. Chi phí phụ thuộc tài nguyên và mức sử dụng; cần theo dõi ngân sách khi thiết lập.

| Thành phần thiết kế AWS | Vai trò trong UTH Campus                    |
| ----------------------- | ------------------------------------------- |
| ECS Fargate             | Chạy backend Node.js trong container        |
| RDS PostgreSQL          | Lưu bài, phiên bản và lịch sử xuất bản      |
| Private S3              | Lưu ảnh bài viết, bao gồm ảnh nháp riêng tư |
| Cognito                 | Đăng nhập và nhóm quyền author/editor       |
| CloudFront              | Phân phối nội dung và cache                 |
| VPC, ALB, IAM           | Mạng riêng, cân bằng tải và quyền dịch vụ   |
| CloudWatch/SNS          | Theo dõi chỉ số, log và cảnh báo            |

Vercel giúp triển khai website và Functions với ít bước vận hành hơn. Hạ tầng AWS được giữ để thực hiện các yêu cầu mạng, xác thực OIDC, giám sát và tái tạo hạ tầng của đồ án. Đưa website lên Vercel không tạo các tài nguyên AWS đó.

Nguồn: [AWS và điện toán đám mây](https://aws.amazon.com/what-is-cloud-computing/).
