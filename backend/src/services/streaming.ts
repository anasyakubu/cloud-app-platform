import crypto from 'node:crypto';
import {Session} from '../models/index.js';
import {env} from '../config/env.js';
import {decryptSecret} from '../utils/crypto.js';
import {HttpError} from '../utils/http.js';

const guacKey=Buffer.from(env.GUAC_TOKEN_KEY,'hex');
const mac=(message:string)=>crypto.createHmac('sha256',guacKey).update(message).digest('hex');

/** guacamole-lite's legacy Crypt decoder decodes the IV with 'ascii'. An ASCII hex IV
 * remains valid after its decoding; randomBytes directly would not. The IV is unique
 * per ticket and the complete connection is separately HMAC-authenticated. */
function createGuacToken(value:object){
 const iv=Buffer.from(crypto.randomBytes(16).toString('hex').slice(0,16),'ascii');
 const cipher=crypto.createCipheriv('aes-256-cbc',guacKey,iv);
 const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
 return Buffer.from(JSON.stringify({iv:iv.toString('base64'),value:data.toString('base64')})).toString('base64');
}

/** Only an authorized owner can mint a short-lived, signed stream ticket. The gateway
 * validates tickets synchronously before guacamole-lite opens a guacd TCP connection.
 * This is required because guacamole-lite does NOT await async settings callbacks. */
export async function connectionTicket(sessionId:string,userId:string){
 const s=await Session.findOne({_id:sessionId,user:userId,state:{$in:['running','reconnecting']}}).select('+vncSecret +privateIp');
 if(!s||!s.privateIp||!s.vncSecret)throw new HttpError(409,'Session streaming is not ready');
 const payload={sessionId:s.id,userId,instanceId:s.instanceId,expiration:Date.now()+60_000,host:s.privateIp,password:decryptSecret(s.vncSecret)};
 const value={...payload,signature:mac(JSON.stringify(payload)),connection:{type:'vnc',settings:{hostname:payload.host,port:'5901',password:payload.password,'read-only':false,'color-depth':'24',audio:[],width:1280,height:800,dpi:96}}};
 return {url:`${env.VITE_STREAMING_BASE_URL}/?token=${encodeURIComponent(createGuacToken(value))}`,expiresAt:new Date(payload.expiration).toISOString()};
}

export function startStreamingGateway(){
 // A dedicated guacd process bridges VNC to the Guacamole protocol. Nginx proxies
 // only the /stream WebSocket location to the loopback-only gateway.
 // eslint-disable-next-line @typescript-eslint/no-require-imports
 const GuacamoleLite=require('guacamole-lite');
 return new GuacamoleLite({host:env.GUAC_HOST,port:env.GUAC_PORT},{host:env.GUACD_HOST,port:env.GUACD_PORT},{crypt:{cypher:'AES-256-CBC',key:guacKey},log:{level:'ERRORS'},maxInactivityTime:120000},{processConnectionSettings:(settings:any,callback:(e:Error|null,s?:any)=>void)=>{
  try{
   if(!settings||!settings.sessionId||!settings.userId||!settings.instanceId||typeof settings.expiration!=='number'||settings.expiration<Date.now()||settings.expiration>Date.now()+65000)throw new Error('Invalid or expired streaming ticket');
   const {sessionId,userId,instanceId,expiration,host,password,signature}=settings;
   if(typeof host!=='string'||!/^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(host)||typeof password!=='string'||password.length!==8)throw new Error('Invalid VNC target');
   const expected=mac(JSON.stringify({sessionId,userId,instanceId,expiration,host,password}));
   if(typeof signature!=='string'||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new Error('Invalid streaming ticket signature');
   // Settings must be FLAT at this point (guacamole-lite has already merged
   // 'connection.settings' into 'connection'). Never trust query overrides.
   settings.connection={hostname:host,port:'5901',password,'read-only':false,'color-depth':'24',audio:[],width:1280,height:800,dpi:96,image:['image/png','image/jpeg']};
   callback(null,settings); // synchronous: connect() is called immediately afterwards
   void Session.updateOne({_id:sessionId,user:userId,instanceId,state:{$in:['running','reconnecting']}},{$set:{lastConnectedAt:new Date(),state:'running'}}).catch(e=>console.error('Streaming activity update failed',e));
  }catch(error){callback(error as Error);}
 }});
}
