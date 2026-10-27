import type { Account } from '../pages/AccountPanel';

export interface DemoSession { access_token:string; expires_at:number; account:Account }
// Tab-local memory only. Reloading returns to the original Google account; no demo
// refresh token is issued to the browser or written to persistent storage.
let session:DemoSession|null=null;
export const demoSessionEvent='demo-session-changed';
export function getDemoSession(){return session;}
export function setDemoSession(value:DemoSession|null){session=value;window.dispatchEvent(new Event(demoSessionEvent));}
