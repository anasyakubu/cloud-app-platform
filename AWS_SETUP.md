# AWS account setup — real infrastructure, no containers

Follow these steps in an AWS account with billing alerts. Default example region is `eu-west-1`; adjust to your selected region. Prices and quotas change: independently verify costs for API EC2, worker EC2, NAT Gateway, public IPv4, S3, EBS, SSM data, CloudWatch and session EC2 before deployment.

## 1. Credentials, AWS CLI and a known Ubuntu image

Do not put static AWS credentials into `.env`. Configure a local AWS CLI profile with permissions to administer Terraform resources, then let EC2 instances assume the attached IAM instance profiles.

```bash
aws sts get-caller-identity
export AWS_REGION=eu-west-1
aws ssm get-parameter \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --region "$AWS_REGION" --query 'Parameter.Value' --output text
```

If the public Canonical SSM parameter is not available in your region, use the **official Canonical Ubuntu 24.04 AMD64** AMI ID from AWS Marketplace/Catalog and verify the publisher. ARM-based AMIs are not supported.

## 2. Terraform VPC + IAM + storage + hosts

Copy and update the variables. During first apply `execution_ami_id` can be a placeholder string because the worker does not launch a session until you set `AWS_EC2_AMI_ID` from the finalized private AMI.

```bash
cd infrastructure
cp terraform.tfvars.example terraform.tfvars
# Edit: region, exact frontend URL, backend_ami_id, execution_ami_id, node instance types
terraform init
terraform fmt
terraform validate
terraform plan
terraform apply
terraform output
```

The plan creates a VPC, public API subnet and private worker/execution subnet, Internet Gateway, NAT Gateway with Elastic IP, S3 VPC gateway endpoint, API/worker/execution security groups, API and worker native EC2, IAM instance profiles, S3 bucket, SQS queue/DLQ, CloudWatch group and an unpopulated Secrets Manager secret.

**Network policy:** no SSH/RDP inbound. API security group opens 80/443 only. Private worker opens no inbound ports. The execution VM allows VNC 5901 from the API security group only. Every session is a distinct private EC2 VM without a public IP. The EC2 workload user is prevented from initiating network connections by on-host iptables rules (see script). SSM uses outbound TLS and its instance role; no SSH keys are needed.

Retrieve Terraform outputs:

```bash
terraform output -raw s3_bucket
terraform output -raw sqs_queue_url
terraform output -raw execution_subnet
terraform output -raw execution_security_group
terraform output -raw execution_instance_profile_arn
terraform output -raw backend_public_ip
terraform output -raw backend_instance_id
terraform output -raw worker_instance_id
terraform output -raw backend_secret_arn
```

## 3. Build the golden native execution AMI

Create a **temporary builder instance** from the same official Ubuntu 24.04 AMD64 base image in the private subnet with the **worker instance profile** (temporarily, for S3 artifact download) and worker security group. Use an appropriate instance size such as `t3.large`. Launch it with the EC2 console or CLI, **without a public IP**, and access it via Systems Manager Session Manager; it must have NAT egress for apt downloads. Do not use an instance used by real users to build AMIs.

Copy the script to an S3 deployment prefix using your local CLI profile:

```bash
BUCKET=$(terraform output -raw s3_bucket)
aws s3 cp ../scripts/prepare-executor-ami.sh "s3://$BUCKET/deploy/prepare-executor-ami.sh"
```

On the builder, after connecting via `aws ssm start-session --target i-BUILDER`, download and run:

```bash
aws s3 cp s3://YOUR_BUCKET/deploy/prepare-executor-ami.sh /tmp/prepare-executor-ami.sh
sudo bash /tmp/prepare-executor-ami.sh
sudo systemctl status cloudstream-firewall.service --no-pager || true
sudo test -x /usr/local/sbin/cloudstream-boot
sudo test -x /usr/local/bin/cloudstream-metrics
```

The script installs Xfce, TigerVNC, AppImage FUSE compatibility libraries, systemd native application service, ClamAV-independent runtime, UID egress firewall, CloudWatch Agent and SSM-ready system services. Before snapshotting, reboot and confirm health. Then from your workstation:

```bash
aws ec2 create-image --instance-id i-BUILDER \
  --name cloudstream-execution-ubuntu2404-v1 --no-reboot \
  --region "$AWS_REGION" --query ImageId --output text
aws ec2 wait image-available --image-ids ami-NEW-IMAGE --region "$AWS_REGION"
```

Use `--no-reboot` only if you have quiesced the builder and accept crash-consistent imaging; a normal reboot-based image is safer. Restrict AMI launch permissions to your account and never share it publicly. Terminate the builder after validating the AMI. Set `execution_ami_id` in `terraform.tfvars` and apply again to update the recorded output. **Set `AWS_EC2_AMI_ID` to the actual created AMI ID** in Secrets Manager. Do not set it to the ordinary Ubuntu base AMI: the runtime bootstrap would fail.

### Native runtime compatibility note

