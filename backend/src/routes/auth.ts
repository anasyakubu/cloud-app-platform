import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { z } from 'zod';
import { User, Wallet, AuditLog } from '../models/index.js';
import { env } from '../config/env.js';
import { requireSes, sendVerificationEmail, sendResetEmail, EMAIL_RESEND_INTERVAL_MS, EMAIL_VERIFICATION_TTL_MS } from '../services/email.js';
import { authenticate } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../utils/http.js';
import { randomToken, sha256 } from '../utils/crypto.js';

const r = Router();

const credentials = z.object({
  email: z.string().email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(5).max(128),
});

const safeUser = (u: any) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  verified: !!u.verifiedAt,
});

const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  path: '/api/v1/auth',
  maxAge: 30 * 24 * 3600 * 1000,
};

function accessToken(user: any) {
  return jwt.sign({ sub: user.id, type: 'access' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

async function issueRefresh(res: any, user: any) {
  const token = randomToken();

  // Keep the subdocument array typed as a Mongoose DocumentArray.
  // Mutate in place instead of reassigning to a plain array.
  const kept = (user.refreshTokens || [])
    .filter((t: any) => t.expiresAt > new Date())
    .slice(-4);

  user.refreshTokens.splice(0, user.refreshTokens.length, ...kept);

  user.refreshTokens.push({
    hash: sha256(token),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 86400000),
  });

  await user.save();
  res.cookie('cloudstream_refresh', token, cookieOptions);
  return accessToken(user);
}

// Verification is a voluntary account-security feature, not a login prerequisite.
const resendResult = {message: 'If that email belongs to an unverified account, a verification link will be sent shortly.'};

r.post('/register', asyncRoute(async (req, res) => {
  // Accounts can be used immediately. SES is only required to *send* an
  // optional verification message, not to create an account or use the app.
  const body = credentials.extend({ name: z.string().trim().min(2).max(100) }).parse(req.body);
  if (await User.exists({ email: body.email })) throw new HttpError(409, 'Email is already registered');

  const sendOptionalEmail = env.SES_ENABLED && !!env.SES_FROM_EMAIL;
  const verificationToken = sendOptionalEmail ? randomToken() : undefined;
  const user = await User.create({
    name: body.name,
    email: body.email,
    passwordHash: await argon2.hash(body.password),
    ...(verificationToken ? {
      verificationTokenHash: sha256(verificationToken),
      verificationExpires: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      verificationSentAt: new Date(),
    } : {}),
  });
  await Wallet.create({ user: user.id });

  // Issue authenticated access regardless of SES configuration or delivery.
  const accessToken = await issueRefresh(res, user);
  let verificationEmailSent = false;
  if (verificationToken) {
    try {
      await sendVerificationEmail(user.email, verificationToken);
      verificationEmailSent = true;
    } catch (err) {
      console.error('Optional SES verification delivery failed', err);
      // A mail-provider outage must not prevent registration or page access.
    }
  }
  res.status(201).json({
    accessToken,
    user: safeUser(user),
    verificationEmailSent,
    message: 'Account created. Email verification is optional and can be completed later in Profile.',
  });
}));

// Public recovery path for accounts created before SES was enabled or failed delivery.
// Generic response avoids account enumeration. Rate limited at the HTTP layer.
r.post('/resend-verification', asyncRoute(async (req, res) => {
  requireSes();
  const { email } = z.object({email: z.string().email().max(254).transform(v => v.toLowerCase())}).parse(req.body);
  const user = await User.findOne({email}).select('+verificationTokenHash');
  if (user && !user.verifiedAt && !user.suspendedAt &&
      (!user.verificationSentAt || Date.now() - user.verificationSentAt.getTime() >= EMAIL_RESEND_INTERVAL_MS)) {
    const token = randomToken();
    user.verificationTokenHash = sha256(token);
    user.verificationExpires = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    // Reserve the cooldown before sending, to prevent concurrent sends.
    user.verificationSentAt = new Date();
    await user.save();
    try { await sendVerificationEmail(user.email, token); }
    catch (err) {
      console.error('SES verification resend failed', err);
      // User can retry after the cooldown; token is never exposed in logs.
      throw new HttpError(503, 'Email delivery is temporarily unavailable. Please try again shortly.', 'EMAIL_SEND_FAILED');
    }
  }
  res.json(resendResult);
}));

r.post(
  '/verify-email',
  asyncRoute(async (req, res) => {
    const body = z
      .object({ email: z.string().email(), token: z.string().min(20) })
      .parse(req.body);

    const user = await User.findOne({
      email: body.email.toLowerCase(),
    }).select('+verificationTokenHash');

    if (
      !user ||
      user.verificationTokenHash !== sha256(body.token) ||
      !user.verificationExpires ||
      user.verificationExpires < new Date()
    ) {
      throw new HttpError(400, 'Invalid or expired verification link');
    }

    user.verifiedAt = new Date();
    user.verificationTokenHash = undefined;
    user.verificationExpires = undefined;
    await user.save();

    res.json({ message: 'Email verified successfully. You can continue using your account.' });
  })
);

r.post(
  '/login',
  asyncRoute(async (req, res) => {
    const body = credentials.parse(req.body);

    const user = await User.findOne({ email: body.email }).select(
      '+passwordHash +refreshTokens'
    );

    if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
      throw new HttpError(401, 'Invalid credentials');
    }

    if (user.suspendedAt) {
      throw new HttpError(403, 'Account suspended');
    }

    const token = await issueRefresh(res, user);
    res.json({ accessToken: token, user: safeUser(user) });
  })
);

r.post(
  '/refresh',
  asyncRoute(async (req, res) => {
    const raw = req.cookies?.cloudstream_refresh;

    if (!raw) {
      throw new HttpError(401, 'No refresh token');
    }

    const user = await User.findOne({
      'refreshTokens.hash': sha256(raw),
    }).select('+refreshTokens');

    if (!user || user.suspendedAt) {
      throw new HttpError(401, 'Session expired');
    }

    const index = user.refreshTokens.findIndex(
      (t: any) => t.hash === sha256(raw)
    );
    const match = user.refreshTokens[index];

    if (!match || !match.expiresAt || match.expiresAt < new Date()) {
      throw new HttpError(401, 'Session expired');
    }

    user.refreshTokens.splice(index, 1);

    const token = await issueRefresh(res, user);
    res.json({ accessToken: token, user: safeUser(user) });
  })
);

r.post(
  '/logout',
  asyncRoute(async (req, res) => {
    const raw = req.cookies?.cloudstream_refresh;

    if (raw) {
      await User.updateOne(
        { 'refreshTokens.hash': sha256(raw) },
        { $pull: { refreshTokens: { hash: sha256(raw) } } }
      );
    }

    res.clearCookie('cloudstream_refresh', cookieOptions);
    res.json({ message: 'Logged out' });
  })
);

r.post('/forgot-password', asyncRoute(async (req, res) => {
  requireSes();
  const body = z.object({email: z.string().email().max(254).transform(v => v.toLowerCase())}).parse(req.body);
  const user = await User.findOne({email: body.email}).select('+resetTokenHash');
  if (user && !user.suspendedAt) {
    const token = randomToken();
    user.resetTokenHash = sha256(token);
    user.resetExpires = new Date(Date.now() + 3600000);
    await user.save();
    try { await sendResetEmail(user.email, token); }
    catch (err) {
      console.error('SES password reset delivery failure', err);
      throw new HttpError(503, 'Email delivery is temporarily unavailable. Try again shortly.', 'EMAIL_SEND_FAILED');
    }
  }
  res.json({message: 'If your account exists, password reset instructions will be sent.'});
}));

r.post(
  '/reset-password',
  asyncRoute(async (req, res) => {
    const body = credentials
      .extend({ token: z.string().min(20) })
      .parse(req.body);

    const user = await User.findOne({
      email: body.email,
      resetTokenHash: sha256(body.token),
    }).select('+resetTokenHash +refreshTokens +passwordHash');

    if (!user || !user.resetExpires || user.resetExpires < new Date()) {
      throw new HttpError(400, 'Invalid or expired link');
    }

    user.passwordHash = await argon2.hash(body.password);
    user.resetTokenHash = undefined;
    user.resetExpires = undefined;
    // Mutate in place instead of `= []` to keep the DocumentArray type.
    user.refreshTokens.splice(0, user.refreshTokens.length);
    await user.save();

    res.json({ message: 'Password updated' });
  })
);

r.get(
  '/me',
  authenticate,
  asyncRoute(async (req, res) => {
    const user = await User.findById(req.auth!.id);
    res.json({ user: safeUser(user) });
  })
);

r.patch(
  '/me',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ name: z.string().trim().min(2).max(100) })
      .parse(req.body);

    const user = await User.findByIdAndUpdate(
      req.auth!.id,
      { $set: body },
      { new: true }
    );

    res.json({ user: safeUser(user) });
  })
);

