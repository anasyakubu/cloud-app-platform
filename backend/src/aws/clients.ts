import {EC2Client} from '@aws-sdk/client-ec2';
import {S3Client} from '@aws-sdk/client-s3';
import {SQSClient,SendMessageCommand} from '@aws-sdk/client-sqs';
import {SSMClient} from '@aws-sdk/client-ssm';
import {SESClient} from '@aws-sdk/client-ses';
import {CloudWatchClient} from '@aws-sdk/client-cloudwatch';
import {env} from '../config/env.js';
export const ec2=new EC2Client({region:env.AWS_REGION});
export const s3=new S3Client({region:env.AWS_REGION});
export const sqs=new SQSClient({region:env.AWS_REGION});
export const ssm=new SSMClient({region:env.AWS_REGION});
export const ses=new SESClient({region:env.AWS_REGION});
export const cw=new CloudWatchClient({region:env.AWS_REGION});
export type Job={kind:'scan';versionId:string}|{kind:'launch'|'stop';sessionId:string};
export async function queue(job:Job){await sqs.send(new SendMessageCommand({QueueUrl:env.AWS_SQS_QUEUE_URL,MessageBody:JSON.stringify(job)}));}
