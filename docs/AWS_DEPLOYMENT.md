# Triển khai AWS

**Chưa triển khai:** chủ dự án chưa có tài khoản AWS. Terraform validate thành công không chứng minh IAM, quota, region tier hoặc tài nguyên thật đã sẵn sàng.

## Điều kiện

- AWS account và phương thức đăng nhập hợp lệ do chủ tài khoản tự thiết lập.
- Quyền tạo VPC, CloudFront VPC origin, ECS/Fargate, ECR, RDS PostgreSQL, S3, Cognito, Secrets Manager, IAM/OIDC, SNS, CloudWatch và Budgets.
- AWS CLI, Terraform >= 1.9, Docker hoặc CI runner có Docker.
- Region mặc định Singapore (`ap-southeast-1`), CloudFront alarm ở `us-east-1`.
- Kiểm tra quota SG (CloudFront prefix list có trọng số), Fargate task, RDS, VPC origin và hỗ trợ dịch vụ trong tài khoản học tập.

Không cần mua domain: người dùng truy cập domain HTTPS do CloudFront cấp. ALB là internal trong private subnets qua CloudFront VPC origin.

## Bootstrap hạ tầng

1. `aws sts get-caller-identity` để kiểm tra đúng account.
2. Sao chép `infra/aws/terraform.tfvars.example` thành `terraform.tfvars` và điền email cảnh báo thật, image tag sẽ dùng. File này bị Git ignore.
3. Chọn backend Terraform có mã hóa và locking cho làm việc nhóm. State chứa secret và không được commit. Cấu hình mặc định dùng state local để chưa đòi sẵn bucket backend.
4. Chạy `terraform -chdir=infra/aws init`, `terraform -chdir=infra/aws validate` và `terraform -chdir=infra/aws plan`.
5. Bootstrap riêng ECR bằng `terraform -chdir=infra/aws apply -target=aws_ecr_repository.app`. Đây là bước có chủ đích để tạo nơi nhận image trước khi ECS khởi động, không dùng target làm quy trình cập nhật thông thường.
6. Lấy repository URL từ output. Đăng nhập ECR, build Docker image và push với tag bất biến đã chọn.
7. Chạy full `terraform plan`, rà soát chi phí và các thay đổi; sau đó full `terraform apply`.

CloudFront VPC origin có thể mất nhiều phút để chuyển trạng thái deployed. Chờ ECS healthy, kiểm tra `/health`, đăng nhập và public API qua URL CloudFront.

## Dữ liệu và tài khoản thật

- Chạy một ECS task từ task definition ứng dụng, cùng security group/subnet, override command thành `node scripts/restore-source.mjs`. Task nhận DATABASE_URL từ Secrets Manager; không cần đưa DB ra Internet để seed.
- Snapshot chứa 30 tin dẫn nguồn có thật và 5 chuyên mục. Không chứa người dùng hay mật khẩu.
- Tạo người dùng quản trị đầu tiên trong Cognito bằng email chủ dự án, thêm vào group `editor`; chủ tài khoản tự đặt mật khẩu qua luồng Cognito. Không sao chép mật khẩu local lên AWS.
- Sau đó editor có thể mời tác giả/người đọc qua mục Quản lý. Cognito gửi email mời; task role chỉ được tạo user và thêm group trong user pool của dự án.
- Xác nhận email đăng ký SNS để nhận alert.

## CI/CD qua GitHub OIDC

Nếu AWS account đã có GitHub OIDC provider, truyền ARN vào `github_oidc_provider_arn` để tái sử dụng.

Thiết lập GitHub repository variables từ Terraform outputs:

| Variable              | Giá trị           |
| --------------------- | ----------------- |
| `AWS_REGION`          | Region triển khai |
| `AWS_DEPLOY_ROLE_ARN` | `deploy_role_arn` |
| `ECR_REPOSITORY`      | `ecr_repository`  |
| `ECS_CLUSTER`         | `cluster`         |
| `ECS_SERVICE`         | `service`         |
| `ECS_TASK_FAMILY`     | `task_family`     |

Trust policy chỉ nhận OIDC của repo dự án trên nhánh `main`. Không lưu access key dài hạn trong GitHub. CI kiểm thử SQLite, PostgreSQL, browser workflow, Terraform validate và build container. Deployment chạy thủ công; rollback bằng image tag cũ.

## Hoàn tất nghiệm thu

Thực hiện toàn bộ checklist trong `docs/ACCEPTANCE.md`, lưu URL ứng dụng, tài khoản thực tế, run URL CI/CD, sơ đồ triển khai có định danh tài nguyên, bằng chứng đo cache/freshness, alert và failure/recovery. Cập nhật báo cáo chi phí bằng bảng giá/workload lúc triển khai.
