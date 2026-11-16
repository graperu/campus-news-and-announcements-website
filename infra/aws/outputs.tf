output "application_url" {
  value = "https://${aws_cloudfront_distribution.app.domain_name}"
}
output "ecr_repository" {
  value = aws_ecr_repository.app.repository_url
}
output "cluster" {
  value = aws_ecs_cluster.app.name
}
output "service" {
  value = aws_ecs_service.app.name
}
output "task_family" {
  value = aws_ecs_task_definition.app.family
}
output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
output "cognito_pool_id" {
  value = aws_cognito_user_pool.users.id
}
output "dashboard" {
  value = aws_cloudwatch_dashboard.app.dashboard_name
}
