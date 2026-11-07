# CloudStream API v1

The OpenAPI 3 specification lives at `documentation/openapi.yaml`; the running API exposes Swagger UI at `https://api.example.com/api/v1/docs`. The API root is `/api/v1`. JSON request bodies are limited to 200 KiB; large file bytes go directly to S3 presigned URLs. Most authenticated endpoints require `Authorization: Bearer <accessToken>`. `POST /auth/refresh` uses the HTTP-only refresh cookie and rotates it.

## Auth

| Verb | Route | Purpose |
|---|---|---|
| POST | `/auth/register` | Create name/email/password user and issue SES verification link |
| POST | `/auth/verify-email` | `{email,token}`; enables login |
| POST | `/auth/login` | `{email,password}`; returns access token/user, sets refresh cookie |
| POST | `/auth/refresh` | Rotate HTTP-only refresh token, return access JWT |
| POST | `/auth/logout` | Revoke refresh cookie |
| POST | `/auth/forgot-password` | Issue expiring SES reset email |
| POST | `/auth/reset-password` | `{email,token,password}`; revoke refresh sessions |
| GET/PATCH/DELETE | `/auth/me` | Profile/update name/account deletion |
| POST | `/auth/change-password` | `{currentPassword,newPassword}` |

Registration requires real SES delivery; no developer backdoor verification token is emitted by the public endpoint. `JWT_ACCESS_SECRET`, refresh secrets and cookies are server-only.

## Application multipart upload workflow

`POST /applications/uploads` with:

```json
{
  "name":"My Linux Editor", "description":"Portable desktop editor", "category":"Productivity",
  "version":"1.0.0", "fileName":"Editor.AppImage", "size":12345678,
  "format":"appimage", "startupExecutable":"Editor.AppImage", "startupArgs":[],
  "environment":{}, "requirements":{"cpu":2,"ramGb":4,"storageGb":20,"gpu":false}
}
```

For a new version, add `appId` pointing to an owned existing application. Response contains `{app,version,uploadId,parts,partSize}`. For each `part` from 1 to `parts`, call `GET /applications/uploads/:uploadId/part/:part`. The response contains `{url,expiresIn}`. `PUT` the corresponding raw binary slice to this signed S3 URL, **not** Express, and record the S3 `ETag` header. A web browser requires Terraform S3 CORS to expose `ETag`. Send ascending complete parts:

```json
{"parts":[{"PartNumber":1,"ETag":"\"etag-from-S3\""},{"PartNumber":2,"ETag":"\"etag-from-S3\""}]}
```

`POST /applications/uploads/:uploadId/complete` completes the object and enqueues a `scan` SQS job; `DELETE /applications/uploads/:id` aborts. App status transitions through `uploading`, `scanning`, `pending_review` or `approved`/`failed`. Admin approval is required by default. `GET /applications`, `GET /applications/:id`, `GET /applications/:id/versions`, `PATCH /applications/:id`, `DELETE /applications/:id` are user-scoped.

## Session lifecycle and streaming

1. `GET /sessions/configurations` returns admin-enabled, AWS-verified EC2 CPU configurations, each with a server-side hourly rate in **integer NGN kobo**.
2. `POST /sessions` with `{appId,configurationId,maxMinutes}` atomically checks owner/approval, compatibility, quota and wallet balance; reserves the session maximum and enqueues EC2.
3. `GET /sessions/:id` returns `queued`, `provisioning`, `preparing`, `running`, `stopping`, `stopped`, or `failed` as recorded by the native backend/worker.
4. `POST /sessions/:id/connection-ticket` when `running` returns a short-lived `url` for actual Guacamole WebSocket; `guacamole-common-js` connects with this URL. Do not parse or log the token.
5. `POST /sessions/:id/heartbeat` every 30 seconds while connected; `GET /sessions/:id/usage` returns SSM-derived CPU/RAM samples.
6. `GET /sessions/:id/logs` returns CloudWatch app log events if CloudWatch agent has reported them.
7. `POST /sessions/:id/stop` enqueues termination. The background worker uses EC2 `DescribeInstances` for authoritative termination before settlement and unused wallet credit release. `POST /sessions/:id/restart` creates a **new** paid session only after stopped/failed.

Example authenticated call:

```bash
API=https://api.example.com/api/v1
TOKEN='YOUR-15-MINUTE-ACCESS-JWT'
curl -H "Authorization: Bearer $TOKEN" "$API/sessions/configurations"
curl -X POST "$API/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"appId":"YOUR_APP_OBJECT_ID","configurationId":"YOUR_CONFIG_OBJECT_ID","maxMinutes":30}'
```

## Billing / Paystack

- `GET /billing/wallet` returns `{wallet:{balanceKobo,reservedKobo,currency}}`.
- `GET /billing/transactions` returns the user-scoped ledger.
- `POST /billing/topup` `{amountKobo:500000}` initializes a test/live Paystack checkout and returns `{authorizationUrl,reference}`; browser redirects to Paystack.
- `POST /billing/verify` `{reference}` verifies the payment with Paystack on the server and credits only a verified pending reference.
- `POST /billing/webhook` takes Paystack raw JSON with `x-paystack-signature` HMAC SHA-512; source authenticity and amount/currency verified before idempotent credit. It is unauthenticated by JWT because Paystack is an external sender, but cryptographically authenticated.

The minimum Paystack topup in this code is ₦100 (10,000 kobo). Session charges are allocated-time based and rounded up per kobo; `hold` and `release` are separate ledger events. Automatic monthly subscription debits are not implemented; the `Subscription` model is an extension point, not a functioning recurring payment product.

## Administrator endpoints

All `/admin/*` require `admin` or `super_admin` JWT role. Public registration cannot elevate roles. Supported endpoints:

- `GET /admin/overview`, `/admin/users`, `/admin/applications`, `/admin/sessions`, `/admin/configurations`, `/admin/audit`, `/admin/billing`
- `PATCH /admin/users/:id/suspend` `{suspend:boolean}`; suspending a user stops their active sessions
- `PATCH /admin/versions/:id/review` `{approved:boolean,reason?:string}` after scanning
- `POST /admin/sessions/:id/terminate` queues force-stop for any user's session
- `POST /admin/configurations` `{name,instanceType,storageGb,priceKoboPerHour,enabled:false}` verifies EC2 properties/regional offerings and rejects GPU types in the supplied CPU AMI
- `PATCH /admin/configurations/:id` `{name?,priceKoboPerHour?,enabled?}`

## API errors and validation

Zod request errors return HTTP 400 with `{error,details}`, authentication errors 401, owner/role or unverified errors 403, missing resources 404, conflict 409, insufficient credits 402, server/service configuration failures 503 or 500. Some AWS failures are logged by the worker and reflected in session `failureReason`; not all failures occur synchronously in the HTTP request. Paginated list routes accept `page` and `limit` (up to 100). In a scaled deployment, standardize pagination cursor and trace IDs.
