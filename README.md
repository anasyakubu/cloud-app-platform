# CloudStream — Native AWS cloud application streaming

CloudStream is an actual **React + Node.js control plane** for uploading supported Linux software to Amazon S3, scanning and approving it, provisioning **one ephemeral EC2 VM per session**, launching the software as a restricted native user, and interacting with the running Xfce desktop over **TigerVNC → guacd → Guacamole protocol/WebSocket → browser**. AWS SDK v3 performs real API operations. There are no simulation endpoints, local desktop execution, or container-based deployment artifacts.

**IMPORTANT — deployment/verification status:** The repository is runnable source, not a deployed service. AWS, Atlas, SES and Paystack credentials, an execution AMI and a public HTTPS domain are not included. The provided environment could not reach the npm registry, so dependency installation, TypeScript dependency type checking, browser compilation and live AWS/Guacamole end-to-end validation have **not** been completed here. Source files passed a TypeScript syntax/transpilation inspection, and packaging/format checks are provided. Before production use, install dependencies, run builds and the integration checklist; follow the security hardening notes. No claim is made that an arbitrary software upload will execute successfully.

## Supported and unsupported runtimes

| Runtime | State | Notes |
|---|---|---|
| Linux x86_64 Type 1/2 `.AppImage` | Supported MVP path | Self-contained GUI apps; may require additional libraries; AppImage extract-and-run mode |
| Linux x86_64 portable `.tar.gz` | Supported MVP path | Regular files and directories only; path to existing native executable required; dependencies must already exist in the base image |
| `.deb`, `.rpm`, install scripts | **Not executed** | Root installer scripts are not accepted; a reviewed installer flow needs separate hardening |
| Windows `.exe` / `.msi` | **Not supported** | Requires Windows AMI and a separately designed remote desktop runtime |
| macOS apps / containers | **Not supported** | No macOS execution or container runtime |
| GPU-accelerated applications | **Not supported in the supplied AMI** | GPU EC2 configurations are deliberately rejected by the admin API until drivers and GPU AMIs are implemented |

App packages are not magically made compatible: the host is Ubuntu 24.04 x86_64, Xfce with X11, no external network access from the `streamer` UID, and a read-only system with constrained application service access. Programs depending on proprietary services, network connectivity, kernel modules, extra libraries, privileged install steps, or special licenses may fail.

## Execution architecture

```text
Browser: React/TypeScript, guacamole-common-js
   | HTTPS: JSON APIs (Bearer access token, rotated HTTP-only refresh cookie)
   v
Nginx TLS -> Express/Node.js API on EC2 (127.0.0.1:4000)
   |            `-> WS /guac/ -> guacamole-lite on 127.0.0.1:8081
   |                                   -> guacd:4822 on 127.0.0.1
   |                                       -> VNC:5901 on private EC2 IP
   +-- MongoDB Atlas: accounts, apps, wallet, sessions, audit, usage
   +-- S3: signed browser multipart PUT; worker malware scans and prep downloads
   +-- SQS: scan, provision, terminate work (with DLQ)
   +-- Paystack: initialize + verify + signed webhooks
   +-- SES: registration verification and password reset email
   |
Private native worker EC2 (no inbound ports; uses SQS)
   | EC2 RunInstances, EC2 TerminateInstances, SSM RunCommand
   +--> Dedicated private EC2 per app session (no public IP)
           Ubuntu + Xfce + TigerVNC + SSM + CloudWatch Agent
           user-data -> root downloads signed S3 artifact -> safe prepare
           systemd launches untrusted app as `streamer` with egress denied
           CloudWatch logs -> authorized session log endpoint
```

Guacamole encrypts and signs 60-second session connection parameters. The API checks session ownership and running state before issuing a 60-second ticket. The gateway synchronously validates the HMAC and expiration, using only the signed private destination and credentials and rejecting browser-supplied host addresses. `guacd` is loopback only and VNC port 5901 is allowed **only from the API security group**. SSH and RDP are not public.

## Repository layout

```
cloud-app-platform/
├── frontend/              # Vite React TS, Tailwind, Router, Query, Zustand
├── backend/               # Express, Mongoose, AWS SDK, auth, Paystack, SQS worker
│   ├── src/models/        # 12 MongoDB models with indexes
│   ├── src/routes/        # REST API v1
│   ├── src/services/      # S3 uploads, EC2 lifecycle, streaming tokens
│   ├── src/workers/       # Scanner/provisioning/reconciliation consumer
│   └── scripts/           # Read-only package validator
├── infrastructure/        # Native EC2/VPC/S3/SQS/Secrets Manager/IAM Terraform
├── scripts/               # Golden AMI, native host and secrets bootstrapping
├── documentation/         # OpenAPI specification
├── AWS_SETUP.md
├── DEPLOYMENT.md
├── STREAMING_SETUP.md
├── SECURITY.md
├── API_DOCUMENTATION.md
└── README.md
```

## Prerequisites

- AWS account with billing alerts, EC2/VPC/S3/SQS/SSM/CloudWatch/SES/Secrets Manager permissions, enough vCPU quota and NAT budget
- Node.js 22, npm, Python 3.12, Git, AWS CLI v2, Terraform >= 1.5
- MongoDB Atlas **replica set** (transaction-capable) with correctly restricted network access
- Paystack account with test/live keys, and verified SES identity (out of SES sandbox if emailing arbitrary users)
- DNS for `api.example.com` (HTTPS Nginx; TLS certificates) and frontend `app.example.com`
- x86_64 Ubuntu 24.04 AMI and a private execution AMI prepared with the supplied script
- Dedicated worker host with `clamscan` + up-to-date ClamAV signatures; backend host with `guacd` and VNC plugin

## Quick setup

1. Follow [AWS_SETUP.md](AWS_SETUP.md) to deploy the VPC/subnets, S3, SQS, roles, Secrets Manager, API/worker EC2 and prepare a clean execution AMI.
2. Provision MongoDB Atlas, verify SES sender, configure Paystack, and save the backend runtime configuration in Secrets Manager.
3. Follow [DEPLOYMENT.md](DEPLOYMENT.md) to install native services, build with npm, set up HTTPS and deploy Vercel.
4. Follow [STREAMING_SETUP.md](STREAMING_SETUP.md) for guacd + native Xfce/TigerVNC validation.
5. Run `npm install && npm run build` separately in `backend` and `frontend`. Run the validator tests and smoke tests.
6. `cd backend && ADMIN_EMAIL=... ADMIN_PASSWORD='strong-unique-16+-chars' npm run seed:admin`. The super admin is email-verified by the controlled CLI bootstrap.
7. Sign up and verify email (SES required); the admin adds an offered CPU instance type with an explicit NGN hourly price and enables it. Upload a known-working x86_64 AppImage. After ClamAV and approval, top up a test wallet using Paystack and launch.

### Local development

```bash
cd backend
cp .env.example .env  # fill every required env variable (do not commit)
npm install
npm run dev
# other terminal from backend/
npm run worker

