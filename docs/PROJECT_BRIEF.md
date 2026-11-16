# Campus News and Announcements Website

Website tin tức và thông báo trong trường học — đồ án Cloud Computing, **Final Project 02 | Foundation**.

> Tài liệu này phân tích yêu cầu và định hướng thực hiện đồ án. Đây chưa phải mô tả một hệ thống đã triển khai. Các checklist được để trống để theo dõi tiến độ.

**Đề gốc:** [Campus News and Announcements Website](project-brief.pdf)

## 1. Mục tiêu đồ án

Xây dựng website tin tức công khai có quy trình biên tập được bảo vệ và triển khai hoạt động trên **AWS, Azure hoặc GCP**.

Hệ thống phải chứng minh được:

- Người dùng tạo, duyệt và xuất bản bài viết theo đúng quyền.
- Nội dung công khai được phân phối qua cache để giảm tải origin.
- Bài cập nhật xuất hiện trong thời hạn làm mới đã xác định.
- Có bằng chứng về bảo mật, hiệu năng, giám sát, sự cố và khôi phục.
- Hạ tầng có thể tái tạo từ code, triển khai qua CI/CD và rollback.

Quy mô nhóm gợi ý: **3–4 sinh viên**, thực hiện trong **6–8 tuần**.

## 2. Người dùng và chức năng

| Vai trò                | Chức năng                                                |
| ---------------------- | -------------------------------------------------------- |
| Reader — người đọc     | Xem bài đã xuất bản và duyệt bài theo danh mục           |
| Author — tác giả       | Tạo bản nháp, nhập nội dung, tải ảnh và gửi bài để duyệt |
| Editor — biên tập viên | Xem hàng chờ, duyệt và xuất bản bài viết                 |

### Luồng nghiệp vụ đề xuất

```text
Tạo bản nháp → Gửi duyệt → Biên tập viên duyệt → Xuất bản → Người đọc xem
```

Các trạng thái “bị từ chối” hoặc “yêu cầu chỉnh sửa” là đề xuất thiết kế thêm; đề chưa quy định chi tiết.

### Phạm vi tối thiểu

- [ ] Tạo bản nháp và duyệt bài.
- [ ] Trang chi tiết bài đã xuất bản.
- [ ] Duyệt bài theo danh mục.
- [ ] Tải ảnh bài viết.
- [ ] Hàng chờ bản nháp.
- [ ] Lịch sử xuất bản.
- [ ] Trình diễn độ mới của cache.
- [ ] Đo cache hit và số request về origin.

## 3. Dữ liệu và mô hình

### Dữ liệu mẫu bắt buộc

- **30 bài viết mẫu**.
- **5 danh mục**.
- Ảnh bài viết.
- Tài khoản tác giả và dữ liệu quyết định xuất bản.
- Script seed có thể chạy lại.
- Bộ dữ liệu tham chiếu nhỏ với kết quả mong đợi đã biết.

Sử dụng danh tính giả lập. Đề cũng có hướng dẫn chung về mô phỏng thao tác tài chính; điều này không đồng nghĩa website phải bổ sung chức năng thanh toán.

### Các thực thể được nêu trong đề

| Thực thể         | Ý nghĩa                             |
| ---------------- | ----------------------------------- |
| `Article`        | Thông tin bài viết                  |
| `ArticleVersion` | Các phiên bản nội dung của bài viết |
| `Category`       | Danh mục bài viết                   |
| `Publication`    | Bản ghi xuất bản                    |

Nội dung đã xuất bản phải có phiên bản ổn định hoặc thời điểm cập nhật để xác định độ mới.

**Định hướng thiết kế:** tách phiên bản đang chỉnh sửa khỏi phiên bản đang công khai. Khi tác giả sửa bài đã xuất bản, nội dung chưa được duyệt không được tự xuất hiện cho người đọc.

## 4. Kiến trúc cloud

Chọn **một** nhà cung cấp. Các cấu hình dưới đây là gợi ý trong đề, chưa phải quyết định công nghệ của dự án.

| Thành phần         | AWS                                        | Azure                                         | GCP                                                                      |
| ------------------ | ------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------ |
| Chạy ứng dụng      | Application Load Balancer + ECS on Fargate | App Service                                   | Cloud Run                                                                |
| Cơ sở dữ liệu      | RDS for PostgreSQL                         | Azure Database for PostgreSQL Flexible Server | Cloud SQL for PostgreSQL                                                 |
| Lưu ảnh            | S3                                         | Blob Storage                                  | Cloud Storage                                                            |
| Phân phối nội dung | CloudFront                                 | Front Door                                    | External Load Balancer được hỗ trợ + Cloud CDN cho nội dung đủ điều kiện |
| Xác thực           | Cognito                                    | Entra External ID                             | Identity Platform                                                        |
| Quản lý secret     | Secrets Manager                            | Key Vault                                     | Secret Manager                                                           |

Có thể chọn nhà cung cấp OIDC khác nếu giải thích được lý do. Chỉ bổ sung dịch vụ khi có mục đích kiến trúc rõ ràng.

