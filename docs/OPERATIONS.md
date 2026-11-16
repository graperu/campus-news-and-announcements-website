# Vận hành, kiểm thử và khôi phục

## Trạng thái bằng chứng

Kiểm thử local không thay thế bằng chứng AWS. Các kết quả cache hit, cảnh báo, HTTPS cloud, private S3/RDS, rollback deployment và cloud freshness phải được thu thập sau khi có tài khoản AWS và URL thật.

## Chạy các kiểm tra local

```powershell
npm ci
npm run check
npm test
npm run test:workflow
# Chạy npm start trong terminal khác trước lệnh sau
npm run test:browser
```

`test:workflow` chạy trình duyệt với database tạm riêng, kiểm tra tác giả tạo/gửi bài, editor duyệt/xuất bản, người đọc xem và bản sửa chưa duyệt không lộ ra ngoài. Windows dùng Edge; Linux CI cài Chromium. Không tạo tài khoản thử nghiệm trong database ứng dụng.

Ảnh chụp và kết quả local nằm trong `output/`, không commit dữ liệu cá nhân hoặc mật khẩu.

## Workload cache bắt buộc

Sau khi triển khai, chọn một slug thật từ public API:

```powershell
$env:ARTICLE_URL = 'https://YOUR_DISTRIBUTION.cloudfront.net/api/public/articles/YOUR_SLUG'
$env:REQUESTS = '200'
npm run test:cache
```

Script warmup một lần, sau đó 200 request cùng URL với concurrency 1, rồi 200 request có query string riêng để tạo baseline chưa cache. Lưu thời gian từng mẫu, status, latency, `X-Cache`, `Age` và `X-Request-ID` vào `output/evidence/cache.json`.

- Báo cáo p95 từ chính tập 200 mẫu của mỗi phase, tỷ lệ lỗi và tổng thời lượng.
- Cache hit chỉ được thống kê khi server trả header CDN thật. Local không có CDN sẽ báo `null`.
- Số request ID origin duy nhất là dấu hiệu từ response, không thay thế access log. Đối chiếu request ID với log ứng dụng và metric ALB trong cùng cửa sổ đo.
- ALB RequestCount còn chứa các route khác. Tách workload, giới hạn các request ngoài bài đo và lưu log lọc theo path.
- Baseline dùng query string độc nhất chỉ đúng với cache policy hiện tại có toàn bộ query string trong cache key.

## Kiểm tra độ mới trong 60 giây

1. Warm URL bài hiện tại để có object cache cũ.
2. Tác giả tạo phiên bản sửa, gửi duyệt; editor duyệt và xuất bản.
3. Lấy `version_id` và `published_at` thực tế trong lịch sử xuất bản.
4. Chạy ngay:

```powershell
$env:EXPECTED_VERSION = 'NEW_VERSION_ID'
$env:PUBLISHED_AT = 'ACTUAL_PUBLICATION_ISO_TIMESTAMP'
npm run test:freshness
```

Script polling mỗi giây, không cache-bust, lưu các phiên bản đã quan sát và publication freshness lag. Nếu không thấy phiên bản trong 60 giây thì trả exit code lỗi; không tự chuyển sang nội dung mẫu.

Có thể gửi các giá trị vừa đo vào dashboard bằng `PUBLISH_METRICS=true`, `DEPLOYMENT_NAME` bằng Terraform prefix/dashboard name và AWS CLI với quyền `cloudwatch:PutMetricData` cho namespace `CampusNews`. Không có metric được tạo trước khi đo.

## Diễn tập origin unavailable trên AWS

Thực hiện trong cửa sổ demo được thống nhất, ghi lại desired count và task revision đang khỏe trước khi bắt đầu.

1. Ghi timestamp; warm một public article API, lưu header và body.
2. Chuẩn bị một URL bài hoặc query key chưa từng request để đo cache miss.
3. Tạm scale ECS service về 0 task bằng AWS CLI/console. Đây là thao tác diễn tập thật, không phải bật công tắc lỗi local.
4. Request cả URL đã warm và URL chưa cache; lưu status, `X-Cache`, `Age`, request ID, timestamp và log. Lặp lại sau TTL 30 giây.
5. Ghi nhận CloudFront 5xx và cảnh báo. Với ngưỡng 5% trong hai chu kỳ một phút và có request lỗi đều đặn, kỳ vọng phát hiện khoảng 2–5 phút, không bảo đảm tức thì. SNS email cần xác nhận subscription.
6. Khôi phục desired count ban đầu; chờ target group healthy, kiểm tra public API và đăng nhập/biên tập.

**Hành động đầu tiên khi báo động:** xem ECS service events và ALB target health; khôi phục task revision khỏe gần nhất hoặc desired count đã ghi nhận.

Object cache còn hợp lệ có thể vẫn phục vụ trong thời gian ngắn; sau khi hết TTL có thể lỗi. Do thời gian scale-down có thể dài hơn TTL, không giả định request đã warm chắc chắn thành công. Chỉ báo cáo kết quả thực đo.

Local có nút tạm ngắt public origin trong mục Vận hành để kiểm tra luồng 503/khôi phục. Nó vẫn giữ API quản trị và health chạy nên không được dùng thay bằng chứng AWS.

## Triển khai và rollback

Workflow `deploy.yml` chỉ chạy khi chủ động kích hoạt. Để trống image tag sẽ build commit hiện tại, push ECR, đăng ký task revision và chờ ECS ổn định. Nhập image tag cũ sẽ dùng image đã có để rollback. Không đưa secret database vào workflow.

ECS deployment circuit breaker bật rollback khi deployment không khỏe. Sau khi deploy, xác nhận task revision thực tế trùng revision vừa đăng ký; lưu run URL, SHA, task definition và kết quả kiểm tra HTTP. Chưa chạy workflow thì chưa có bằng chứng rollback thành công.

## Cleanup

1. Xác nhận thời hạn lưu dữ liệu và backup trước khi xóa.
2. Export dữ liệu cần giữ và ghi lại toàn bộ tài nguyên của Terraform state.
3. Tắt deletion protection RDS có chủ đích; giữ final snapshot theo thời hạn đã thống nhất.
4. Xử lý object và object version trong S3; xử lý các image ECR trước khi destroy repository.
5. Chạy `terraform plan -destroy`, rà soát rồi mới `terraform destroy`.
6. Kiểm tra snapshot RDS còn giữ, S3 versions, CloudWatch log group, ECR image, Secrets Manager chờ xóa và các tài nguyên không do state quản lý.
7. Kiểm tra Billing/Cost Explorer sau độ trễ cập nhật. Desired count = 0 chỉ ngắt compute task; RDS, ALB, storage và một số dịch vụ vẫn tính phí.

Không tự chạy cleanup hoặc xóa dữ liệu khi chưa có chỉ thị tương ứng.
