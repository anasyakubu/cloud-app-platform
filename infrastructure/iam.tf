data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }

  }

}

resource "aws_secretsmanager_secret" "backend" {
  name = "${var.name}/backend/runtime"
  recovery_window_in_days = 7
}

resource "aws_iam_role" "api" {
  name = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_instance_profile" "api" {
  name = "${var.name}-api-profile"
  role = aws_iam_role.api.name
}

resource "aws_iam_role_policy_attachment" "api_ssm" {
  role = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "api" {
  name = "${var.name}-api-svc"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17",Statement = [
    {
      Effect = "Allow",Action = ["s3:PutObject","s3:GetObject","s3:AbortMultipartUpload"],Resource = "${aws_s3_bucket.apps.arn}/applications/*"
    }
    ,
    {
      Effect = "Allow",Action = ["s3:GetObject"],Resource = "${aws_s3_bucket.apps.arn}/deploy/*"
    }
    ,
    {
      Effect = "Allow",Action = ["s3:ListBucketMultipartUploads"],Resource = aws_s3_bucket.apps.arn
    }
    ,
    {
      Effect = "Allow",Action = ["sqs:SendMessage"],Resource = aws_sqs_queue.jobs.arn
    }
    ,
    {
      Effect = "Allow",Action = ["ec2:DescribeInstanceTypes","ec2:DescribeInstanceTypeOfferings"],Resource = "*"
    }
    ,
    {
      Effect = "Allow",Action = ["logs:FilterLogEvents"],Resource = "${aws_cloudwatch_log_group.execution.arn}:*"
    }
    ,
    {
      Effect = "Allow",Action = ["ses:SendEmail","ses:SendRawEmail"],Resource = "*"
    }
    ,
    {
      Effect = "Allow",Action = ["secretsmanager:GetSecretValue"],Resource = aws_secretsmanager_secret.backend.arn
    }

    ]
  }
  )
}

resource "aws_iam_role" "worker" {
  name = "${var.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_instance_profile" "worker" {
  name = "${var.name}-worker-profile"
  role = aws_iam_role.worker.name
}

resource "aws_iam_role_policy_attachment" "worker_ssm" {
  role = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "worker" {
  name = "${var.name}-worker-svc"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17",Statement = [
    {
      Effect = "Allow",Action = ["s3:GetObject","s3:DeleteObject","s3:AbortMultipartUpload"],Resource = "${aws_s3_bucket.apps.arn}/applications/*"
    }
    ,
    {
      Effect = "Allow",Action = ["s3:GetObject"],Resource = "${aws_s3_bucket.apps.arn}/deploy/*"
    }
    ,
    {
      Effect = "Allow",Action = ["sqs:SendMessage","sqs:ReceiveMessage","sqs:DeleteMessage","sqs:ChangeMessageVisibility","sqs:GetQueueAttributes"],Resource = aws_sqs_queue.jobs.arn
    }
    ,
    {
      Effect = "Allow",Action = ["ec2:RunInstances","ec2:CreateTags","ec2:DescribeInstances","ec2:DescribeInstanceTypes","ec2:DescribeInstanceTypeOfferings"],Resource = "*"
    }
    ,
    {
      Effect = "Allow",Action = ["ec2:TerminateInstances"],Resource = "arn:aws:ec2:${var.aws_region}:*:instance/*",Condition = {
        StringEquals = {
          "ec2:ResourceTag/Project" = "CloudStream"
        }

      }

    }
    ,
    {
      Effect = "Allow",Action = ["ssm:SendCommand","ssm:GetCommandInvocation"],Resource = "*"
    }
    ,
    {
      Effect = "Allow",Action = ["iam:PassRole"],Resource = aws_iam_role.execution.arn
    }
    ,
    {
      Effect = "Allow",Action = ["secretsmanager:GetSecretValue"],Resource = aws_secretsmanager_secret.backend.arn
    }

    ]
  }
  )
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_instance_profile" "execution" {
  name = "${var.name}-execution-profile"
  role = aws_iam_role.execution.name
}

resource "aws_iam_role_policy_attachment" "execution_ssm" {
  role = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "execution_logs" {
  name = "${var.name}-execution-logs"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17",Statement = [{
      Effect = "Allow",Action = ["logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogStreams"],Resource = "${aws_cloudwatch_log_group.execution.arn}:*"
    }
    ]
  }
  )
}