cd ../frontend
cp .env.example .env
npm install
npm run dev
```

**Local API/UI development is possible, but provisioning, verified uploads, email, payments and browser streaming require real external integrations** and a reachable private VPC. `guacd`, Terraform-managed infrastructure and a live instance are not replaced by mocked responses.

For native browser interaction, use `https://api.example.com/guac/` as the public stream WebSocket prefix and `VITE_STREAMING_BASE_URL` on the backend with value `wss://api.example.com/guac` (the backend variable name is retained to match the requested configuration). See [STREAMING_SETUP.md](STREAMING_SETUP.md).

## User features

Registration/login/logout, verified email, recovery and password changes, bearer access JWT and secure rotating opaque refresh tokens; profile and account deletion; application library, multipart uploads, progress/cancel, version replacement, archive/detail/status; admin review; verified CPU instance catalog, controlled launch and restart; running/historic sessions; interactive remote desktop, keyboard/mouse/fullscreen/reconnect, heartbeats, sampled CPU/RAM and CloudWatch logs; prepaid wallet/holds, Paystack top-ups, released unused credits, payments ledger, user/admin views; account suspension, admin session termination, audit events.

See [API_DOCUMENTATION.md](API_DOCUMENTATION.md) and generated Swagger UI at `/api/v1/docs` after running the API.

## Security and lifecycle limitations

- Uploaded software is potentially malicious. Dedicated VMs and UID restrictions **reduce** risk but are not a full guarantee against kernel exploits. No high-trust multi-tenant production deployment should proceed without sandbox penetration testing, AMI patching and explicit acceptable-use policies.
- The worker does not execute uploads; it only scans them and provisions dedicated VMs. `streamer` has no default outbound network access and no intended access to IMDS/credentials. SSM/CloudWatch agents run as privileged host services; kernel compromise defeats these controls.
- Client activity heartbeats are used only for inactivity policy. EC2 `DescribeInstances` is authoritative for termination and session billing settlement; clients cannot set session cost.
- Reservations cover a maximum session duration. Billing is platform pricing calculated from the instance allocation-to-termination interval, not AWS Cost Explorer bill line items (which may include extra overhead). Minimum billed time is 1 minute, with ceiling rounding to kobo. S3, NAT, CloudWatch, EBS and stopped host costs are separate operational expenses.
- Session logs are retained for 14 days in CloudWatch by default. Session disks are ephemeral and deleted on termination. No persistent user home directory is offered.
- Only **one availability zone** and one API/worker are provisioned in Terraform; this is a deployable single-region pilot foundation, not high-availability production architecture. No autoscaling, continuous app network access, subscription auto-renewal, Windows, GPU, or live desktop audio.
- Native AppImage dependencies may still be missing. For application-specific libraries, bake audited system dependencies into a new versioned private AMI.
- Cross-origin refresh cookies work best when API and frontend use the same registrable domain (e.g., `api.example.com` and `app.example.com`) with HTTPS.

## Cost management

Configure AWS Budgets/CloudWatch alarms, strict vCPU quotas, regional CPU-only catalog, maximum runtime, 15-minute inactivity timeout, max session age 180 minutes, SQS dead-letter alarms, S3 multipart lifecycle, EBS delete-on-termination, CloudWatch log retention, and verify the `aws_ec2_instance` orphan sweeper. **NAT Gateway charges apply even with no sessions** and EC2 worker/API continue billing 24/7. Test from small allowed configurations first; never leave a pilot account without alerts.

## Testing and deployment acceptance

```bash
python3 -m unittest discover -s tests -v
bash -n scripts/*.sh
cd backend && npm install && npm run build && npm test
cd ../frontend && npm install && npm run build
cd ../infrastructure && terraform fmt -check && terraform validate
```

The code archive does **not** contain actual credentials, node_modules, deployment output or AWS account identifiers. Read [SECURITY.md](SECURITY.md) before connecting real users or running potentially hostile software.
