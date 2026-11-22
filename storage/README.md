# Dữ liệu trên máy hiện tại

Thư mục này gom dữ liệu chạy ứng dụng và kết quả phát sinh. Ngoài README này, nội dung không được đưa lên Git hoặc gửi vào Docker build context.

| Thư mục    | Chứa gì                                                        |
| ---------- | -------------------------------------------------------------- |
| `data/`    | SQLite `campus.db` và ảnh tải lên trong `uploads/`             |
| `private/` | Thông tin tài khoản quản trị local; không chia sẻ hay commit   |
| `reports/` | Ảnh kiểm tra UI, số đo và bằng chứng vận hành                  |
| `tmp/`     | File tạm, công cụ và dữ liệu tải về trong quá trình phát triển |

Database khởi tạo khi chạy ứng dụng. `npm run data:restore` nhập snapshot tin UTH thật; lệnh này không tạo tài khoản. Trên máy hiện tại, dữ liệu đã có được chuyển nguyên vẹn từ vị trí cũ.

Không xóa `data/` hoặc `private/` khi dọn kết quả kiểm thử. Không ghi mật khẩu vào các báo cáo có thể chia sẻ.
