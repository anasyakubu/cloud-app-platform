# Optional email verification — implementation and deployment

## New behavior

- Registration requires an email address, name and 5+ character password, but **does not require proof of email ownership**. It returns an access token + sets a rotating HTTP-only refresh cookie and navigates directly to `/dashboard`.
- Login and refresh work regardless of `user.verified` / `verifiedAt`, including for existing unverified accounts. The protected dashboard, applications, sessions, billing and profile are available to them. Authentication, ownership and role checks **remain required**; admins-only pages are still admins-only.
- Registration tries to send an optional verification link through AWS SES only when `SES_ENABLED=true` and `SES_FROM_EMAIL` is set. SES failure does **not** fail account creation or login. An optional `verificationEmailSent` boolean in the registration response reports the result.
- Profile displays `Email verification (optional)` status and a **Send verification email** button. The standalone `/resend-verification` page remains available, and SES must be set up to send the link.
- Password reset is still sent through SES and returns an error if SES is not configured; this does not interfere with login or page access.
- Unverified account access is **not** a reason for HTTP 403. 401 indicates absent/invalid authentication; 403 still applies to suspended accounts, administrator permissions and configured origin restrictions on cookie-auth endpoints.

## Deployment

1. Deploy **both** `backend` and `frontend` versions. Updating the frontend alone cannot remove the old backend's 403 check.
2. Keep your existing `backend/.env` values. `SES_ENABLED=false` means registration and login work without SES. For optional verification emails, set `SES_ENABLED=true`, `SES_FROM_EMAIL=sender@your-verified-domain.example`, and grant `ses:SendEmail` in the backend instance IAM role. Check SES identity verification and sandbox restrictions in your AWS region.
3. Update `FRONTEND_URL` and `FRONTEND_ORIGINS` to match browser domains; set `frontend/.env` `VITE_API_URL` to your actual deployed `/api/v1` URL. Deploy over HTTPS and ensure secure refresh cookies are sent correctly.
4. Restart API and worker services (e.g. `sudo systemctl restart cloudstream-api cloudstream-worker` if your systemd units use these names), then rebuild/redeploy the Vite frontend.
5. Test an existing **unverified** account: `POST /api/v1/auth/login` should respond 200 with `user.verified: false`, `POST /api/v1/auth/refresh` should respond 200 with the refresh cookie, and `GET /api/v1/auth/me` with the bearer token should respond 200. Visit `/dashboard`, `/applications`, `/sessions`, `/billing` and `/profile`.
6. Test a **new** account with SES disabled: `POST /api/v1/auth/register` should return 201, `verificationEmailSent: false` and an `accessToken`. The frontend should immediately enter the dashboard.
7. When SES is enabled, request an optional link via Profile, follow it, and verify the profile status changes to verified. Failure to receive the optional email must not lock the user out.

## Security trade-off

Unverified email addresses can be mistyped or impersonated, and password recovery may not work for them. Do not rely on `user.email` as proof of identity for sensitive operations. Continue using JWTs, account suspension, object ownership and administrator roles. A 5-character minimum password is permitted per request but is considerably weaker than a longer passphrase; use long passwords in production.

## Checks

Run `python3 -m unittest discover -s tests -v` for offline regression tests and `npm ci && npm run build` in each of `backend/` and `frontend/` on a machine with npm connectivity.
