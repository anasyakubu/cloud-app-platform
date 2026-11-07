import crypto from 'node:crypto';
import {env} from '../config/env.js';
const key=Buffer.from(env.DATA_ENCRYPTION_KEY,'hex');
export function encryptSecret(value:string){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(v=>v.toString('base64url')).join('.');}
export function decryptSecret(ciphertext:string){const [iv,tag,data]=ciphertext.split('.');if(!iv||!tag||!data)throw new Error('Invalid ciphertext');const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');}
export const randomToken=()=>crypto.randomBytes(32).toString('base64url');
export const sha256=(input:string)=>crypto.createHash('sha256').update(input).digest('hex');
