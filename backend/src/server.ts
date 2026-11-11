import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { errorHandler, notFound } from './utils/http.js';
import auth from './routes/auth.js';
import apps from './routes/applications.js';
import sessions from './routes/sessions.js';
import billing, { webhookRouter } from './routes/billing.js';
import admin from './routes/admin.js';
import { startStreamingGateway } from './services/streaming.js';
import dotenv from "dotenv";
import dns from 'dns';


// Set custom DNS servers before any other operations
// This forces Node.js to use Cloudflare DNS (1.1.1.1) instead of the system DNS
dns.setServers(['1.1.1.1', '1.0.0.1']); // Using both Cloudflare primary and secondary


dotenv.config({ debug: false, quiet: true });


const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
// Compare normalized origins, not whole URLs. Only explicitly configured HTTPS/HTTP
// origins are allowed to receive credentialed browser responses.
export function configuredOrigins() {
  return new Set([env.FRONTEND_URL, ...env.FRONTEND_ORIGINS.split(',')]
    .map(v => v.trim()).filter(Boolean).map(v => new URL(v).origin));
}
const allowedOrigins = configuredOrigins();
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin are CLI/server-side calls, not credentialed CORS.
    callback(null, !origin || allowedOrigins.has(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.use(morgan('combined'));

// An Origin check is needed for cookie-only authentication actions, not for
// every Bearer-authenticated API mutation. This previously caused widespread 403s.
app.use(['/api/v1/auth/refresh', '/api/v1/auth/logout'], (req, res, next) => {
  if (req.method === 'POST' && req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
    res.status(403).json({ error: 'This website origin is not configured', code: 'ORIGIN_DENIED' });
    return;
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'cloudstream-api' }));

app.use('/api/v1/billing/webhook', webhookRouter);

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.use('/api/v1/auth', authLimiter, auth);
app.use('/api/v1/applications', apps);
app.use('/api/v1/sessions', sessions);
app.use('/api/v1/billing', billing);
app.use('/api/v1/admin', admin);
app.use(
  '/api/v1/docs',
  swaggerUi.serve,
  swaggerUi.setup(
    parse(fs.readFileSync([path.resolve(process.cwd(), '../documentation/openapi.yaml'), path.resolve(process.cwd(), 'documentation/openapi.yaml')].find(p => fs.existsSync(p)) ?? '../documentation/openapi.yaml', 'utf8')),
  ),
);

app.use(notFound);
app.use((err: any, req: any, res: any, next: any) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid input', details: err.flatten() });
    return;
  }
  errorHandler(err, req, res, next);
});

async function main() {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: 'cloudstream',                 // <-- new
    serverSelectionTimeoutMS: 15000,
  });
  startStreamingGateway();
  app.listen(env.PORT, '127.0.0.1', () =>
    console.info(`CloudStream API listening on loopback :${env.PORT} (db=${`cloudstream`})`),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});