import type {Request,Response,NextFunction} from 'express';
import jwt from 'jsonwebtoken';
import {User} from '../models/index.js';
import {env} from '../config/env.js';
import {asyncRoute,HttpError} from '../utils/http.js';

declare global { namespace Express {interface Request{auth?:{id:string;role:'user'|'admin'|'super_admin'}}} }
export const authenticate=asyncRoute(async(req:Request,_res:Response,next:NextFunction)=>{const value=req.header('authorization');if(!value?.startsWith('Bearer '))throw new HttpError(401,'Authentication required');let data:{sub:string;type:string};try{data=jwt.verify(value.slice(7),env.JWT_ACCESS_SECRET,{algorithms:['HS256']}) as typeof data;}catch{throw new HttpError(401,'Invalid or expired token');}if(data.type!=='access')throw new HttpError(401,'Invalid token');const user=await User.findById(data.sub);if(!user||user.suspendedAt)throw new HttpError(403,'Account unavailable or suspended');req.auth={id:user.id,role:user.role as 'user'|'admin'|'super_admin'};next();});
export function authorize(...roles:Array<'admin'|'super_admin'>){return (req:Request,_res:Response,next:NextFunction)=>req.auth&&roles.includes(req.auth.role as 'admin'|'super_admin')?next():next(new HttpError(403,'Permission denied'));}
