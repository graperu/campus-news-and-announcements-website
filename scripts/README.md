# Script theo chức năng

Chạy lệnh ở gốc dự án; ưu tiên các lệnh npm để tự dùng đúng đường dẫn và cấu hình.

| Thư mục    | Lệnh                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `data/`    | `npm run data:restore`, `npm run import:uth`                                                                            |
| `users/`   | `npm run user:create`                                                                                                   |
| `checks/`  | `npm run test:browser`, `npm run test:ui`, `npm run test:ui:upgrade`, `npm run test:ui:audit`, `npm run test:ui:motion` |
| `metrics/` | `npm run test:cache`, `npm run test:freshness`                                                                          |
| `aws/`     | `node scripts/aws/estimate-cost.mjs`                                                                                    |

Các kiểm tra UI đọc ứng dụng local đang chạy; ảnh và kết quả nằm trong `storage/reports/`. Kiểm thử dùng database tạm riêng nằm trong `tests/` và chạy bằng `npm test`, `npm run test:workflow`.
