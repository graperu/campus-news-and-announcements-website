terraform {

  required_version = ">= 1.9.0"
  required_providers {

    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }

  }

}
provider "aws" {
  region  = var.region
  profile = "uth-campus-project"
}

provider "aws" {
  alias   = "edge"
  region  = "us-east-1"
  profile = "uth-campus-project"
}
variable "region" {
  default = "ap-southeast-2"
}

variable "name" {
  default = "uth-campus"
}

variable "ecr_repository_name" {
  type        = string
  default     = "uth-campus"
  description = "Name of the existing ECR repository."
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
  default = "NguyenPhuongQuyen05/uth-campus-project"
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
