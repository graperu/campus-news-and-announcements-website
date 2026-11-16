# Bản đồ thư mục dự án

Chạy mọi lệnh `npm` từ thư mục gốc của dự án.

| Muốn tìm hoặc sửa                                  | Vị trí                    |
| -------------------------------------------------- | ------------------------- |
| Trang HTML chính                                   | `frontend/index.html`     |
| Luồng hiển thị, đăng nhập, biên tập                | `frontend/js/app.js`      |
| Trạng thái URL và bản lưu tạm                      | `frontend/js/ui-state.js` |
| Hiệu ứng và tiện ích cuộn trang                    | `frontend/js/motion.js`   |
| Bố cục và giao diện                                | `frontend/styles/`        |
| Logo và ảnh nguồn                                  | `frontend/assets/`        |
| HTTP API, phân quyền                               | `backend/server.mjs`      |
| Kết nối SQLite/PostgreSQL                          | `backend/db.mjs`          |
| Schema, migrations và snapshot nguồn thật          | `database/`               |
| Tạo tài khoản local                                | `scripts/users/`          |
| Nhập/khôi phục tin UTH                             | `scripts/data/`           |
| Kiểm tra UI trên trình duyệt                       | `scripts/checks/`         |
| Đo cache, freshness và gửi metric                  | `scripts/metrics/`        |
| Ước tính chi phí AWS                               | `scripts/aws/`            |
| Kiểm thử API/dữ liệu và luồng biên tập             | `tests/`                  |
| Mẫu biến môi trường và cấu hình formatter          | `config/`                 |
| Terraform AWS                                      | `infra/aws/`              |
| Dockerfile và quy tắc loại file khỏi image context | `infra/docker/`           |
| CI, triển khai và rollback                         | `.github/workflows/`      |
| Database, thông tin riêng và kết quả trên máy      | `storage/`                |

## Các file giữ ở gốc

- `README.md`: cách chạy và các liên kết tài liệu.
- `package.json`, `package-lock.json`: lệnh chạy và phiên bản thư viện; npm cần chúng ở gốc.
- `.gitignore`, `.gitattributes`: quy tắc Git.
- `.editorconfig`: thiết lập định dạng được editor tự nhận cho toàn dự án.

`node_modules/` do npm quản lý và tự tạo khi chạy `npm ci`; không sắp xếp thủ công bên trong.

## Cấu hình local

Chạy mặc định không cần tạo file cấu hình. Khi cần đổi port hoặc đường dẫn database:

```powershell
Copy-Item config/local.env.example config/local.env
```

Sửa `config/local.env` rồi chạy lại `npm start`. File này được Git ignore. Các lệnh khởi động, tạo tài khoản và nhập/khôi phục dữ liệu cùng đọc file cấu hình này. AWS vẫn nhận biến môi trường qua ECS và Secrets Manager.

Prettier đọc cấu hình `config/prettier.json` qua trường `prettier` trong `package.json`; hai lệnh format dùng `config/prettier.ignore`.

## Build Docker

Chạy từ gốc để Docker có đủ source trong build context:

```powershell
docker build -f infra/docker/Dockerfile -t campus-news .
```

`infra/docker/Dockerfile.dockerignore` được dùng theo Dockerfile tương ứng, loại `storage/`, thư viện local và cấu hình riêng khỏi context. CI và workflow triển khai cũng dùng đường dẫn Dockerfile này.

## Vị trí dữ liệu đã chuyển

| Vị trí cũ                        | Vị trí hiện tại                   |
| -------------------------------- | --------------------------------- |
| `data/campus.db`                 | `storage/data/campus.db`          |
| `data/uploads/`                  | `storage/data/uploads/`           |
| `output/admin-login.txt`         | `storage/private/admin-login.txt` |
| Các kết quả khác trong `output/` | `storage/reports/`                |
| `tmp/`                           | `storage/tmp/`                    |

Dữ liệu trên máy được giữ nguyên, bao gồm tài khoản quản trị. Muốn kiểm tra UI có đăng nhập, đặt `$env:ADMIN_LOGIN_FILE='storage/private/admin-login.txt'` trước khi chạy các lệnh kiểm tra UI.
