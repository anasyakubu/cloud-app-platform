> **Superseded authentication policy:** This document records an earlier change which required email verification before login. That restriction has now been removed at the user's request. For current behavior, follow [OPTIONAL_EMAIL_VERIFICATION.md](OPTIONAL_EMAIL_VERIFICATION.md). In particular, unverified accounts **can** log in and use authenticated pages, registration does **not** require SES, and email verification remains optional. The origin/CORS and SES deployment procedures below remain useful, but any claim about compulsory verification or registration failing without SES is historical.

# 403 errors, 5-character passwords, and Amazon SES — deployment instructions

This guide describes verified changes in the source. It does **not** claim AWS deployment or email deliverability has been tested against your AWS account.

## What caused 403 in your uploaded code

- `/auth/login` had commented out `verifiedAt` checking, so it returned an access token to unverified accounts. `/auth/refresh` and `authenticate` rejected those same users. The dashboard could load, but the API returned `403 Account unavailable or email not verified` on its requests. **Fix:** login now requires email verification; frontend routes to `/resend-verification` for those accounts, and verification itself is public.
- An origin gate on *all* POST/PATCH/DELETE/PUT requests compared `Origin` byte-for-byte with a single `FRONTEND_URL`. Alternate www/custom domains, preview deployments and some URL configurations produced `403 Origin denied`. **Fix:** use normalized origin allowlist and check only the cookie-only auth endpoints for cross-site POST. Bearer-protected mutations remain JWT-authorized.
- S3 multipart uploads rely on the S3 bucket's independent CORS policy. Terraform now accepts optional `additional_frontend_urls` and retains `ETag` in exposed headers.
- `login` now tells the user to verify their email. Existing unverified accounts can request a new link at `/resend-verification`, subject to rate limiting and a 60-second per-account cooldown. Public resend replies do not reveal whether the email exists.

## 1. Configure API and web origin URLs (avoid 403/CORS)

For local development:

```dotenv
# backend/.env
FRONTEND_URL=http://localhost:5173
FRONTEND_ORIGINS=
PUBLIC_API_URL=http://localhost:4000
# frontend/.env
VITE_API_URL=http://localhost:4000/api/v1
VITE_STREAMING_BASE_URL=ws://localhost:8081
```

For production (replace hostnames with your actual DNS names):

```dotenv
# Backend (use AWS Secrets Manager, restart service)
NODE_ENV=production
FRONTEND_URL=https://app.example.com
FRONTEND_ORIGINS=https://www.example.com,https://preview.example.com
PUBLIC_API_URL=https://api.example.com
VITE_STREAMING_BASE_URL=wss://api.example.com/stream
# Vercel / frontend build environment (rebuild and redeploy)
VITE_API_URL=https://api.example.com/api/v1
VITE_STREAMING_BASE_URL=wss://api.example.com/stream
```

`FRONTEND_URL` and each comma-separated `FRONTEND_ORIGINS` value must be a full origin (`https://host[:port]`, no paths). Never use `*` with credentialed CORS, and do not add arbitrary untrusted origins. Ensure your reverse proxy forwards `OPTIONS` preflights to Express and sets HTTPS headers. Cross-site refresh cookies in production require HTTPS. Use browser developer tools > Network to identify whether errors come from `/api/v1/...` (API), `PUT https://...s3...` (S3), or `wss://...` (stream). These are different problems.

For S3, set the same exact frontend URLs in `infrastructure/terraform.tfvars`:

```hcl
frontend_url = "https://app.example.com"
additional_frontend_urls = ["https://www.example.com", "https://preview.example.com"]
```

Then `terraform apply` and check with `aws s3api get-bucket-cors --bucket YOUR_BUCKET`.

## 2. Enable actual SES email verification

The backend sends real verification and reset emails using `@aws-sdk/client-ses` with instance profile credentials. It **does not** send mail when disabled, and registration fails with explicit `503 EMAIL_NOT_CONFIGURED` rather than creating unverified accounts silently.

1. Select **the same AWS_REGION** configured for the backend, e.g. `us-east-1`.
2. Verify a sender mailbox in Amazon SES (replace it with a mailbox you control):

