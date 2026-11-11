import 'dotenv/config';
import { z } from 'zod';

const parsed = z.object({
 NODE_ENV:z.enum(['production','development','test']).default('development'), PORT:z.coerce.number().int().positive().default(4000),
 MONGODB_URI:z.string().min(1), JWT_ACCESS_SECRET:z.string().min(32), JWT_REFRESH_SECRET:z.string().min(32),
 DATA_ENCRYPTION_KEY:z.string().regex(/^[a-fA-F0-9]{64}$/), GUAC_TOKEN_KEY:z.string().regex(/^[a-fA-F0-9]{64}$/),
 AWS_REGION:z.string().min(1),AWS_CLOUDWATCH_LOG_GROUP:z.string().default('/cloudstream/execution'), AWS_S3_BUCKET:z.string().min(1), AWS_SQS_QUEUE_URL:z.string().min(1),
 AWS_EXECUTION_ROLE:z.string().min(1), AWS_EXECUTION_SECURITY_GROUP:z.string().min(1),AWS_EXECUTION_SUBNET:z.string().min(1),AWS_EC2_AMI_ID:z.string().min(1),
 AWS_STREAMING_CONFIGURATION:z.string().default('guacamole-vnc'), FRONTEND_URL:z.string().url(),FRONTEND_ORIGINS:z.string().default(''),PUBLIC_API_URL:z.string().url(),
 VITE_STREAMING_BASE_URL:z.string().default('ws://localhost:8081'), GUAC_HOST:z.string().default('127.0.0.1'),GUAC_PORT:z.coerce.number().default(8081),GUACD_HOST:z.string().default('127.0.0.1'),GUACD_PORT:z.coerce.number().default(4822),
 PAYSTACK_SECRET_KEY:z.string().optional().default(''),PAYSTACK_CALLBACK_URL:z.string().url().optional(),SES_FROM_EMAIL:z.string().optional().default(''),SES_ENABLED:z.string().default('false').transform(v=>v==='true'),
 REQUIRE_ADMIN_APPROVAL:z.string().default('true').transform(v=>v==='true'),UPLOAD_MAX_BYTES:z.coerce.number().int().positive().default(2147483648),MAX_SESSIONS_PER_USER:z.coerce.number().int().positive().default(1),DEFAULT_MAX_SESSION_MINUTES:z.coerce.number().int().positive().default(60),UPLOAD_URL_TTL_SECONDS:z.coerce.number().int().min(60).max(3600).default(900),APP_PRESIGNED_GET_TTL_SECONDS:z.coerce.number().int().min(60).default(3600),IDLE_TIMEOUT_MINUTES:z.coerce.number().int().positive().default(15),AWS_INSTANCE_MAX_AGE_MINUTES:z.coerce.number().int().positive().default(180)
}).safeParse(process.env);
if(!parsed.success){console.error(parsed.error.flatten().fieldErrors); throw new Error('Invalid backend environment');}
export const env=parsed.data;
