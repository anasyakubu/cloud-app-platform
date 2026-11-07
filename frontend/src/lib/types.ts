export type User={id:string;name:string;email:string;role:'user'|'admin'|'super_admin';verified:boolean};
export type App={_id:string;name:string;description:string;category:string;os:'linux';format:'appimage'|'tar.gz';version:string;status:string;startupExecutable:string;requirements:{cpu:number;ramGb:number;storageGb:number;gpu:boolean};currentVersion?:{_id:string;version:string;size:number;scanReport?:string;status:string};createdAt:string;lastLaunchedAt?:string};
export type Config={_id:string;name:string;instanceType:string;cpu:number;ramGb:number;gpu:number;storageGb:number;priceKoboPerHour:number;enabled:boolean;verifiedAt?:string};
export type Session={_id:string;user:string;app:{_id:string;name:string}|string;configuration:string;instanceId?:string;instanceType:string;cpu:number;ramGb:number;gpu:number;maxMinutes:number;holdKobo:number;sessionCostKobo:number;state:string;createdAt:string;runningAt?:string;endedAt?:string;failureReason?:string};
export type Wallet={balanceKobo:number;reservedKobo:number;currency:string};
export type Transaction={_id:string;kind:string;amountKobo:number;status:string;reference:string;createdAt:string};
export const fmtMoney=(value:number=0)=>new Intl.NumberFormat('en-NG',{style:'currency',currency:'NGN'}).format(value/100);
export const fmtDate=(value?:string)=>value?new Intl.DateTimeFormat('en-NG',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
export const liveStates=['queued','pending','provisioning','preparing','starting','running','reconnecting','stopping'];
