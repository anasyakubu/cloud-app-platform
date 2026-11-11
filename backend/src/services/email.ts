import { SendEmailCommand } from '@aws-sdk/client-ses';
import { ses } from '../aws/clients.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http.js';

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const EMAIL_RESEND_INTERVAL_MS = 60 * 1000;

export function requireSes() {
  if (!env.SES_ENABLED || !env.SES_FROM_EMAIL) {
    throw new HttpError(503,
      'Email sending is not configured. Verification is optional; set SES_ENABLED=true and SES_FROM_EMAIL to a verified sender to send email.',
      'EMAIL_NOT_CONFIGURED');
  }
}

function urlFor(path: string, email: string, token: string) {
  const url = new URL(path, env.FRONTEND_URL.endsWith('/') ? env.FRONTEND_URL : `${env.FRONTEND_URL}/`);
  url.searchParams.set('email', email);
  url.searchParams.set('token', token);
  return url.toString();
}

async function send(to: string, subject: string, body: string) {
  requireSes();
  await ses.send(new SendEmailCommand({
    Source: env.SES_FROM_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: body, Charset: 'UTF-8' } },
    },
  }));
}

export async function sendVerificationEmail(to: string, token: string) {
  const url = urlFor('/verify-email', to, token);
  await send(to, 'Verify your CloudStream email',
    `Optionally verify your CloudStream email by opening this link:\n\n${url}\n\nThe link expires in 24 hours. If you did not create an account, ignore this message.`);
}

export async function sendResetEmail(to: string, token: string) {
  const url = urlFor('/reset-password', to, token);
  await send(to, 'Reset your CloudStream password',
    `Reset your CloudStream password using this link:\n\n${url}\n\nThe link expires in 1 hour. If you did not request a reset, ignore this message.`);
}
