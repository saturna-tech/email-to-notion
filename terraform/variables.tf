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

variable "postmark_server_token" {
  description = "Postmark Server API token for sending notification emails"
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
