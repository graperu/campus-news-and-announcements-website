# Ma trận yêu cầu và nghiệm thu

`Đã kiểm tra local` không đồng nghĩa đạt nghiệm thu cloud. Chủ dự án chưa có AWS; các dòng cloud cần được hoàn thành sau khi triển khai thật. Không tạo bằng chứng, số liệu hay tài khoản demo giả.

Bản đọc tin công khai đã triển khai tại [uth-campus-news.vercel.app](https://uth-campus-news.vercel.app), dùng Neon Free riêng ở Singapore. Đã kiểm tra 30 tin thật, API, routing và khóa toàn bộ thao tác ghi. Chủ dự án yêu cầu giữ Cognito/S3 và chờ AWS; khu biên tập chưa được mở trên Vercel. Bản này chưa thay thế nghiệm thu AWS/Azure/GCP của đề.

| Yêu cầu từ đề                                        | Phần triển khai / bằng chứng                                       | Trạng thái                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Reader, author, editor                               | API role enforcement, local users, Cognito groups                  | Đã kiểm tra API và browser local; Cognito cần AWS                                      |
| Tạo draft, duyệt và xuất bản                         | Phiên bản, state transitions, editorial studio                     | Đã kiểm tra API và browser local                                                       |
| Trang bài và danh mục                                | Public article API, trang chi tiết, nav và search                  | Đã kiểm tra local trên Edge                                                            |
| Image upload                                         | PNG/JPEG/WebP, max 5 MB; private S3 production                     | Local có kiểm tra; S3 cần AWS                                                          |
| Draft queue và publication history                   | Editorial API và UI, bảng publications                             | Đã kiểm tra local                                                                      |
| 30 bài, 5 categories, script tái lập                 | 30 bản ghi tin thật có nguồn; 5 chuyên mục; snapshot restore       | Đã nhập local; nội dung gốc được dẫn link                                              |
| Không sử dụng dữ liệu ảo theo yêu cầu chủ dự án      | Không có default users hoặc bài sinh tự động                       | Đã thực hiện; test fixtures chỉ trong DB tạm                                           |
| Stable version/timestamp                             | article_versions, updated_at, published_version                    | Đã kiểm tra local                                                                      |
| Draft không vào shared public cache                  | Private API no-store; CloudFront public-only behavior              | Header local đã kiểm tra; cache behavior cần AWS                                       |
| Reader không gọi publish được                        | API test trực tiếp                                                 | Đã kiểm tra local                                                                      |
| Editor publish approved draft                        | Transaction, role guard, retry safety                              | Đã kiểm tra local                                                                      |
| Nội dung mới xuất hiện ≤60 giây                      | TTL 30s, script freshness có raw samples                           | Cần đo trên AWS                                                                        |
| 200 request và uncached baseline                     | measure-cache.mjs, defined workload/p95/error rate                 | Script sẵn sàng; cần đo CDN thật                                                       |
| Origin unavailable, cached và uncached readers       | Failure drill runbook                                              | Local 503/recovery đã kiểm tra; cloud drill cần AWS                                    |
| HTTPS và network boundaries                          | CloudFront HTTPS, private VPC origin, SG, private RDS              | Terraform validate; cần kiểm tra deployed resources                                    |
| Token validation và workload identity                | Cognito JWT validation, ECS IAM roles                              | Code/config có; cần kiểm tra AWS                                                       |
| Secret/private storage                               | Secrets Manager, private S3, encrypted RDS, verified TLS           | Code/config có; cần kiểm tra AWS                                                       |
| Dashboard bốn chỉ số                                 | CloudFront cache hit, ALB requests, measured p95/freshness metrics | Terraform validate; cần dữ liệu thật AWS                                               |
| Actionable alert, evaluation window, recovery action | CloudFront 5xx alarm + SNS; operations runbook                     | Config có; cần drill và xác nhận notification                                          |
| Request/job IDs, không log secret                    | Request ID API/log/audit                                           | Đã kiểm tra API local; đối chiếu CloudWatch sau deploy                                 |
| IaC recreate, CI/CD, rollback                        | Terraform, CI, manual deploy/rollback workflow                     | CI SQLite/PostgreSQL/browser/Terraform/Docker đã đạt; recreate/deploy/rollback cần AWS |
| So sánh mô hình, scale/session/DB/retry              | ARCHITECTURE.md                                                    | Đã viết; cập nhật theo triển khai thực                                                 |
| URL và demo accounts                                 | Local URL và tài khoản thật chủ dự án                              | Cloud URL/tài khoản Cognito cần AWS                                                    |
| Source, infrastructure, seed, tests, diagram, report | Repo + database + infra + docs                                     | Đã chuẩn bị; diagram actual bổ sung sau deploy                                         |
| Monthly cost estimate                                | COST.md + live SKU evidence                                        | Đã có subtotal và dự phòng; cần chốt dịch vụ phụ                                       |
| Cleanup instructions                                 | OPERATIONS.md                                                      | Đã chuẩn bị; không tự chạy xóa                                                         |
| Demo 10–15 phút                                      | Kịch bản bên dưới                                                  | Cần quay/chạy trên môi trường cloud                                                    |

## Kịch bản demo 10–15 phút

1. 1–2 phút: giới thiệu website và dữ liệu thật có nguồn, duyệt danh mục và đọc bài.
2. 3–4 phút: tác giả viết bài, upload ảnh, gửi duyệt; editor duyệt và xuất bản. Gọi API bằng reader để chứng minh bị từ chối.
3. 2–3 phút: sửa bài đã công khai, xác nhận draft không lộ; publish bản mới và trình bày freshness evidence.
4. 2–3 phút: trình bày 200 request/baseline, cache hit, origin count, p95 và error rate.
5. 2–3 phút: origin failure, kết quả cached/uncached, cảnh báo, khôi phục và kiểm tra lại.
6. 1 phút: CI/CD, rollback evidence, chi phí và cleanup.

Hẹn giờ xuất bản là phần mở rộng tùy chọn trong đề và chưa nằm trong phạm vi triển khai hiện tại.