```bash
export AWS_REGION=us-east-1
aws sesv2 create-email-identity --region "$AWS_REGION" \
  --email-identity no-reply@yourdomain.example
aws sesv2 get-email-identity --region "$AWS_REGION" \
  --email-identity no-reply@yourdomain.example
aws sesv2 get-account --region "$AWS_REGION"
```

Follow the verification email from SES, or verify your domain's DKIM DNS records. Until verified, SES rejects messages. While SES is **sandboxed**, recipient addresses also must be verified in the same region. Request production access in the SES console before onboarding unrestricted user email addresses. Set a verified sender:

```dotenv
# backend/.env locally, AWS Secrets Manager for deployment
SES_ENABLED=true
SES_FROM_EMAIL=no-reply@yourdomain.example
AWS_REGION=us-east-1
FRONTEND_URL=https://app.example.com
```

3. Attach IAM permission to the **API instance profile** for `ses:SendEmail` in your region. The included `infrastructure/iam.tf` has this permission on the API role. If using a separately provisioned API role, add an SES send policy; never add AWS keys to the Vite frontend. The backend uses the AWS SDK default credentials chain. Restart the API service after updating Secrets Manager or the `.env` file. The worker needs its own IAM policy for other services, not SES unless it sends email.
4. Test with a recipient address permitted by SES. Register at `/register`, open the delivered link (`/verify-email?email=...&token=...`) and press **Verify email**. Then log in and open dashboard pages. If you registered before SES was enabled, use `/resend-verification` with the same email. Password reset is emailed through SES as well.

SES delivery failures report a 503 error and are logged server-side (without the verification token). SES identity verification, DNS changes, IAM role propagation and sandbox approval are required external AWS actions; the code alone cannot grant them.

## 3. Passwords

Regular user **registration, reset, and change-password** now accept 5 to 128 characters. Login accepts existing passwords (1+ characters) to avoid unnecessary client-side rejection; the actual Argon2 hash is checked server-side. `seed:admin` **still requires 16+ characters**, intentionally. Use longer passwords and MFA for production, particularly for administrators.

## 4. Existing accounts and local testing

Install dependencies after configuring Node.js/npm access:

```bash
cd backend && npm ci && npm run check && npm run dev
# separate terminal
cd frontend && npm ci && npm run check && npm run dev
# separate terminal
cd backend && npm run worker
```

The backend needs MongoDB reachable at `MONGODB_URI`; the provided local `mongodb://127.0.0.1:27017/cloudstream` works **only** if MongoDB runs on your machine. Production should use MongoDB Atlas and an authorized network path. Configure AWS S3/SQS/EC2 values (non-secret identifiers in `.env` came from your earlier ZIP but have not been verified), an **AMI prepared with `scripts/prepare-executor-ami.sh`**, SES and IAM. Do not assume supplied AMI/queue/bucket IDs exist.

Useful API probes:

```bash
curl -i http://localhost:4000/health
curl -i -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  -X OPTIONS http://localhost:4000/api/v1/auth/login
curl -i -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}' \
  http://localhost:4000/api/v1/auth/resend-verification
```

Interpretation: `EMAIL_NOT_CONFIGURED` means set `SES_ENABLED` and a verified sender. `EMAIL_NOT_VERIFIED` on login means use the resend page; 403 on `/admin` while using a normal user account is expected role enforcement. 401 means token/refresh missing or expired. A network CORS failure may not display any API response at all; check exact origin/proxy/S3 configuration. 404 on Swagger docs means check working directory (`backend/`) and deployed documentation file.

## 5. Secrets and production readiness

The user-supplied ZIP contained pre-existing credential-bearing `.env` values. This updated ZIP **replaces them**: only newly created development cryptographic secrets are in `backend/.env`, with blank Paystack/SES fields and a local MongoDB URI. Treat copied AWS resource IDs as configuration data, **not proof of active resources**. Do not commit `.env` or deploy those development secrets to production. Set production secrets through AWS Secrets Manager and rotate any original secrets that have been accidentally shared or published.

Full TypeScript compilation and end-to-end AWS/SES delivery require installing npm dependencies, reachable MongoDB, SES setup and actual AWS resources. Source syntax and offline checks are validated separately. No Docker is used.
