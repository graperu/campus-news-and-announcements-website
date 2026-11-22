resource "aws_cloudwatch_dashboard" "app" {
  dashboard_name = local.prefix

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Public reads p95 (defined script sample, ms)"
          region  = var.region
          period  = 60
          stat    = "Average"
          metrics = [["CampusNews", "PublicReadP95Ms", "Deployment", local.prefix]]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title   = "Publication freshness lag (ms)"
          region  = var.region
          period  = 60
          stat    = "Maximum"
          metrics = [["CampusNews", "PublicationFreshnessLagMs", "Deployment", local.prefix]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "CloudFront cache hit / 5xx (%)"
          region = "us-east-1"
          period = 60
          stat   = "Average"
          metrics = [
            ["AWS/CloudFront", "CacheHitRate", "DistributionId", aws_cloudfront_distribution.app.id, "Region", "Global"],
            ["AWS/CloudFront", "5xxErrorRate", "DistributionId", aws_cloudfront_distribution.app.id, "Region", "Global"]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "Origin requests (ALB, all routes)"
          region  = var.region
          period  = 60
          stat    = "Sum"
          metrics = [["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.app.arn_suffix]]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Origin response p95 (seconds)"
          region  = var.region
          period  = 60
          stat    = "p95"
          metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.app.arn_suffix]]
        }
      },
      {
        type   = "text"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          markdown = "Public read p95 and publication freshness are measured end-to-end by scripts/metrics/measure-cache.mjs. ALB requests include health/UI/API traffic; use request-ID logs and controlled workload for article-only origin counts. See docs/OPERATIONS.md for drill and recovery."
        }
      }
    ]
  })
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