The script expects Ubuntu 24.04 `tigervncserver@:1.service` and `tigervncpasswd`. Verify packages and service names with `systemctl cat tigervncserver@:1.service` and `command -v tigervncpasswd` on the builder. If the package variant uses a different VNC binary or systemd unit, adjust and rebuild the AMI. Always perform a known-good graphical AppImage test before admitting customer applications.

## 4. S3 and multipart upload CORS

Terraform configures SSE-S3 encryption, blocks all public access, disallows public ACL/policy, enables `PUT`/`GET`/`HEAD` CORS from **exact `frontend_url`** and exposes the crucial `ETag` response header for S3 multipart parts. The UI issues concurrent 8 MiB presigned PUTs directly to S3, then submits ordered ETags to the backend to complete the multipart upload. The backend validates final S3 object size. Interrupted uploads are aborted by worker/lifecycle (after 2 days).

Browser CORS issues almost always indicate an incorrect exact frontend origin or absent `ETag` exposure; inspect the bucket CORS config:

```bash
aws s3api get-bucket-cors --bucket YOUR_BUCKET
aws s3api get-public-access-block --bucket YOUR_BUCKET
```

## 5. SQS jobs and worker

A real SQS standard queue handles `scan`, `launch`, and `stop` jobs. A dedicated worker EC2 (outside the API) runs `npm run start:worker` via systemd; it uses **ClamAV** and `scripts/scan-package.py` on untrusted bytes, not native application execution. Failed messages retry and are moved to the configured DLQ after five receives. Alerts for DLQ growth are recommended. Avoid running the worker in two roles simultaneously until you have confirmed idempotency and capacity.

## 6. Secrets Manager

Terraform provisions `cloudstream/backend/runtime` with no value. **Populate it yourself** from a local JSON file stored only on your secure administrator machine:

```bash
# Create backend-runtime.json from backend/.env.example, as a JSON mapping of strings.
# IMPORTANT: do not commit or include this file in the source ZIP.
aws secretsmanager put-secret-value \
  --secret-id cloudstream/backend/runtime \
  --secret-string file://backend-runtime.json \
  --region "$AWS_REGION"
```

Required fields include `MONGODB_URI`, JWT secrets, `DATA_ENCRYPTION_KEY` (64 hex characters), `GUAC_TOKEN_KEY` (64 hex characters), `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_SQS_QUEUE_URL`, execution profile ARN/security group/subnet/AMI, `FRONTEND_URL`, Paystack key, SES identity and streaming public WebSocket address. Generate secrets independently:

```bash
openssl rand -hex 32  # 64-hex AES/GCM encryption key
openssl rand -hex 32  # another 64-hex Guac token key
openssl rand -hex 48  # JWT secret; repeat for refresh secret
```

The IAM roles on API and worker have only secret-read permission for this ARN. The native script `scripts/load-runtime-secret.sh` writes a root-only `/etc/cloudstream/backend.env` (systemd `EnvironmentFile` format) from the actual Secrets Manager JSON. Do not put secrets into browser `VITE_*` variables, cloud-init execution user data, Git, CloudWatch text logs or Terraform state values.

## 7. SES, Atlas, Paystack and webhooks

Verify `SES_FROM_EMAIL` with SES and move beyond the SES sandbox before emailing new arbitrary customer addresses. Set `SES_ENABLED=true` to deliver login verification and password reset messages. Without SES setup, registration cannot be completed by normal users (a security feature, not a mock email service).

Create a MongoDB Atlas replica set deployment for transactions. Allowlist the API Elastic IP and NAT Elastic IP; require TLS and strong Atlas users. In production prefer private networking/PrivateLink if available and appropriate for your Atlas plan.

Use Paystack test mode first. The server initializes payments using secret keys only, verifies exact NGN/kobo amount server-side and validates `x-paystack-signature` SHA-512 webhook HMAC. Configure Paystack webhook URL as `https://api.example.com/api/v1/billing/webhook` and callback as `https://app.example.com/billing`. Top-up transactions are idempotently credited only once.

## 8. Cost and quota guardrails

Set EC2 On-Demand vCPU quotas, budgets and billing alarms, restrict the admin machine catalog to permitted CPU types, and keep `DEFAULT_MAX_SESSION_MINUTES` low. Only add EC2 instance types offered in the selected region (the admin API calls actual `DescribeInstanceTypes` and `DescribeInstanceTypeOfferings`). **Regional offering does not guarantee available capacity**; launches may still fail if quotas/capacity are exhausted. By design the supplied API rejects GPU configurations until a driver-enabled GPU AMI is built. Confirm that the actual AMI is x86_64-compatible with the selected EC2 type.

Session worker polls EC2 + SSM and terminates timeout/idle sessions. An orphan scan finds tagged resources not registered in MongoDB and terminates after a conservative grace period. App files are removed from S3 after a seven-day application deletion grace. A root EBS volume is encrypted and deleted on EC2 termination. Also set CloudWatch alarms for worker health, failed EC2 launches, DLQ messages, unexpected NAT/EBS charges and sustained instance count.