### Yêu cầu kiến trúc

- [ ] Xác nhận region, tier, quota và quyền tài khoản sinh viên trước khi triển khai.
- [ ] Vẽ sơ đồ thực tế với tên dịch vụ đã dùng.
- [ ] Thể hiện đường kết nối mạng, ranh giới tin cậy và phạm vi ảnh hưởng khi lỗi.
- [ ] Chỉ mở những điểm truy cập HTTPS cần thiết.
- [ ] Hạn chế kết nối database theo danh tính ứng dụng và đường mạng cần thiết.
- [ ] Giữ đối tượng riêng tư ở chế độ không công khai.
- [ ] Mô tả phương thức kết nối mạng riêng nếu dịch vụ serverless cần truy cập database riêng tư.
- [ ] Dùng workload identity cho các lời gọi giữa dịch vụ.

Các dịch vụ cùng nằm trong cloud không có nghĩa kết nối giữa chúng đã là mạng riêng.

## 5. Bảo mật và tính đúng đắn

### Phân quyền

- Kiểm tra token và quyền tại API.
- Reader gọi trực tiếp API publish phải bị từ chối.
- Editor có thể xuất bản bản nháp đã được duyệt.
- Kiểm thử quyền bằng lời gọi API trực tiếp; chỉ ẩn nút trên giao diện là chưa đủ.

### Nội dung riêng tư và secret

- Bản nháp và phản hồi dành cho editor không được đưa vào cache công khai dùng chung.
- Secret phải nằm trong dịch vụ quản lý secret phù hợp.
- Không ghi credential, signed URL hoặc nội dung riêng tư vào log.
- Kiểm tra HTTPS, cách xử lý secret và quyền truy cập storage.

## 6. Cache và độ mới của nội dung

**Origin** là nơi CDN lấy nội dung gốc, chẳng hạn ứng dụng backend.

Hệ thống cần đồng thời giảm request về origin và bảo đảm bài cập nhật xuất hiện kịp thời.

- Chỉ cache các biểu diễn công khai.
- Xác định cơ chế invalidation hoặc thời gian sống cache tối đa.
- Chứng minh bài cập nhật xuất hiện trong **60 giây** theo tiêu chí kiểm thử của đề.
- Đo hiệu quả cache so với trường hợp không cache.

Có thể thiết kế theo TTL, invalidation khi xuất bản hoặc kết hợp. Phương án cuối cùng phải được kiểm chứng bằng số liệu.

## 7. Kiểm thử và tiêu chí nghiệm thu

Đây là tiêu chí nghiệm thu lớp học được đề xuất trong đề, không phải cam kết của nhà cung cấp cloud. Nếu thay đổi workload hoặc mục tiêu, cần thống nhất với giảng viên trước khi kiểm thử.

| Kiểm thử                | Điều cần chứng minh                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Test 1 — Phân quyền     | Reader không gọi publish thành công; editor xuất bản được bản nháp đã duyệt                       |
| Test 2 — Độ mới         | Nội dung mới xuất hiện trong tối đa 60 giây sau khi cập nhật theo chính sách cache đã chọn        |
| Test 3 — Hiệu quả cache | Request một bài phổ biến 200 lần; so sánh cache hit và traffic về origin với baseline không cache |
| Sự cố origin            | Tạm làm origin không hoạt động; ghi nhận kết quả cho nội dung đã cache và chưa cache              |
| Tự động hóa             | Tái tạo hạ tầng từ code, triển khai qua CI/CD và trình diễn rollback                              |
| Bảo mật                 | Gọi trực tiếp API với quyền hợp lệ và không hợp lệ; kiểm tra HTTPS, secret và storage riêng tư    |

### Bằng chứng kiểm thử

- [ ] Lưu đầu vào, timestamp, kết quả thô và log liên quan.
- [ ] Công bố thời lượng, concurrency hoặc request rate, warmup và dataset khi kiểm thử tải.
- [ ] Báo cáo tỷ lệ lỗi.
- [ ] Báo cáo p95 trên tập mẫu xác định.

**p95** là thời gian mà 95% request trong tập mẫu hoàn thành không vượt quá.

## 8. Sự cố và khôi phục

Tạm làm origin không khả dụng và ghi nhận:

1. Người đọc yêu cầu bài đã có trong cache nhận được gì.
2. Người đọc yêu cầu bài chưa có trong cache nhận được gì.
3. Hệ thống phát hiện sự cố như thế nào.
4. Các bước khôi phục và kết quả sau khôi phục.

Khả năng tiếp tục phục vụ nội dung đã cache phụ thuộc chính sách cache. Không được khẳng định CDN bảo đảm khả dụng vô thời hạn.

### Các quyết định cần bảo vệ khi trình bày

- Lý do chọn mô hình compute và lưu trữ, cùng một phương án thay thế.
- Ảnh hưởng của việc scale tới session, cache và kết nối database.
- Cách retry an toàn và nguồn dữ liệu có thẩm quyền của hệ thống.
- Thành phần nào còn hoạt động trong sự cố bắt buộc.

