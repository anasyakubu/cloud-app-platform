output "s3_bucket" {
  value = aws_s3_bucket.apps.bucket
}

output "sqs_queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "backend_public_ip" {
  value = aws_eip.api.public_ip
}

output "backend_instance_id" {
  value = aws_instance.api.id
}

output "worker_instance_id" {
  value = aws_instance.worker.id
}

output "execution_subnet" {
  value = aws_subnet.private.id
}

output "execution_security_group" {
  value = aws_security_group.execution.id
}

output "execution_instance_profile_arn" {
  value = aws_iam_instance_profile.execution.arn
}

output "execution_ami_id" {
  value = var.execution_ami_id
}

output "nat_eip" {
  value = aws_eip.nat.public_ip
}

output "cloudwatch_log_group" {
  value = aws_cloudwatch_log_group.execution.name
}

output "backend_secret_arn" {
  value = aws_secretsmanager_secret.backend.arn
}
