resource "aws_s3_bucket" "uploads" {
  bucket = "${local.prefix}-uploads"
  tags   = local.tags
}
resource "aws_s3_bucket_public_access_block" "uploads" {

  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

}
resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {

  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

}
resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_db_subnet_group" "database" {
  name       = local.prefix
  subnet_ids = aws_subnet.database[*].id
}
resource "random_password" "database" {
  length  = 32
  special = false
}
resource "aws_db_parameter_group" "database" {
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}
resource "aws_db_instance" "database" {

  identifier                 = local.prefix
  engine                     = "postgres"
  engine_version             = "17"
  instance_class             = "db.t4g.micro"
  multi_az                   = false
  storage_type               = "gp3"
  allocated_storage          = 20
  max_allocated_storage      = 25
  storage_encrypted          = true
  db_name                    = "campus"
  username                   = "campus"
  password                   = random_password.database.result
  db_subnet_group_name       = aws_db_subnet_group.database.name
  vpc_security_group_ids     = [aws_security_group.database.id]
  parameter_group_name       = aws_db_parameter_group.database.name
  publicly_accessible        = false
  backup_retention_period    = 7
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${local.prefix}-final"
  auto_minor_version_upgrade = true
  tags                       = local.tags

}
resource "aws_secretsmanager_secret" "database" {
  name                    = "${local.prefix}/database-url"
  recovery_window_in_days = 7
}
resource "aws_secretsmanager_secret_version" "database" {

  secret_id     = aws_secretsmanager_secret.database.id
  secret_string = "postgresql://campus:${random_password.database.result}@${aws_db_instance.database.endpoint}/campus"

}
data "aws_ecr_repository" "app" {
  name = var.ecr_repository_name
}
