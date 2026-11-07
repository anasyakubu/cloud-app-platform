import axios,{AxiosError} from 'axios';
import {useAuth} from '../store/auth';
const baseURL=import.meta.env.VITE_API_URL||'http://localhost:4000/api/v1';
export const api=axios.create({baseURL,withCredentials:true,timeout:30000});
api.interceptors.request.use(config=>{const token=useAuth.getState().accessToken;if(token)config.headers.Authorization=`Bearer ${token}`;return config;});
let refreshing:Promise<string>|null=null;
export async function restoreAuth(){try{const {data}=await api.post('/auth/refresh');useAuth.getState().setAuth(data.accessToken,data.user);}catch{useAuth.getState().clear();}}
api.interceptors.response.use(response=>response,async(error:AxiosError)=>{const config:any=error.config;if(error.response?.status===401&&config&&!config._retry&&!String(config.url).includes('/auth/')){config._retry=true;try{refreshing??=axios.post(`${baseURL}/auth/refresh`,{}, {withCredentials:true}).then(r=>{useAuth.getState().setAuth(r.data.accessToken,r.data.user);return r.data.accessToken}).finally(()=>refreshing=null);const token=await refreshing;config.headers.Authorization=`Bearer ${token}`;return api(config);}catch{useAuth.getState().clear();}}return Promise.reject(error);});
export const message=(error:any)=>error?.response?.data?.error||error?.message||'An unexpected error occurred';
