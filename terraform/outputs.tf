output "webhook_url" {
  description = "URL to configure in Postmark inbound settings"
  value       = aws_lambda_function_url.webhook.function_url
}

output "function_name" {
  description = "Name of the deployed Lambda function"
  value       = aws_lambda_function.main.function_name
}

output "log_group" {
  description = "CloudWatch log group for Lambda"
  value       = aws_cloudwatch_log_group.lambda.name
}
