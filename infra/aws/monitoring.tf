resource "aws_sns_topic" "alerts" {
  provider = aws.edge
  name     = "${local.prefix}-alerts"
}
resource "aws_sns_topic_subscription" "alerts" {
  provider  = aws.edge
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
resource "aws_cloudwatch_metric_alarm" "origin" {

  provider            = aws.edge
  alarm_name          = "${local.prefix}-origin-failure"
  alarm_description   = "CloudFront 5xx >= 5% for 2 consecutive 1-minute periods. First action: inspect ECS service events / target health; restore last healthy task revision."
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  dimensions          = { DistributionId = aws_cloudfront_distribution.app.id, Region = "Global" }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

}
resource "aws_cloudfront_monitoring_subscription" "app" {

  distribution_id = aws_cloudfront_distribution.app.id
  monitoring_subscription {
    realtime_metrics_subscription_config {
      realtime_metrics_subscription_status = "Enabled"
    }
  }

}
resource "aws_cloudwatch_dashboard" "app" {

  dashboard_name = local.prefix
  dashboard_body = jsonencode({ widgets = [
    { type = "metric", x = 0, y = 12, width = 12, height = 6, properties = { title = "Public reads p95 (defined script sample, ms)", region = var.region, period = 60, stat = "Average", metrics = [["CampusNews", "PublicReadP95Ms", "Deployment", local.prefix]] } },
    { type = "metric", x = 12, y = 12, width = 12, height = 6, properties = { title = "Publication freshness lag (ms)", region = var.region, period = 60, stat = "Maximum", metrics = [["CampusNews", "PublicationFreshnessLagMs", "Deployment", local.prefix]] } },
    { type = "metric", x = 0, y = 0, width = 12, height = 6, properties = { title = "CloudFront cache hit / 5xx (%)", region = "us-east-1", period = 60, stat = "Average", metrics = [
      ["AWS/CloudFront", "CacheHitRate", "DistributionId", aws_cloudfront_distribution.app.id, "Region", "Global"],
    ["AWS/CloudFront", "5xxErrorRate", "DistributionId", aws_cloudfront_distribution.app.id, "Region", "Global"]] } },
    { type = "metric", x = 12, y = 0, width = 12, height = 6, properties = { title = "Origin requests (ALB, all routes)", region = var.region, period = 60, stat = "Sum", metrics = [["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.app.arn_suffix]] } },
    { type = "metric", x = 0, y = 6, width = 12, height = 6, properties = { title = "Origin response p95 (seconds)", region = var.region, period = 60, stat = "p95", metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.app.arn_suffix]] } },
    { type = "text", x = 12, y = 6, width = 12, height = 6, properties = { markdown = "Public read p95 and publication freshness are measured end-to-end by scripts/measure-cache.mjs. ALB requests include health/UI/API traffic; use request-ID logs and controlled workload for article-only origin counts. See docs/OPERATIONS.md for drill and recovery." } }
  ] })

}
resource "aws_budgets_budget" "monthly" {

  name         = "${local.prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

}
