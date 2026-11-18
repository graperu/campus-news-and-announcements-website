resource "aws_cognito_user_pool" "users" {

  name                     = local.prefix
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  admin_create_user_config {
    allow_admin_create_user_only = true
  }
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

}
resource "aws_cognito_user_group" "roles" {
  for_each     = toset(["reader", "author", "editor"])
  name         = each.key
  user_pool_id = aws_cognito_user_pool.users.id
}
resource "aws_cognito_user_pool_domain" "users" {
  domain       = local.prefix
  user_pool_id = aws_cognito_user_pool.users.id
}
resource "aws_cognito_user_pool_client" "web" {

  name                                 = "campus-web"
  user_pool_id                         = aws_cognito_user_pool.users.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile", "aws.cognito.signin.user.admin"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["https://${aws_cloudfront_distribution.app.domain_name}/"]
  logout_urls                          = ["https://${aws_cloudfront_distribution.app.domain_name}/"]
  prevent_user_existence_errors        = "ENABLED"

}
resource "aws_iam_role" "execution" {
  name               = "${local.prefix}-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "secrets" {
  role   = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.database.arn }] })
}
resource "aws_iam_role" "app" {
  name               = "${local.prefix}-app"
  assume_role_policy = aws_iam_role.execution.assume_role_policy
}
resource "aws_iam_role_policy" "uploads" {
  role   = aws_iam_role.app.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.uploads.arn}/*" }] })
}
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.prefix}"
  retention_in_days = 14
}
resource "aws_ecs_cluster" "app" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
resource "aws_ecs_task_definition" "app" {

  family                   = local.prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  container_definitions = jsonencode([{
    name         = "app", image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}", essential = true,
    portMappings = [{ containerPort = 3000, protocol = "tcp" }],
    environment = [
      { name = "NODE_ENV", value = "production" }, { name = "HOST", value = "0.0.0.0" }, { name = "PORT", value = "3000" },
      { name = "DB_SSL", value = "true" },
      { name = "APP_ORIGIN", value = "https://${aws_cloudfront_distribution.app.domain_name}" },
      { name = "UPLOAD_BUCKET", value = aws_s3_bucket.uploads.id },
      { name = "COGNITO_ISSUER", value = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.users.id}" },
      { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.web.id },
      { name = "COGNITO_DOMAIN", value = "https://${aws_cognito_user_pool_domain.users.domain}.auth.${var.region}.amazoncognito.com" }
    ],
    secrets          = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database.arn }],
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = var.region, awslogs-stream-prefix = "app" } }
  }])

}
resource "aws_ecs_service" "app" {

  name                              = local.prefix
  cluster                           = aws_ecs_cluster.app.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener_rule.cloudfront, aws_iam_role_policy.secrets, aws_secretsmanager_secret_version.database]

}
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_role" "deploy" {
  name               = "${local.prefix}-github-deploy"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Federated = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn }, Action = "sts:AssumeRoleWithWebIdentity", Condition = { StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:ref:refs/heads/main" } } }] })
}
resource "aws_iam_role_policy" "image_publish" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"], Resource = aws_ecr_repository.app.arn }
  ] })
}
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"], Resource = "*" },
    { Effect = "Allow", Action = ["ecs:UpdateService", "ecs:DescribeServices"], Resource = aws_ecs_service.app.id },
    { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.app.arn, aws_iam_role.execution.arn], Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } }
  ] })
}

resource "aws_iam_role_policy" "manage_users" {
  role   = aws_iam_role.app.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminGetUser"], Resource = aws_cognito_user_pool.users.arn }] })
}
