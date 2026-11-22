resource "random_password" "origin" {
  length  = 40
  special = false
}
resource "aws_subnet" "origin" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.${count.index + 20}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]
}
resource "aws_lb" "app" {
  name               = local.prefix
  internal           = true
  load_balancer_type = "application"
  subnets            = aws_subnet.origin[*].id
  security_groups    = [aws_security_group.alb.id]
}
resource "aws_lb_target_group" "app" {
  name        = local.prefix
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/health"
    matcher = "200"
  }
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "403"
      message_body = "Forbidden"
    }
  }
}
resource "aws_lb_listener_rule" "cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin.result]
    }
  }
}
resource "aws_cloudfront_vpc_origin" "app" {
  vpc_origin_endpoint_config {
    name                   = local.prefix
    arn                    = aws_lb.app.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
  depends_on = [aws_lb_listener.http, aws_vpc_security_group_ingress_rule.edge, aws_internet_gateway.main]
}
resource "aws_cloudfront_cache_policy" "public" {

  name        = "${local.prefix}-public-30s"
  min_ttl     = 0
  default_ttl = 30
  max_ttl     = 30
  parameters_in_cache_key_and_forwarded_to_origin {

    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "all"
    }

  }

}
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}
data "aws_cloudfront_origin_request_policy" "viewer" {
  name = "Managed-AllViewerExceptHostHeader"
}
resource "aws_cloudfront_distribution" "app" {

  enabled     = true
  price_class = "PriceClass_200"
  origin {

    domain_name = aws_lb.app.dns_name
    origin_id   = "app"
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin.result
    }
    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.app.id
    }

  }
  default_cache_behavior {

    target_origin_id         = "app"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.viewer.id
    compress                 = true

  }
  ordered_cache_behavior {

    path_pattern           = "/api/public/*"
    target_origin_id       = "app"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.public.id
    compress               = true

  }
  custom_error_response {
    error_code            = 503
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 502
    error_caching_min_ttl = 0
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }

}
