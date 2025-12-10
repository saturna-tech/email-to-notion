output "function_name" {
  description = "Name of the deployed Lambda function"
  value       = aws_lambda_function.main.function_name
}

output "log_group" {
  description = "CloudWatch log group for Lambda"
  value       = aws_cloudwatch_log_group.lambda.name
}

# SES Outputs
output "ses_verification_token" {
  description = "TXT record value for SES domain verification (add to DNS)"
  value       = var.ses_enabled ? aws_ses_domain_identity.main[0].verification_token : null
}

output "ses_inbox_address" {
  description = "Email address to forward emails to (SES)"
  value       = var.ses_enabled ? "notion-${var.inbox_secret}@${var.email_domain}" : null
  sensitive   = true
}

output "email_bucket" {
  description = "S3 bucket for raw email storage"
  value       = var.ses_enabled ? aws_s3_bucket.emails[0].id : null
}

output "ses_mx_record" {
  description = "MX record to add to DNS for SES email receiving"
  value       = var.ses_enabled ? "10 inbound-smtp.${data.aws_region.current.name}.amazonaws.com" : null
}
