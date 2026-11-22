# Script theo chức năng

Chạy lệnh ở gốc dự án; ưu tiên các lệnh npm để tự dùng đúng đường dẫn và cấu hình.

| Thư mục    | Lệnh                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/`    | `npm run data:restore`, `npm run import:uth`                                                                                                 |
| `users/`   | `npm run user:create`                                                                                                                        |
| `checks/`  | `npm run test:browser`, `npm run test:ui`, `npm run test:ui:upgrade`, `npm run test:ui:audit`, `npm run test:ui:motion`, `npm run test:news` |
| `metrics/` | `npm run test:cache`, `npm run test:freshness`                                                                                               |
| `aws/`     | `node scripts/aws/estimate-cost.mjs`                                                                                                         |

Các kiểm tra UI đọc ứng dụng local đang chạy; ảnh và kết quả nằm trong `storage/reports/`. Kiểm thử dùng database tạm riêng nằm trong `tests/` và chạy bằng `npm test`, `npm run test:workflow`.

`npm run test:deployment` kiểm tra bản production chỉ đọc bằng `TEST_BASE_URL`: tin UTH thật, health, assets, khóa các API ghi và bỏ qua session local. Không tạo hay sửa dữ liệu khi chạy kiểm tra này.

`npm run test:news` kiểm tra nội dung của cả 30 bài, 20 liên kết PDF và trang đọc ở 375 / 768 / 1440 px. Mặc định đọc server local; đặt `TEST_BASE_URL` để kiểm tra online. Ảnh kiểm tra nằm trong `storage/reports/news-content/`.

`data/source-content.mjs` dùng chung cho restore và import. `import:uth` chỉ nhập bài có nội dung đã duyệt và mã băm khớp nguồn; các bài mới/thay đổi được báo trong `requiresContentReview` để đối chiếu trước khi xuất bản.
