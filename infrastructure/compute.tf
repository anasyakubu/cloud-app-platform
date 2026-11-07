resource "aws_instance" "api" {

  ami = var.backend_ami_id
  instance_type = var.backend_instance_type
  subnet_id = aws_subnet.public.id
  associate_public_ip_address = true
  vpc_security_group_ids = [aws_security_group.api.id]
  iam_instance_profile = aws_iam_instance_profile.api.name
  metadata_options {
    http_endpoint = "enabled"
    http_tokens = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted = true
    delete_on_termination = true
  }

  tags = {
    Name = "${var.name}-api"
  }

}

resource "aws_eip" "api" {
  instance = aws_instance.api.id
  domain = "vpc"
}

resource "aws_instance" "worker" {

  ami = var.backend_ami_id
  instance_type = var.worker_instance_type
  subnet_id = aws_subnet.private.id
  associate_public_ip_address = false
  vpc_security_group_ids = [aws_security_group.worker.id]
  iam_instance_profile = aws_iam_instance_profile.worker.name
  metadata_options {
    http_endpoint = "enabled"
    http_tokens = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 50
    volume_type = "gp3"
    encrypted = true
    delete_on_termination = true
  }

  tags = {
    Name = "${var.name}-worker"
  }

}
