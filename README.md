# UTH Campus

Website tin tức và biên tập nội dung cho cộng đồng **Trường Đại học Giao thông vận tải TP.HCM (UTH)**, thực hiện theo đồ án Cloud Computing.

Frontend và backend chạy cùng origin, có phân quyền Reader / Author / Editor, quản lý phiên bản, duyệt/xuất bản bài và lưu lịch sử. Không tạo bài viết hoặc tài khoản demo tự động. Dữ liệu ban đầu là **30 bản ghi tin có nguồn chính thức** từ Công đoàn UTH, kèm ngày đăng, ảnh và liên kết bài gốc.

> **Trạng thái:** đã kiểm tra ứng dụng local bằng API và trình duyệt. Terraform đã validate. Chưa triển khai AWS vì chủ dự án chưa có tài khoản; chưa xác nhận cache/CDN, alert, rollback hay freshness trên cloud. Theo dõi chi tiết ở [ma trận nghiệm thu](docs/ACCEPTANCE.md).

## Chạy local

Yêu cầu **Node.js 24+**. Không cần Docker hoặc PostgreSQL để chạy local.

```powershell
npm ci
npm run data:restore
npm start
```

Mở **http://127.0.0.1:3000**. Dữ liệu local nằm trong `data/campus.db` và bị loại khỏi Git.

`data:restore` khôi phục snapshot tin thật đã kiểm chứng, chạy lại không nhân đôi bản ghi và không ghi đè phiên bản công khai hiện có. Nội dung đầy đủ của tin dẫn nguồn nằm ở bài gốc; hệ thống không giả lập rằng các tin đó được tác giả nội bộ viết.

Muốn cập nhật từ nguồn chính thức:

```powershell
npm run import:uth
```

Nếu nguồn không truy cập được, importer báo lỗi; không tự sinh dữ liệu thay thế.

## Đăng nhập và tài khoản

Không có mật khẩu mặc định hoặc tài khoản demo trong repo.

Tài khoản quản trị local của chủ dự án đã được tạo theo email cung cấp. Thông tin đăng nhập nằm trong `output/admin-login.txt` trên máy hiện tại, không được commit. Có thể đổi mật khẩu từ menu tài khoản; session local cũ được thu hồi sau khi đổi.

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
├── frontend/              # HTML, CSS, JavaScript và ảnh nguồn thật
│   └── assets/news/
├── backend/               # HTTP API, DB adapter và password hashing
├── database/
│   ├── migrations/        # Schema, khóa ngoại và index
│   └── sources/           # Snapshot metadata tin thật có provenance
├── infra/aws/             # Terraform, provider lock và RDS CA
├── scripts/               # Import/restore, tạo user, đo cache/freshness/chi phí
├── tests/                 # API tests và browser workflow trong DB tạm
├── docs/                  # Kiến trúc, API, deploy, vận hành, nghiệm thu
├── .github/workflows/     # CI và manual deploy/rollback qua OIDC
├── Dockerfile
├── package.json
└── README.md
```

`data/`, `output/`, `tmp/`, secrets và Terraform state không được đưa lên Git. Xem [database và sơ đồ quan hệ](database/README.md).

## Kiểm thử

```powershell
npm run check
npm test
npm run test:workflow
# Chạy server local trước:
npm run test:browser
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

| Tài liệu                                 | Nội dung                                                |
| ---------------------------------------- | ------------------------------------------------------- |
| [Phân tích đề](docs/PROJECT_BRIEF.md)    | Yêu cầu, phạm vi và tỷ trọng chấm điểm                  |
| [Database](database/README.md)           | Schema, ERD, transaction và nguồn dữ liệu               |
| [API](docs/API.md)                       | Endpoint và quyền truy cập                              |
| [Kiến trúc](docs/ARCHITECTURE.md)        | Network/trust boundaries, scaling và cache              |
| [Triển khai AWS](docs/AWS_DEPLOYMENT.md) | Bootstrap, Cognito và CI/CD                             |
| [Vận hành](docs/OPERATIONS.md)           | Workload, p95, freshness, alert, failure và cleanup     |
| [Chi phí](docs/COST.md)                  | Giá AWS truy xuất thật và giả định ngân sách            |
| [Nghiệm thu](docs/ACCEPTANCE.md)         | Đối chiếu mọi yêu cầu bắt buộc và trạng thái bằng chứng |

Nguồn thông tin: [Công đoàn UTH](https://congdoan.ut.edu.vn/) · [Cổng UTH](https://uth.edu.vn/). Đây là dự án học tập; không phải cổng thông tin chính thức của trường.
