terraform {

  required_version = ">= 1.9.0"
  required_providers {

    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }

  }

}
provider "aws" {
  region = var.region
}
provider "aws" {
  alias  = "edge"
  region = "us-east-1"

}
variable "region" {
  default = "ap-southeast-1"
}
variable "name" {
  default = "uth-campus"
}
variable "image_tag" {
  type        = string
  description = "Existing immutable ECR image tag. Push the image before creating ECS service."
}
variable "desired_count" {
  default = 1
  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 2
    error_message = "Keep classroom deployment bounded to 0-2 tasks."
  }

}
variable "github_repository" {
  default = "graperu/campus-news-and-announcements-website"
}
variable "github_oidc_provider_arn" {
  type        = string
  default     = ""
  description = "Existing GitHub OIDC provider ARN, if already configured in this AWS account."
}
variable "alert_email" {
  type = string
}
variable "budget_usd" {
  default = 100
}
data "aws_availability_zones" "available" {
  state = "available"
}
data "aws_caller_identity" "current" {

}
resource "random_id" "suffix" {
  byte_length = 4
}
locals {

  prefix = "${var.name}-${random_id.suffix.hex}"
  tags   = { Project = var.name, ManagedBy = "Terraform" }

}
