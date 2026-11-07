# Deployment — Vercel + native Ubuntu EC2 services (no containers)

Prerequisites: completed Terraform infrastructure and golden AMI described in [AWS_SETUP.md](AWS_SETUP.md), MongoDB Atlas, verified SES sender, Paystack and backend Secrets Manager JSON. Do not deploy unreviewed uploaded code to privileged backend hosts.

## 1. Install native services on the API and worker EC2 instances

From the `infrastructure/` folder:

```bash
API_ID=$(terraform output -raw backend_instance_id)
WORKER_ID=$(terraform output -raw worker_instance_id)
BUCKET=$(terraform output -raw s3_bucket)
aws ssm start-session --target "$API_ID" --region eu-west-1
# in a second terminal: aws ssm start-session --target "$WORKER_ID" --region eu-west-1
```

Neither server needs an inbound SSH port. On each EC2 instance, deploy the source archive from S3 as shown below. Place it in `/opt/cloudstream` and run the setup script **as root**:

```bash
# On local workstation, from project parent:
zip -r cloud-app-platform.zip cloud-app-platform \
  -x '*/node_modules/*' '*/dist/*' '*/.env' '*/.terraform/*' '*/.git/*'
aws s3 cp cloud-app-platform.zip "s3://$BUCKET/deploy/cloud-app-platform.zip"
# On each remote host:
sudo mkdir -p /opt/cloudstream
aws s3 cp s3://YOUR_BUCKET/deploy/cloud-app-platform.zip /tmp/cloud-app-platform.zip
sudo unzip -oq /tmp/cloud-app-platform.zip -d /opt
sudo cp -a /opt/cloud-app-platform/. /opt/cloudstream/
sudo bash /opt/cloudstream/scripts/setup-native-host.sh api # API host ONLY
sudo bash /opt/cloudstream/scripts/setup-native-host.sh worker # Worker host ONLY
```

The copy command leaves `/opt/cloud-app-platform` as a staging folder; delete it after verification. On API and worker, replace placeholders below:

```bash
sudo bash /opt/cloudstream/scripts/load-runtime-secret.sh cloudstream/backend/runtime eu-west-1
sudo chown -R cloudstream:cloudstream /opt/cloudstream
cd /opt/cloudstream/backend
sudo -u cloudstream npm install
sudo -u cloudstream npm run build
```

On API host:

```bash
sudo systemctl enable --now cloudstream-api.service
sudo systemctl status cloudstream-api --no-pager
curl http://127.0.0.1:4000/health
sudo systemctl status guacd --no-pager
```

On worker host:

```bash
sudo systemctl enable --now cloudstream-worker.service
sudo systemctl status cloudstream-worker --no-pager
sudo -u cloudstream clamscan --version
sudo journalctl -u cloudstream-worker -n 100 --no-pager
```

ClamAV database updates must finish before approving uploads; scanner nonzero exit codes fail closed. The native worker is responsible for provision/cleanup and is **not** the EC2 host that executes users' applications. Keep only API+guacd on the API host and worker+ClamAV on the worker host.

## 2. Domain, Nginx, TLS and WebSockets

Point `api.example.com` A record to the API Elastic IP (`terraform output -raw backend_public_ip`). The server listens on loopback, with Nginx as the only public ingress. Install Nginx as provided by `setup-native-host.sh`, then create `/etc/nginx/sites-available/cloudstream`:

```nginx
server {
    listen 80;
    server_name api.example.com;
    client_max_body_size 1m;

    location /guac/ {
        proxy_pass http://127.0.0.1:8081/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Then enable site and obtain a Let's Encrypt certificate (valid DNS and port 80 required):

```bash
sudo ln -s /etc/nginx/sites-available/cloudstream /etc/nginx/sites-enabled/cloudstream
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com --redirect
curl -fsS https://api.example.com/health
```

TLS must be active before browser access. The Guacamole WebSocket ingress uses `wss://api.example.com/guac` in `VITE_STREAMING_BASE_URL` **on the backend**; do not expose 8081, 4822, 5901 or 4000 through a security group.

## 3. Secret configuration

Create a Secrets Manager JSON object from `backend/.env.example` (remove `VITE_*` values other than `VITE_STREAMING_BASE_URL` used by the server). Set these real values:

```text
NODE_ENV=production
MONGODB_URI=mongodb+srv://...
FRONTEND_URL=https://app.example.com
PUBLIC_API_URL=https://api.example.com
VITE_STREAMING_BASE_URL=wss://api.example.com/guac
AWS_S3_BUCKET=<terraform S3 output>
AWS_SQS_QUEUE_URL=<terraform SQS URL>
AWS_EXECUTION_ROLE=<Terraform execution_instance_profile_arn output>
AWS_EXECUTION_SECURITY_GROUP=<Terraform execution_security_group output>
AWS_EXECUTION_SUBNET=<Terraform execution_subnet output>
AWS_EC2_AMI_ID=<real private execution AMI ID>
AWS_REGION=eu-west-1
AWS_STREAMING_CONFIGURATION=guacamole-vnc
GUAC_HOST=127.0.0.1
GUACD_HOST=127.0.0.1
SES_ENABLED=true
SES_FROM_EMAIL=verified-sender@example.com
PAYSTACK_CALLBACK_URL=https://app.example.com/billing
REQUIRE_ADMIN_APPROVAL=true
```

