import mongoose from 'mongoose';
import 'dotenv/config';
import argon2 from 'argon2';
import {env} from '../config/env.js';
import {User,Wallet} from '../models/index.js';
async function main(){const email=process.env.ADMIN_EMAIL,password=process.env.ADMIN_PASSWORD;if(!email||!password||password.length<16)throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (16+ chars) required');await mongoose.connect(env.MONGODB_URI);const found=await User.findOne({email});if(found)throw new Error('Admin email already exists; refusing to overwrite');const admin=await User.create({name:'Platform Administrator',email,passwordHash:await argon2.hash(password),role:'super_admin',verifiedAt:new Date()});await Wallet.create({user:admin.id});console.log('Admin account created:',email);await mongoose.disconnect();}
main().catch(e=>{console.error(e);process.exit(1)});
