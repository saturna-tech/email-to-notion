terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# -----------------------------------------------------------------------------
# S3 Bucket for Raw Emails (SES)
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "emails" {
  count  = var.ses_enabled ? 1 : 0
  bucket = "${var.function_name}-emails-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.function_name}-emails"
  }
}

# Block all public access to the email bucket
resource "aws_s3_bucket_public_access_block" "emails" {
  count  = var.ses_enabled ? 1 : 0
  bucket = aws_s3_bucket.emails[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable server-side encryption for emails at rest
resource "aws_s3_bucket_server_side_encryption_configuration" "emails" {
  count  = var.ses_enabled ? 1 : 0
  bucket = aws_s3_bucket.emails[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "emails" {
  count  = var.ses_enabled ? 1 : 0
  bucket = aws_s3_bucket.emails[0].id

  rule {
    id     = "delete-old-emails"
    status = "Enabled"

    expiration {
      days = var.email_retention_days
    }

    filter {
      prefix = "inbound/"
    }
  }
}

resource "aws_s3_bucket_policy" "emails" {
  count  = var.ses_enabled ? 1 : 0
  bucket = aws_s3_bucket.emails[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSESPut"
        Effect    = "Allow"
        Principal = { Service = "ses.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.emails[0].arn}/inbound/*"
        Condition = {
          StringEquals = {
            "AWS:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.emails[0].arn,
          "${aws_s3_bucket.emails[0].arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# SES Domain Identity
# -----------------------------------------------------------------------------

resource "aws_ses_domain_identity" "main" {
  count  = var.ses_enabled ? 1 : 0
  domain = var.email_domain
}

# -----------------------------------------------------------------------------
# SES Receipt Rule Set
# -----------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "main" {
  count         = var.ses_enabled ? 1 : 0
  rule_set_name = "${var.function_name}-rules"
}

resource "aws_ses_active_receipt_rule_set" "main" {
  count         = var.ses_enabled ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.main[0].rule_set_name
}

resource "aws_ses_receipt_rule" "store_and_process" {
  count         = var.ses_enabled ? 1 : 0
  name          = "${var.function_name}-store-process"
  rule_set_name = aws_ses_receipt_rule_set.main[0].rule_set_name
  enabled       = true
  scan_enabled  = true

  # Filter by recipient - only accept emails to our secret inbox
  recipients = ["notion-${var.inbox_secret}@${var.email_domain}"]

  # First: Store email in S3
  s3_action {
    bucket_name       = aws_s3_bucket.emails[0].id
    object_key_prefix = "inbound/"
    position          = 1
  }

  # Second: Invoke Lambda
  lambda_action {
    function_arn    = aws_lambda_function.main.arn
    invocation_type = "Event"
    position        = 2
  }

  depends_on = [
    aws_s3_bucket_policy.emails,
    aws_lambda_permission.ses
  ]
}

# -----------------------------------------------------------------------------
# Lambda Permission for SES
# -----------------------------------------------------------------------------

resource "aws_lambda_permission" "ses" {
  count          = var.ses_enabled ? 1 : 0
  statement_id   = "AllowSESInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.main.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

# -----------------------------------------------------------------------------
# SSM Parameters
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "inbox_secret" {
  name        = "/email-to-notion/inbox-secret"
  description = "Secret portion of inbox email address"
  type        = "SecureString"
  value       = var.inbox_secret
}

resource "aws_ssm_parameter" "allowed_senders" {
  name        = "/email-to-notion/allowed-senders"
  description = "Comma-separated list of allowed sender emails"
  type        = "StringList"
  value       = join(",", var.allowed_senders)
}

resource "aws_ssm_parameter" "notion_database_id" {
  name        = "/email-to-notion/notion-database-id"
  description = "Notion database ID for storing emails"
  type        = "String"
  value       = var.notion_database_id
}

resource "aws_ssm_parameter" "notion_api_key" {
  name        = "/email-to-notion/notion-api-key"
  description = "Notion integration API key"
  type        = "SecureString"
  value       = var.notion_api_key
}

resource "aws_ssm_parameter" "anthropic_api_key" {
  name        = "/email-to-notion/anthropic-api-key"
  description = "Anthropic API key for Claude summarization"
  type        = "SecureString"
  value       = var.anthropic_api_key != "" ? var.anthropic_api_key : "disabled"
}

resource "aws_ssm_parameter" "summary_prompt" {
  name        = "/email-to-notion/summary-prompt"
  description = "Prompt for AI email summarization"
  type        = "String"
  value       = var.summary_prompt != "" ? var.summary_prompt : "disabled"
}

# -----------------------------------------------------------------------------
# IAM Role for Lambda
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "lambda_permissions" {
  # CloudWatch Logs
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  # SSM Parameter Store - read access
  statement {
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters"
    ]
    resources = [
      aws_ssm_parameter.inbox_secret.arn,
      aws_ssm_parameter.allowed_senders.arn,
      aws_ssm_parameter.notion_database_id.arn,
      aws_ssm_parameter.notion_api_key.arn,
      aws_ssm_parameter.anthropic_api_key.arn,
      aws_ssm_parameter.summary_prompt.arn,
    ]
  }

  # S3 access for SES emails (conditional)
  dynamic "statement" {
    for_each = var.ses_enabled ? [1] : []
    content {
      effect = "Allow"
      actions = [
        "s3:GetObject"
      ]
      resources = ["${aws_s3_bucket.emails[0].arn}/inbound/*"]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.function_name}-policy"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = 14
}

# -----------------------------------------------------------------------------
# Lambda Function
# -----------------------------------------------------------------------------

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_lambda_function" "main" {
  filename         = data.archive_file.lambda.output_path
  function_name    = var.function_name
  role             = aws_iam_role.lambda.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.lambda.output_base64sha256
  runtime          = "nodejs20.x"
  timeout          = 60
  memory_size      = 512

  environment {
    variables = {
      NODE_ENV     = "production"
      EMAIL_BUCKET = var.ses_enabled ? aws_s3_bucket.emails[0].id : ""
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda
  ]
}
