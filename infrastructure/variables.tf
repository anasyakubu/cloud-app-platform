variable "aws_region" {
  type = string
  default = "eu-west-1"
}

variable "name" {
  type = string
  default = "cloudstream"
}

variable "frontend_url" {
  type = string
  description = "Exact Vercel/custom frontend URL used for S3 CORS"
}

variable "backend_ami_id" {
  type = string
  description = "Ubuntu 24.04 x86_64 official AMI in the target region for API and worker"
}

variable "backend_instance_type" {
  type = string
  default = "t3.medium"
}

variable "worker_instance_type" {
  type = string
  default = "t3.large"
}

variable "execution_ami_id" {
  type = string
  description = "Private golden AMI built with scripts/prepare-executor-ami.sh"
}

variable "execution_volume_size" {
  type = number
  default = 40
}
