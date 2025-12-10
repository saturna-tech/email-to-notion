variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "function_name" {
  description = "Name of the Lambda function"
  type        = string
  default     = "email-to-notion"
}

variable "inbox_secret" {
  description = "Secret string for inbox email address (notion-{secret}@domain.com)"
  type        = string
  sensitive   = true
}

variable "allowed_senders" {
  description = "List of email addresses allowed to forward emails"
  type        = list(string)
}

variable "notion_database_id" {
  description = "Notion database ID to store emails"
  type        = string
}

variable "notion_api_key" {
  description = "Notion Integration API key"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude summarization (optional, leave empty to disable)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "summary_prompt" {
  description = "Prompt for email summarization (optional, leave empty to disable)"
  type        = string
  default     = ""
}

variable "email_domain" {
  description = "Domain for receiving emails via SES"
  type        = string
}

variable "ses_enabled" {
  description = "Enable SES email receiving"
  type        = bool
  default     = true
}

variable "email_retention_days" {
  description = "Days to retain raw emails in S3 before deletion"
  type        = number
  default     = 7
}
