import type {Request,Response,NextFunction} from 'express';
import mongoose from 'mongoose';
export class HttpError extends Error{constructor(public status:number,message:string){super(message);}}
export function asyncRoute(fn:(req:Request,res:Response,next:NextFunction)=>Promise<unknown>){return (req:Request,res:Response,next:NextFunction)=>Promise.resolve(fn(req,res,next)).catch(next);}
export function assertId(id:string){if(!mongoose.isValidObjectId(id))throw new HttpError(400,'Invalid resource ID');return id;}
export function page(req:Request){return {skip:(Math.min(1000,Math.max(1,Number(req.query.page)||1))-1)*Math.min(100,Math.max(1,Number(req.query.limit)||20)),limit:Math.min(100,Math.max(1,Number(req.query.limit)||20))};}
export function errorHandler(err:unknown,_req:Request,res:Response,_next:NextFunction){const e=err as {status?:number;message?:string;code?:number;name?:string}; const status=e.status|| (e.code===11000?409:e.name==='ValidationError'?400:500);if(status>=500) console.error('[API]',err);res.status(status).json({error:status>=500?'Internal server error':e.message||'Request failed'});}
export function notFound(_req:Request,res:Response){res.status(404).json({error:'Route not found'});}
