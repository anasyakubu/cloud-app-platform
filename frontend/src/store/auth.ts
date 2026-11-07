import {create} from 'zustand';
import type {User} from '../lib/types';
export const useAuth=create<{user:User|null;accessToken:string|null;ready:boolean;setAuth:(token:string,user:User)=>void;clear:()=>void;setReady:()=>void}>((set)=>({user:null,accessToken:null,ready:false,setAuth:(accessToken,user)=>set({accessToken,user,ready:true}),clear:()=>set({user:null,accessToken:null,ready:true}),setReady:()=>set({ready:true})}));
