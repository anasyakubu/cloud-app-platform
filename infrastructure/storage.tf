resource "random_id" "bucket" {
  byte_length = 4
}

resource "aws_s3_bucket" "apps" {
  bucket = "${var.name}-applications-${random_id.bucket.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "apps" {
  bucket = aws_s3_bucket.apps.id
  block_public_acls = true
  ignore_public_acls = true
  block_public_policy = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "apps" {
  bucket = aws_s3_bucket.apps.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

  }

}

resource "aws_s3_bucket_versioning" "apps" {
  bucket = aws_s3_bucket.apps.id
  versioning_configuration {
    status = "Suspended"
  }

}

resource "aws_s3_bucket_cors_configuration" "apps" {
  bucket = aws_s3_bucket.apps.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT","GET","HEAD"]
    allowed_origins = distinct(concat([var.frontend_url], var.additional_frontend_urls))
    expose_headers = ["ETag"]
    max_age_seconds = 3000
  }

}

resource "aws_s3_bucket_lifecycle_configuration" "apps" {
  bucket = aws_s3_bucket.apps.id
  rule {
    id = "abort-incomplete-uploads"
    status = "Enabled"
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }

    filter {

    }

  }

}

resource "aws_sqs_queue" "dlq" {
  name = "${var.name}-jobs-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled = true
}

resource "aws_sqs_queue" "jobs" {
  name = "${var.name}-jobs"
  message_retention_seconds = 1209600
  visibility_timeout_seconds = 900
  receive_wait_time_seconds = 20
  sqs_managed_sse_enabled = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5
  }
  )
}

resource "aws_cloudwatch_log_group" "execution" {
  name = "/cloudstream/execution"
  retention_in_days = 14
}