## 9. Giám sát và cảnh báo

### Chỉ số bắt buộc

| Chỉ số                    | Mục đích                                                          |
| ------------------------- | ----------------------------------------------------------------- |
| Cache hit ratio           | Đánh giá tỷ lệ request được phục vụ từ cache                      |
| Origin request count      | Đo số request đi tới nguồn nội dung gốc                           |
| Public read latency       | Đánh giá độ trễ đọc nội dung công khai                            |
| Publication freshness lag | Đo độ trễ từ xuất bản tới khi nội dung mới hiển thị cho người đọc |

### Yêu cầu vận hành

- [ ] Tạo dashboard.
- [ ] Tạo ít nhất một cảnh báo có hành động xử lý, gắn với diễn tập sự cố.
- [ ] Nêu điều kiện cảnh báo và cửa sổ đánh giá.
- [ ] Nêu độ trễ phát hiện dự kiến và hành động khôi phục đầu tiên.
- [ ] Dùng mã request/job để đối chiếu giữa log, phản hồi API và worker nếu có.

## 10. Chi phí và dọn tài nguyên

Ước tính chi phí theo workload mỗi tháng, bao gồm:

- Region và service tier.
- Số giờ chạy.
- Dung lượng lưu trữ và backup.
- Số request.
- Lưu lượng truyền ra ngoài (egress).

**Cảnh báo ngân sách không phải giới hạn chi tiêu cứng.** Cần giới hạn scale và thời gian kiểm thử. Những tính năng đắt tiền có thể trình diễn trong thời gian ngắn rồi gỡ bỏ.

Sau thời gian lưu giữ đã thống nhất, dọn compute không dùng, database, load balancer và dữ liệu được giữ lại; kiểm tra các tài nguyên còn tính phí.

## 11. Hồ sơ nộp bài

- [ ] URL ứng dụng và tài khoản demo.
- [ ] Mã nguồn ứng dụng.
- [ ] Mã hạ tầng (Infrastructure as Code).
- [ ] Seed data và kiểm thử.
- [ ] Pipeline CI/CD.
- [ ] Sơ đồ kiến trúc thực tế.
- [ ] Báo cáo thiết kế ngắn.
- [ ] Bằng chứng giám sát, sự cố và khôi phục.
- [ ] Ước tính chi phí mỗi tháng theo workload.
- [ ] Hướng dẫn dọn tài nguyên.
- [ ] Demo 10–15 phút: luồng bình thường, kiểm thử tính đúng đắn quan trọng, sự cố và khôi phục.

## 12. Tiêu chí chấm điểm

| Hạng mục                         | Tỷ trọng |
| -------------------------------- | -------: |
| Kiến trúc và giải thích lựa chọn |      25% |
| Triển khai và tự động hóa        |      20% |
| Bảo mật và tính đúng đắn         |      15% |
| Độ tin cậy và khả năng quan sát  |      15% |
| Mức độ hoàn thiện ứng dụng       |      15% |
| Phân tích chi phí và trình bày   |      10% |

Cần phân bổ thời gian cho kiến trúc, tự động hóa và bằng chứng kiểm thử bên cạnh giao diện và chức năng.

## 13. Kế hoạch thực hiện

### Mốc thời gian gợi ý trong đề

| Giai đoạn        | Nội dung                                                   |
| ---------------- | ---------------------------------------------------------- |
| Tuần 1–2         | Chốt phạm vi, mô hình dữ liệu, kiến trúc và ngân sách      |
| Tuần 3–4         | Hoàn thành ứng dụng chạy xuyên suốt trên cloud             |
| Tuần 5–6         | Tự động hóa, bảo mật và kiểm thử sự cố                     |
| Tuần 7–8, nếu có | Thu thập bằng chứng hiệu năng, hoàn thiện tài liệu và demo |

### Thứ tự triển khai đề xuất

1. Chốt cloud, ngân sách, phân quyền và mô hình phiên bản bài viết.
2. Hoàn thành luồng tạo nháp → duyệt → xuất bản → đọc bài trên cloud.
3. Bổ sung upload ảnh, danh mục và lịch sử xuất bản.
4. Cấu hình cache, kiểm tra giới hạn 60 giây và đo hiệu quả giảm tải.
5. Hoàn thiện IaC, CI/CD, rollback, dashboard và cảnh báo.
6. Chạy kiểm thử, lưu bằng chứng và chuẩn bị demo.

## 14. Phần mở rộng

**Tùy chọn được nêu trong đề:** hẹn giờ xuất bản với scheduler có thể chạy lặp lại an toàn và chỉ tạo một bản ghi xuất bản cho lần xuất bản dự kiến.

Bình luận, lượt thích, chat, email và tìm kiếm nâng cao không được nêu là yêu cầu bắt buộc. Chỉ nên bổ sung sau khi hoàn thành phạm vi chính.
