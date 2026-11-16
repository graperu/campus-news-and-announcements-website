# UTH Campus

Website tin tức và biên tập nội dung cho cộng đồng **Trường Đại học Giao thông vận tải TP.HCM (UTH)**, thực hiện theo đồ án Cloud Computing.

Frontend và backend chạy cùng origin, có phân quyền Reader / Author / Editor, quản lý phiên bản, duyệt/xuất bản bài và lưu lịch sử. Không tạo bài viết hoặc tài khoản demo tự động. Dữ liệu ban đầu là **30 bản ghi tin có nguồn chính thức** từ Công đoàn UTH, kèm ngày đăng, ảnh và liên kết bài gốc.

> **Online:** [uth-campus-news.vercel.app](https://uth-campus-news.vercel.app) — bản đọc tin công khai trên Vercel, dùng PostgreSQL Neon Free và 30 tin UTH thật. Theo lựa chọn chủ dự án, đăng nhập biên tập và upload giữ Cognito/S3, chờ thiết lập AWS; các thao tác ghi trên Vercel hiện bị khóa. Bản local vẫn có đủ luồng biên tập. Terraform đã validate; nghiệm thu AWS vẫn chưa hoàn tất. Xem [triển khai Vercel](docs/VERCEL_DEPLOYMENT.md) và [ma trận nghiệm thu](docs/ACCEPTANCE.md).

## Chạy local

Yêu cầu **Node.js 24.x**. Không cần Docker hoặc PostgreSQL để chạy local.

```powershell
npm ci
npm run data:restore
npm start
```

Mở **http://127.0.0.1:3000**. Dữ liệu local nằm trong `storage/data/campus.db` và bị loại khỏi Git.

`data:restore` khôi phục snapshot tin thật đã kiểm chứng, chạy lại không nhân đôi bản ghi và không ghi đè phiên bản công khai hiện có. Nội dung đầy đủ của tin dẫn nguồn nằm ở bài gốc; hệ thống không giả lập rằng các tin đó được tác giả nội bộ viết.

Muốn cập nhật từ nguồn chính thức:

```powershell
npm run import:uth
```

Nếu nguồn không truy cập được, importer báo lỗi; không tự sinh dữ liệu thay thế.

## Đăng nhập và tài khoản

Không có mật khẩu mặc định hoặc tài khoản demo trong repo.

Tài khoản quản trị local của chủ dự án đã được tạo theo email cung cấp. Thông tin đăng nhập nằm trong `storage/private/admin-login.txt` trên máy hiện tại, không được commit. Có thể đổi mật khẩu từ menu tài khoản; session local cũ được thu hồi sau khi đổi.

Trên máy mới, tạo tài khoản thật đầu tiên bằng biến môi trường:

```powershell
$env:USER_EMAIL = 'YOUR_REAL_EMAIL'
$env:USER_NAME = 'YOUR_DISPLAY_NAME'
$env:USER_ROLE = 'editor'
# Nhập mật khẩu riêng vào biến môi trường USER_PASSWORD, tối thiểu 12 ký tự.
# Tránh ghi mật khẩu thật vào Git, ảnh chụp hoặc shell history.
npm run user:create
```

Editor tạo cộng tác viên ở **Không gian biên tập → Quản lý**. Production dùng Cognito và email mời; đăng nhập local bị tắt khi `NODE_ENV=production`.

## Luồng biên tập

```text
Draft → Submitted → Approved → Published
             ↓          ↓
           Rejected / yêu cầu chỉnh sửa → Draft
```

- Reader xem, tìm kiếm và lọc tin công khai.
- Author tạo/sửa bài của mình, tải ảnh và gửi duyệt.
- Editor duyệt, yêu cầu sửa, xuất bản, xem lịch sử và quản lý tài khoản/danh mục.
- Sửa phiên bản đã xuất bản tạo draft mới; bài công khai giữ nguyên đến lần publish tiếp theo.
- API kiểm tra quyền trực tiếp. Private response trả `no-store`; chỉ API public được cấu hình shared cache.
- Ảnh upload giới hạn PNG/JPEG/WebP 5 MB; S3 production là private.

## Cấu trúc thư mục

```text
.
├── frontend/
│   ├── index.html         # Trang HTML chính
│   ├── js/                # Luồng ứng dụng, trạng thái và hiệu ứng
│   ├── styles/            # Bố cục, thành phần và giao diện UTH
│   └── assets/            # Logo và ảnh nguồn thật
├── backend/               # HTTP API, DB adapter và password hashing
├── api/                   # Adapter nhỏ cho Vercel Functions
├── database/
│   ├── migrations/        # Schema, khóa ngoại và index
│   └── sources/           # Snapshot metadata tin thật có provenance
├── config/                # Mẫu biến môi trường và cấu hình Prettier
├── infra/
│   ├── aws/               # Terraform, provider lock và RDS CA
│   └── docker/            # Dockerfile và quy tắc build context
├── scripts/
│   ├── data/              # Nhập/khôi phục tin thật
│   ├── users/             # Tạo tài khoản
│   ├── checks/            # Kiểm tra UI và trình duyệt
│   ├── metrics/           # Đo cache/freshness và gửi metric
│   └── aws/               # Ước tính chi phí
├── tests/                 # API tests và browser workflow trong DB tạm
├── docs/                  # Kiến trúc, API, deploy, vận hành, nghiệm thu
├── storage/               # Dữ liệu và file phát sinh trên máy; Git ignore
│   ├── data/              # Database và ảnh tải lên
│   ├── private/           # Thông tin tài khoản local
│   ├── reports/           # Kết quả, ảnh kiểm tra và bằng chứng
│   └── tmp/               # File tạm và công cụ phát triển
├── .github/workflows/     # CI và manual deploy/rollback qua OIDC
├── package.json
├── package-lock.json
└── README.md
```

Xem [bản đồ thư mục và vị trí file](docs/PROJECT_STRUCTURE.md) để tìm nhanh theo chức năng, [danh sách script](scripts/README.md), hoặc [database và sơ đồ quan hệ](database/README.md). Dữ liệu trong `storage/` (ngoài README), cấu hình `config/local.env`, secrets và Terraform state không được đưa lên Git.

Khi cần tùy chỉnh port/database, sao chép `config/local.env.example` thành `config/local.env`. Các lệnh npm đọc cùng file cấu hình này; chạy mặc định không cần tạo file.

## Kiểm thử

```powershell
npm run check
npm test
npm run test:workflow
# Chạy server local trước:
npm run test:browser
npm run test:ui
npm run test:ui:upgrade
npm run test:ui:audit
npm run test:ui:motion
```

- API tests kiểm tra quyền, draft privacy, approval, retry publication, revision isolation và failure/recovery.
- Browser workflow kiểm tra tạo/gửi/duyệt/xuất bản qua UI bằng database tạm riêng.
- Browser layout check chụp 375 / 768 / 1440 px, kiểm tra overflow và JavaScript errors.
- Windows dùng Edge cài sẵn. Trên Linux, cài Chromium bằng `npx playwright install --with-deps chromium`; có thể chọn `BROWSER_CHANNEL=chromium`.
- CI cấu hình thêm PostgreSQL integration test và Docker build. Kết quả CI phải được xác nhận từ workflow run thực tế.

## AWS

Kiến trúc: **CloudFront VPC origin → internal ALB → ECS Fargate → private RDS PostgreSQL**, cùng private S3, Cognito, Secrets Manager và CloudWatch/SNS.

```powershell
terraform -chdir=infra/aws init -backend=false
terraform -chdir=infra/aws validate
```

Các lệnh trên chỉ kiểm tra cấu hình; không tạo tài nguyên. Không chạy apply trước khi kiểm tra account, quyền, quota và ngân sách. [Hướng dẫn triển khai](docs/AWS_DEPLOYMENT.md) mô tả bootstrap image, data restore bằng ECS task và GitHub OIDC.

## Tài liệu

| Tài liệu                                       | Nội dung                                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| [Phân tích đề](docs/PROJECT_BRIEF.md)          | Yêu cầu, phạm vi và tỷ trọng chấm điểm                  |
| [Bản đồ thư mục](docs/PROJECT_STRUCTURE.md)    | Tìm file, cấu hình local và vị trí dữ liệu đã chuyển    |
| [Database](database/README.md)                 | Schema, ERD, transaction và nguồn dữ liệu               |
| [API](docs/API.md)                             | Endpoint và quyền truy cập                              |
| [Kiến trúc](docs/ARCHITECTURE.md)              | Network/trust boundaries, scaling và cache              |
| [Triển khai AWS](docs/AWS_DEPLOYMENT.md)       | Bootstrap, Cognito và CI/CD                             |
| [Triển khai Vercel](docs/VERCEL_DEPLOYMENT.md) | Bản public, Neon Free, trạng thái Cognito/S3            |
| [Vận hành](docs/OPERATIONS.md)                 | Workload, p95, freshness, alert, failure và cleanup     |
| [Chi phí](docs/COST.md)                        | Giá AWS truy xuất thật và giả định ngân sách            |
| [Nghiệm thu](docs/ACCEPTANCE.md)               | Đối chiếu mọi yêu cầu bắt buộc và trạng thái bằng chứng |

Nguồn thông tin: [Công đoàn UTH](https://congdoan.ut.edu.vn/) · [Cổng UTH](https://uth.edu.vn/). Đây là dự án học tập; không phải cổng thông tin chính thức của trường.

`test:ui` kiểm tra vị trí tìm kiếm, tiêu đề mobile, tin không trùng, bài gốc/tin liên quan và logo nguồn chính thức trên dữ liệu UTH đã restore. Có thể đặt `ADMIN_LOGIN_FILE=storage/private/admin-login.txt` để kiểm tra thêm bộ lọc và phân trang biên tập bằng tài khoản local; không đưa file này lên Git.

`test:ui:upgrade` kiểm tra tải chậm, tìm kiếm liên tiếp, ảnh/tiêu đề tách biệt, thẻ tin, focus bàn phím và reduced motion. Với `ADMIN_LOGIN_FILE`, kiểm tra thêm các cách sắp xếp và bảng lịch sử xuất bản trên dữ liệu thật. Luồng form đang lưu, hàng chờ và lịch sử cũng được kiểm tra trong `test:workflow` bằng database tạm riêng.

Bản thảo đang soạn có bản lưu tạm **trong tab hiện tại**, tách theo tài khoản và phiên bản, tối đa 24 giờ. Nội dung này chưa được gửi lên máy chủ; file ảnh chưa tải lên cần chọn lại sau reload. Không dựa vào bản lưu tạm sau khi đóng tab; hãy lưu bản nháp lên máy chủ. đăng xuất xóa bản lưu của tài khoản đó. Form cảnh báo trước khi đóng/rời khi còn thay đổi chưa lưu.

Trạng thái chuyên mục/tìm kiếm/phân trang và tab/bộ lọc biên tập được ghi vào URL để Back/Reload khôi phục. Tìm kiếm đầu trang luôn tìm toàn bộ tin. `test:ui:audit` đối chiếu các lỗi đã sửa; bật `ADMIN_LOGIN_FILE` để kiểm tra cả khu biên tập với dữ liệu thật.

Giao diện dùng màu UTH, header căn giữa, thẻ tin và các thành phần biên tập thống nhất. `frontend/styles/theme.css` chứa lớp giao diện; `frontend/styles/motion.css` và `frontend/js/motion.js` quản lý hiệu ứng cho các trang và tương tác. Nội dung không bị ẩn để chờ cuộn; vùng đang nhập liệu được giữ ổn định. `prefers-reduced-motion` tắt chuyển động và cuộn mượt, kể cả khi đổi thiết lập trong lúc mở trang. Xem [phạm vi và kiểm tra hiệu ứng](docs/UI_MOTION.md).

`npm run test:ui:motion` kiểm tra hiệu ứng thực tế trong trình duyệt, hover, focus dialog, thông báo liên tiếp, tiến độ đọc, nút về đầu trang và chế độ giảm chuyển động. Ảnh kiểm tra được lưu trong `storage/reports/ui-motion/`. Với `ADMIN_LOGIN_FILE`, chụp thêm khu biên tập/form bằng tài khoản local thật, không tạo hay sửa bài viết.
