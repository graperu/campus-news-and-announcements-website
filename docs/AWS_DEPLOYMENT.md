# Triển khai AWS

**Chưa triển khai:** chủ dự án cho biết đã đăng ký AWS; cần xác minh phiên đăng nhập CLI và quyền thực tế trước khi tạo tài nguyên. Terraform validate thành công không chứng minh IAM, quota, region tier hoặc tài nguyên thật đã sẵn sàng.

## Điều kiện

* AWS account và phương thức đăng nhập hợp lệ do chủ tài khoản tự thiết lập.
* Quyền tạo VPC, CloudFront VPC origin, ECS/Fargate, ECR, RDS PostgreSQL, S3, Cognito, Secrets Manager, IAM/OIDC, SNS, CloudWatch và Budgets.
* AWS CLI, Terraform >= 1.9, Docker hoặc CI runner có Docker.
* Region mặc định sydney (`ap-southeast-2`), CloudFront alarm ở `us-east-1`.
* Kiểm tra quota SG (CloudFront prefix list có trọng số), Fargate task, RDS, VPC origin và hỗ trợ dịch vụ trong tài khoản học tập.

AWS CLI v2 hỗ trợ đăng nhập bằng trình duyệt và phiên truy cập tạm thời:

```powershell

aws login --profile uth-campus-project --region ap-southeast-2

$env:AWS_PROFILE='uth-campus-project'

aws sts get-caller-identity
```

Chủ tài khoản tự xác nhận đăng nhập trong trình duyệt. Không gửi mật khẩu, OTP hoặc access key vào chat. Xem [hướng dẫn đăng nhập CLI của AWS](https://docs.aws.amazon.com/signin/latest/userguide/command-line-sign-in.html). Kiểm tra plan/credit của tài khoản trước khi apply; không tự nâng cấp sang Paid plan. Budget là cảnh báo, không phải giới hạn chi tiêu cứng.

Trên Windows, có thể chạy `scripts\aws\login.cmd` từ CMD. Script dùng AWS CLI v2 đã cài trên máy hoặc bản công cụ cục bộ của dự án, đăng nhập vào profile `uth-campus-project` ở Sydney (`ap-southeast-2`) bằng chế độ `--remote`. Mở URL AWS hiện trong CMD, chấp thuận truy cập rồi dán mã ủy quyền từ AWS vào chính cửa sổ CMD đó. Không gửi mã vào chat. Sau đăng nhập, script gọi STS để xác minh danh tính; các lệnh triển khai tiếp theo dùng profile này.

Không cần mua domain: người dùng truy cập domain HTTPS do CloudFront cấp. ALB là internal trong private subnets qua CloudFront VPC origin.

## Bootstrap hạ tầng

1. `aws sts get-caller-identity` để kiểm tra đúng account.
2. Sao chép `infra/aws/terraform.tfvars.example` thành `terraform.tfvars` và điền email cảnh báo thật, image tag sẽ dùng. File này bị Git ignore.
3. Chọn backend Terraform có mã hóa và locking cho làm việc nhóm. State chứa secret và không được commit. Cấu hình mặc định dùng state local để chưa đòi sẵn bucket backend.
4. Chạy `terraform -chdir=infra/aws init`, `terraform -chdir=infra/aws validate` và `terraform -chdir=infra/aws plan`.
5. Lập plan rồi bootstrap riêng ECR và quyền đẩy image bằng `terraform -chdir=infra/aws apply -target=aws_ecr_repository.app -target=aws_iam_role_policy.image_publish`. Bước này tạo cả GitHub OIDC role nhưng chưa cần ECS/RDS. Đây là bước có chủ đích để tạo nơi nhận image trước khi ECS khởi động, không dùng target làm quy trình cập nhật thông thường.
6. Lấy repository URL và deploy role ARN từ output. Đặt ba GitHub repository variables `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`. Chạy thủ công workflow **Build initial AWS image** (`build-aws-image.yml`) trên `main`; workflow kiểm thử, build Docker và đẩy image với tag bằng commit SHA. Cách này không yêu cầu Docker trên máy Windows. Nếu đã có Docker, có thể build/push cục bộ thay cho workflow.
7. Đặt `image_tag` bằng đúng SHA đã build thành công. Chạy full `terraform plan`, rà soát chi phí và các thay đổi; sau đó full `terraform apply`.

CloudFront VPC origin có thể mất nhiều phút để chuyển trạng thái deployed. Chờ ECS healthy, kiểm tra `/health`, đăng nhập và public API qua URL CloudFront.

## Dữ liệu và tài khoản thật

* Chạy một ECS task từ task definition ứng dụng, cùng security group/subnet, override command thành `node scripts/data/restore-source.mjs`. Task nhận DATABASE_URL từ Secrets Manager; không cần đưa DB ra Internet để seed.
* Snapshot chứa 30 tin có tóm tắt đã đối chiếu nguồn, 20 liên kết PDF gốc và 5 chuyên mục. Không chứa người dùng hay mật khẩu.
* Tạo người dùng quản trị đầu tiên trong Cognito bằng email chủ dự án, thêm vào group `editor`; chủ tài khoản tự đặt mật khẩu qua luồng Cognito. Không sao chép mật khẩu local lên AWS.
* Sau đó editor có thể mời tác giả/người đọc qua mục Quản lý. Cognito gửi email mời; task role chỉ được tạo user và thêm group trong user pool của dự án.
* Xác nhận email đăng ký SNS để nhận alert.

## CI/CD qua GitHub OIDC

Nếu AWS account đã có GitHub OIDC provider, truyền ARN vào `github_oidc_provider_arn` để tái sử dụng.

Thiết lập GitHub repository variables từ Terraform outputs:

|Variable|Giá trị|
|-|-|
|`AWS_REGION`|Region triển khai|
|`AWS_DEPLOY_ROLE_ARN`|`deploy_role_arn`|
|`ECR_REPOSITORY`|`ecr_repository`|
|`ECS_CLUSTER`|`cluster`|
|`ECS_SERVICE`|`service`|
|`ECS_TASK_FAMILY`|`task_family`|

Trust policy chỉ nhận OIDC của repo dự án trên nhánh `main`. Không lưu access key dài hạn trong GitHub. CI kiểm thử SQLite, PostgreSQL, browser workflow, Terraform validate và build container. Deployment chạy thủ công; rollback bằng image tag cũ.

## Hoàn tất nghiệm thu

Thực hiện toàn bộ checklist trong `docs/ACCEPTANCE.md`, lưu URL ứng dụng, tài khoản thực tế, run URL CI/CD, sơ đồ triển khai có định danh tài nguyên, bằng chứng đo cache/freshness, alert và failure/recovery. Cập nhật báo cáo chi phí bằng bảng giá/workload lúc triển khai.

Khi cập nhật hạ tầng sau một lần deploy qua GitHub, đồng bộ `image_tag` với image đang sử dụng trước khi apply để tránh Terraform đưa service về image bootstrap cũ.
