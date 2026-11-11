# Threat model and security guide

This project executes **customer-uploaded code**. The isolation boundary is a dedicated, ephemeral private EC2 VM per session, not the web backend process and not a Linux user account on a shared host. It is still possible for hostile native code to exploit kernel, hypervisor, VNC/guacd/ClamAV, or package parser vulnerabilities. This repository is a production-oriented foundation that needs real penetration testing and operations engineering before broad public access.

## Isolation

- Dedicated EC2 instance for each user session, non-shared local filesystem and encrypted EBS volume, `DeleteOnTermination` and automatic instance termination.
- Private execution subnet, **no public IP**, security group accepting only VNC TCP 5901 from the API security group. SSH/RDP not publicly exposed. Administrators use SSM.
- `streamer` unprivileged user launches the application using native systemd. App files belong to `streamer`; startup arguments are `execve` argv, not concatenated shell commands. `NoNewPrivileges`, an empty capability bounding set and service filesystem restrictions are enabled.
- `iptables -m owner --uid-owner streamer` allows loopback and ESTABLISHED packets (VNC responses) and rejects other app UID outbound traffic including IMDS. AWS metadata requires IMDSv2, with hop limit 1. The root SSM and CloudWatch agents still use instance role credentials. **Do not run the app as root** or add streamer to sudo/docker/admin groups.
- Restrict instance roles: execution role gets SSM + its CloudWatch log stream permissions, **not S3 application listing/decrypt or EC2 launch**. Artifact GET uses a short-lived S3 presigned URL in root-only user data. VM compromises obtaining root may access the execution role — plan IAM permissions accordingly.
- Do not enable cross-user remote VNC ports or trust the short 8-character classic VNC password alone. Signed expiring stream tickets, server-authoritative host selection, authenticated API, VPC SG and TLS are all required.

## Upload pipeline

- Browser sends 8 MiB presigned S3 multipart PUTs directly to a private SSE-S3 bucket; backend never accepts huge binary multipart bodies.
- Maximum 2 GiB object; S3 head verifies size. Safe lowercase extension + declared format; Type 1/2 ELF AppImage header validation; `.tar.gz` inspection rejects absolute paths, `..`, special files, symlinks, hardlinks, setuid bits, oversized expansions and too many entries.
- Dedicated worker downloads and scans bytes using updated ClamAV. Any tool failure or malware result causes failure, not approval. Administrative review is on by default. Worker **does not execute** archives.
- AMI bootstrap repeats archive path validation **before extraction**. Root-only signed download URL is destroyed on instance termination. Never accept unreviewed shell installers, `.deb` maintainer scripts, executable ZIP files or Windows binaries in this runtime.
- Upload revocation/archive currently uses a seven-day cleanup grace. Review S3 Lifecycle and delete data on legal requests according to a documented retention policy.

## Identity and authorization

- Argon2id password hash, 5-character minimum password (per requested requirement; significantly weaker than recommended), email verification via SES, hashed expiring reset/verification tokens, short-lived JWT bearer access, opaque rotating hashed refresh tokens in `HttpOnly`, `Secure` and `SameSite` cookies, logout invalidation and role checks.
- In production, use **same-site custom frontend and API domains** plus HTTPS. Server validates request Origin for cross-origin unsafe methods, and CORS is fixed to the exact allowed frontend. Audit authentication and implement stronger brute-force monitoring and optional MFA before wide release.
- Every application/session/usage/log/ticket lookup checks `user`/`owner` in MongoDB. Admin APIs require elevated role and record an audit entry for admin changes. Super-admin role can only be seeded via privileged CLI.
- Streaming ticket ciphertext is AES-256-CBC compatible with guacamole-lite but protected by a separate HMAC signature derived from the 32-byte secret. The gateway checks expiration, signature and authoritative session, and replaces any token-supplied host/password with DB values. VNC passwords are AES-256-GCM encrypted at rest in MongoDB.
- Rate limits apply to auth routes. Place WAF, per-user upload quotas, stronger content-scanning isolation, per-IP abuse protection and account verification controls in front of public registration before launch.

## Billing integrity

- Wallet balance stored as **integer kobo** in MongoDB; atomic transactions reserve maximum session budget before enqueue. Per-user session counter is updated within the same transaction, and settlement is idempotent by `billingSettledAt` and unique ledger references.
- Session resource billing uses server-side timestamps and EC2 authority. The browser cannot set state, cost, price or running time. Underfunded sessions are rejected before launch. Session max runtime and global max age are enforced by native worker reconciliation.
- Paystack secret only on backend. Payment callback alone never credits wallet; the backend checks Paystack API currency/status/exact amount/reference or verifies the signed raw-body webhook, then credits a pending ledger entry once.
- **Monitor DB integrity:** if Mongo transactions fail, no funds should be reserved without a session record. Test race conditions, duplicate SQS deliveries, payment callback retries, Mongo failover and EC2 termination failures with injected failures.

## Additional requirements before broad production rollout

1. Independent penetration test and malicious package test corpus on the exact AMI. Use hardened AMIs, kernel patching, instance type isolation, restrictive apparmor/SELinux profiles and dedicated AWS accounts/VPCs per trust tier where justified.
2. Do not assume `iptables` egress denial blocks every possible covert channel. Kernel vulnerabilities, raw sockets if capabilities leak, VPC DNS channels and privilege escalation need assessment.
3. Rotate keys, configure secret-access audit and egress controls, implement security event alerts and immutable audit export, production WAF, mandatory MFA for admins and documented incident response.
4. Set AWS account-level spending and service quotas, CloudWatch/SQS DLQ alarms, termination reconciliation (including launch crash orphans), and resource tags. Monitor the private worker.
5. Review open-source dependency versions and vulnerability alerts. Do not use unsupported packages without dependency review. Pin package-lock after installing from a trusted npm registry and commit lockfiles to your protected repository.
6. Perform E2E test with a benign AppImage; separately evaluate unsafe files using an authorized test environment, not a production account.
7. Plan reliable backups, Atlas retention, disaster recovery across AZs, worker scheduling/leases, S3/object encryption policies, legal acceptance of user uploads and subscription tax/consumer law policies.
8. Browser-level extension exposure, clipboard sharing, audio, file-transfer and remote egress are not supported. Do not market them as existing features.

## Incident commands

```bash
# Stop a user session via the authenticated admin API, or terminate from AWS in an emergency:
aws ec2 terminate-instances --instance-ids i-COMPROMISED --region eu-west-1
# Check execution instance tags and metadata:
aws ec2 describe-instances --filters Name=tag:Project,Values=CloudStream
# Inspect SQS dead-letter messages from the AWS console or CLI with the DLQ URL.
# Block public access if an API credential is compromised; rotate JWT, encryption and Paystack secrets carefully.
```

Never publish the VNC password, EC2 private IP, AWS access keys, signed S3 URLs, Secrets Manager values, or Guacamole session tickets in logs or support messages.

## Optional email verification policy

Users can register and use authenticated pages even before verifying their email. This intentionally allows accounts using unverified addresses and creates impersonation/abuse risk. Keep role and ownership checks, rate limits, suspension enforcement and SES resend cooldowns. Consider requiring verified email for sensitive actions (e.g., payments, account recovery, or high-value resource launches) if business requirements change; **this release does not require it for page access**. Do not interpret `verified=false` as an authorization failure.
