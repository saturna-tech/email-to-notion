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

resource "aws_ssm_parameter" "postmark_server_token" {
  name        = "/email-to-notion/postmark-server-token"
  description = "Postmark server API token for sending emails"
  type        = "SecureString"
  value       = var.postmark_server_token
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
      aws_ssm_parameter.postmark_server_token.arn,
      aws_ssm_parameter.anthropic_api_key.arn,
      aws_ssm_parameter.summary_prompt.arn,
    ]
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
      NODE_ENV = "production"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda
  ]
}

# -----------------------------------------------------------------------------
# Lambda Function URL
# -----------------------------------------------------------------------------

resource "aws_lambda_function_url" "webhook" {
  function_name      = aws_lambda_function.main.function_name
  authorization_type = "NONE"
}