r.post(
  '/change-password',
  authenticate,
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        currentPassword: z.string(),
        newPassword: z.string().min(5).max(128),
      })
      .parse(req.body);

    const user = await User.findById(req.auth!.id).select(
      '+passwordHash +refreshTokens'
    );

    if (!user || !(await argon2.verify(user.passwordHash, body.currentPassword))) {
      throw new HttpError(403, 'Incorrect password');
    }

    user.passwordHash = await argon2.hash(body.newPassword);
    // Mutate in place instead of `= []` to keep the DocumentArray type.
    user.refreshTokens.splice(0, user.refreshTokens.length);
    await user.save();

    res.clearCookie('cloudstream_refresh', cookieOptions);
    res.json({ message: 'Password changed; log in again' });
  })
);

r.delete(
  '/me',
  authenticate,
  asyncRoute(async (req, res) => {
    const { Session, Application } = await import('../models/index.js');

    if (
      await Session.exists({
        user: req.auth!.id,
        state: {
          $in: [
            'queued',
            'provisioning',
            'preparing',
            'starting',
            'running',
            'reconnecting',
            'stopping',
          ],
        },
      })
    ) {
      throw new HttpError(
        409,
        'Stop your active session before deleting your account'
      );
    }

    await Application.updateMany(
      { owner: req.auth!.id },
      { $set: { deletedAt: new Date() } }
    );

    await User.findByIdAndDelete(req.auth!.id);

    await AuditLog.create({ actor: req.auth!.id, action: 'account.deleted' });

    res.clearCookie('cloudstream_refresh', cookieOptions);
    res.json({
      message:
        'Account deleted; uploaded objects are queued for retention cleanup',
    });
  })
);

export default r;