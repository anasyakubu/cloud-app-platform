"""Offline source-level regression checks; NOT a replacement for live API/SES tests."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


class AuthRepairTests(unittest.TestCase):
    def test_verification_is_optional_across_all_authenticated_paths(self):
        auth = read('backend/src/routes/auth.ts')
        middleware = read('backend/src/middleware/auth.ts')
        self.assertNotIn("'EMAIL_NOT_VERIFIED'", auth)
        self.assertNotIn('if (!user.verifiedAt)', auth)
        self.assertIn('if (!user || user.suspendedAt)', auth)
        self.assertNotIn('||!user.verifiedAt', middleware)
        self.assertIn('if(!user||user.suspendedAt)', middleware)
        self.assertIn("'Account unavailable or suspended'", middleware)
        # Only the optional resend action should require SES.
        reg = auth[auth.index("r.post('/register'"):auth.index("r.post('/resend-verification'")]
        self.assertNotIn('requireSes()', reg)
        self.assertIn('const sendOptionalEmail = env.SES_ENABLED', reg)
        self.assertIn('verificationEmailSent', reg)
        self.assertIn('const accessToken = await issueRefresh(res, user)', reg)
        self.assertIn('catch (err)', reg)
        self.assertIn('sendVerificationEmail(user.email, verificationToken)', reg)
        self.assertIn("'/resend-verification'", auth)
        self.assertIn('sendResetEmail', auth)

    def test_ui_automatically_signs_in_after_registration(self):
        src = read('frontend/src/pages/Auth.tsx')
        self.assertIn("mode==='login'||mode==='register'", src)
        self.assertIn("navigate('/dashboard',{replace:true})", src)
        self.assertNotIn('EMAIL_NOT_VERIFIED', src)
        profile = read('frontend/src/pages/Profile.tsx')
        self.assertIn('Email verification (optional)', profile)
        self.assertIn("'/auth/resend-verification'", profile)
        self.assertIn('You can still use the dashboard', profile)
        self.assertNotIn('EMAIL_NOT_VERIFIED', read('frontend/src/lib/api.ts'))

    def test_password_minimum_applies_to_registration_reset_change_frontend(self):
        backend = read('backend/src/routes/auth.ts')
        ui = read('frontend/src/pages/Auth.tsx')
        profile = read('frontend/src/pages/Profile.tsx')
        self.assertIn('password: z.string().min(5).max(128)', backend)
        self.assertIn('newPassword: z.string().min(5).max(128)', backend)
        self.assertIn('password:z.string().min(5).max(128)', ui)
        self.assertIn('minLength={5}', profile)
        self.assertNotIn('Minimum 12 characters', ui)

    def test_origin_protection_scoped_to_cookie_auth(self):
        src = read('backend/src/server.ts')
        self.assertIn('FRONTEND_ORIGINS.split', src)
        self.assertIn("'/api/v1/auth/refresh'", src)
        self.assertNotIn("req.headers.origin !== env.FRONTEND_URL", src)
        self.assertIn('credentials: true', src)

    def test_ses_and_public_recovery_setup(self):
        service = read('backend/src/services/email.ts')
        self.assertIn('SendEmailCommand', service)
        self.assertIn('SES_FROM_EMAIL', service)
        self.assertIn('SES_ENABLED', service)
        self.assertIn('sendResetEmail', read('backend/src/routes/auth.ts'))
        self.assertIn("'/resend-verification'", read('backend/src/routes/auth.ts'))
        self.assertIn('ses:SendEmail', read('infrastructure/iam.tf'))
        self.assertIn('aws_sesv2_email_identity', read('infrastructure/ses.tf'))

    def test_requested_env_files_and_no_legacy_secrets(self):
        backend = read('backend/.env')
        frontend = read('frontend/.env')
        self.assertIn('FRONTEND_ORIGINS=', backend)
        self.assertIn('SES_ENABLED=false', backend)
        self.assertIn('SES_FROM_EMAIL=', backend)
        self.assertIn('VITE_API_URL=', frontend)
        self.assertRegex(backend, r'DATA_ENCRYPTION_KEY=[0-9a-f]{64}')


if __name__ == '__main__':
    unittest.main()
