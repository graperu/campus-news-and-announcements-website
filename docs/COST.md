# Dự toán chi phí AWS

Region **Singapore (`ap-southeast-1`)**. Bảng giá được truy xuất trực tiếp từ AWS Price List API trong lần xây dựng dự án ngày **16/11/2026**; SKU, đơn giá và thời điểm truy xuất lưu trong `evidence/cost-estimate.json`. Đây là dự toán, chưa có tài nguyên triển khai hoặc hóa đơn thực tế.

## Workload giả định để tính ngân sách

- 730 giờ/tháng, 1 Fargate task Linux x86: 0.25 vCPU, RAM 0.5 GB.
- RDS PostgreSQL `db.t4g.micro`, Single-AZ, 20 GB gp3, backup retention 7 ngày.
- ALB 730 giờ, trung bình 1 LCU trong tháng.
- 1 GB ảnh S3, 100.000 public request/tháng, 10 GB egress, 1 GB log.
- CloudFront VPC origin + internal ALB; task có public IPv4 để truy cập dịch vụ ngoài subnet mà không dùng NAT Gateway.
- Không trừ free tier, credit hoặc ưu đãi tài khoản sinh viên.

Các con số workload là **giả định lập ngân sách**, không phải thống kê người dùng giả trên giao diện.

## Phần có đơn giá truy xuất và công thức

| Thành phần     | Công thức                                | USD/tháng |
| -------------- | ---------------------------------------- | --------: |
| Fargate        | `730 × (0.25 × 0.05056 + 0.5 × 0.00553)` |     11.25 |
| ALB            | `730 × 0.0252`                           |     18.40 |
| ALB capacity   | `730 × 1 LCU × 0.008`                    |      5.84 |
| RDS PostgreSQL | `730 × 0.025`                            |     18.25 |
| RDS gp3        | `20 GB × 0.138`                          |      2.76 |
| **Subtotal**   | Tổng trước làm tròn                      | **56.49** |

Dự phòng kế hoạch **30 USD/tháng** cho public IPv4, S3, ECR, CloudFront request/egress, log, dashboard, metric bổ sung, Secrets Manager, Cognito/SNS và backup vượt dung lượng miễn phí nếu có. Đây là khoản dự phòng, không phải bảng giá đã xác minh cho từng dịch vụ phụ.

**Ngân sách kế hoạch: khoảng 86.49 USD/tháng, chưa thuế.** Cần điền từng dịch vụ phụ trong AWS Pricing Calculator trước khi triển khai để chốt tổng chi phí; không coi subtotal là toàn bộ hóa đơn.

## Kiểm soát chi phí

- Terraform giới hạn desired count 0–2 và storage tối đa 25 GB. Mặc định 1 task; chưa có autoscaling tự động.
- Budget notification chỉ là cảnh báo, không khóa chi tiêu.
- Giới hạn thời gian và tốc độ test; đo 200 + 200 request có warmup thay vì để tải chạy vô hạn.
- Có thể giảm thời gian bật môi trường cloud để demo, nhưng tắt task vẫn còn phí RDS/ALB/storage. RDS stopped có giới hạn thời gian và backup vẫn có thể phát sinh phí.
- Tránh NAT Gateway trong cấu hình lớp học; không tuyên bố task nằm trong private subnet.
- Xóa tài nguyên sau thời hạn giữ dữ liệu, kiểm tra snapshot, object versions, image và log còn tính phí.
- Re-price khi đổi region, instance tier, số task, workload hoặc ngày triển khai.

## Cập nhật dự toán

```powershell
node scripts/aws/estimate-cost.mjs
```

Script thất bại nếu không xác định đúng một SKU cho từng đơn giá; không tự thay bằng giá giả. Sau khi chạy, cập nhật bảng này nếu các đơn giá thay đổi.

Nguồn: [AWS ECS Price List Singapore](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-southeast-1/index.json), [AWS ELB Price List Singapore](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/ap-southeast-1/index.json), [AWS RDS Price List Singapore](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-southeast-1/index.json), [AWS Pricing Calculator](https://calculator.aws/).