Also provide `PAYSTACK_SECRET_KEY` and four independent random secrets per `AWS_SETUP.md`. IAM instance profiles grant needed AWS permissions; no static access keys. Run `load-runtime-secret.sh` again and restart both systemd services each time the secret changes. Rotating `DATA_ENCRYPTION_KEY` without re-encrypting saved session secrets breaks active connections, so stop all sessions before changing it.

## 4. MongoDB Atlas

Create a cluster with TLS, a separate application DB user and network access restricted to the **API EIP and NAT EIP**. MongoDB transactions require a replica set; Atlas clusters supply this. Use `cloudstream` in the URI database path. Do not use a standalone local mongod for wallet transactions. Store the URI only in Secrets Manager. Ensure indexes are created during the first successful Mongoose connection (`autoIndex` production policy must allow initial indexes, then migrate separately at scale).

## 5. Frontend deployment with Vercel

From a checkout of this project (or an uploaded repository), deploy the `frontend` directory as a Vite app on Vercel. Use `npm install && npm run build`, output `dist`, and provide:

```text
VITE_API_URL=https://api.example.com/api/v1
VITE_STREAMING_BASE_URL=wss://api.example.com/guac
```

The existing `frontend/vercel.json` handles React Router navigation. Set custom domain `app.example.com` with HTTPS. Match the backend's exact `FRONTEND_URL` and Terraform's S3 CORS frontend origin. The access JWT is stored in browser memory, while the refresh credential is an HTTP-only secure cookie set by the API. Prefer frontend/API subdomains of the same registrable domain for cross-browser cookie support.

## 6. First administrator, payments and smoke tests

On the API host, run the one-time admin seed CLI from `/opt/cloudstream/backend` with the secrets-loaded environment. This is not a public registration path:

```bash
sudo -u cloudstream env $(sudo cat /etc/cloudstream/backend.env | xargs) \
  ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='REPLACE-WITH-16+-CHARACTER-SECRET' \
  npm run seed:admin
```

If your secrets contain spaces/shell-sensitive characters, **do not use the `env $(...| xargs)` example**; instead put `ADMIN_EMAIL` and `ADMIN_PASSWORD` in a temporary root-readable env file and invoke `systemd-run --property=EnvironmentFile=/etc/cloudstream/backend.env` or a one-off systemd service as `cloudstream`. Never paste passwords into shared shell histories.

Sign in as admin; add a real offered CPU instance (`t3.large`, if allowed by region and quota) with explicit nonzero NGN price, then enable it. Use Paystack sandbox and a verified SES sender for user verification. Upload a known-working AppImage, review after a completed `clamscan`, top up wallet through Paystack, launch, confirm VM status via the EC2 console, confirm browser input/video, stop, and confirm the VM enters `terminated` and wallet credit is released. Set up CloudWatch and budget alerts before opening registration widely.

## 7. Upgrades and rollback

For deployment changes: stop admission, check currently active sessions, build both projects from a new commit, restart API and worker (native systemd), run database migrations before deploy if schema changes, and keep the previous deploy folder for rollback. For the execution AMI, build a **new versioned private AMI**, update `AWS_EC2_AMI_ID` in Secrets Manager, and never mutate a running user's environment. All session VMs use the AMI ID recorded at launch.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| API `503`, Mongo timeouts | Atlas allowlist includes both EIPs; URI/TLS; secret permissions |
| Login rejects unverified account | SES verified identity and sandbox restrictions, verified link delivered |
| S3 PUT CORS/ETag errors | Exact S3 CORS `allowed_origins`, exposed `ETag`; 8 MiB parts |
| Upload stuck scanning | Worker systemd active, ClamAV signatures, SQS queue/DLQ, native scanner binary |
| Provisioning stuck | EC2 quota/AMI/subnet/SG/worker role, SSM connectivity, cloud-init logs |
| Session never becomes running | Golden AMI native commands, `tigervncserver@:1`, `/run/cloudstream-ready`, SSM `cloudstream-metrics` |
| Black screen / WebSocket close | Nginx `/guac/`, guacd VNC plugin, only-api VNC 5901 SG rule, gateway ticket expiry |
| Balance not credited | Paystack exact NGN amount, callback/reference, signed webhook, `verify` endpoint |
| Orphan EC2 remains | Worker reconciler, SQS DLQ, EC2 SessionId tags, IAM termination permissions |

See also [STREAMING_SETUP.md](STREAMING_SETUP.md) and [SECURITY.md](SECURITY.md).
