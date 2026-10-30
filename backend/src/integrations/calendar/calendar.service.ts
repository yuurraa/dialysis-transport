import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthService } from '../../auth/auth.service';
import { SupabaseService } from '../../infrastructure/database/supabase.module';

export const GOOGLE_CALENDAR_API = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  events: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
  scope: 'https://www.googleapis.com/auth/calendar.events.owned',
} as const;
interface Tokens { access_token: string; refresh_token: string; expires_at: number }
interface Connection { account_id:string; encrypted_tokens:string|null; google_subject:string|null; status:'connected'|'reconnect'|'disconnecting'|'disconnected'; version:number }
interface Job { id:string; account_id:string; trip_id:string; revision:number; minutes:number|null; attempts:number; lease_token:string; event_id:string; desired:boolean; pickup_at:string|null; dropoff_at:string|null; session_date:string; lifecycle:string; origin:string; destination:string }
class GoogleFailure extends Error { constructor(readonly reconnect=false) { super('Calendar provider unavailable.'); } }
const unavailable=()=>new ServiceUnavailableException({code:'calendar_unavailable',message:'Calendar is temporarily unavailable.'});

/** UC-13: each recipient owns consent and events; tokens never reach the browser. */
@Injectable()
export class CalendarService implements OnModuleInit, OnModuleDestroy {
  private readonly logger=new Logger(CalendarService.name);
  private timer?:ReturnType<typeof setTimeout>;
  private readonly shutdown=new AbortController();
  constructor(@Inject(AuthService) private readonly auth:AuthService,@Inject(SupabaseService) private readonly database:SupabaseService) {}

  configured() {
    return !!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.GOOGLE_CALENDAR_REDIRECT_URI&&process.env.SUPABASE_SECRET_KEY&&/^[a-f0-9]{64}$/i.test(process.env.CALENDAR_TOKEN_ENCRYPTION_KEY??''));
  }
  private requireConfiguration() { if(!this.configured()) throw new ServiceUnavailableException({code:'calendar_unconfigured',message:'Calendar is not configured.'}); }
  private key() { this.requireConfiguration(); return Buffer.from(process.env.CALENDAR_TOKEN_ENCRYPTION_KEY!,'hex'); }
  private seal(value:unknown) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(),iv);
    const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
  }
  private unseal(value:string):Tokens {
    const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',this.key(),bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  }
  private check(error:unknown) { if(error)throw unavailable(); }
  private async access(header?:string) {
    const token=header?.match(/^Bearer (\S+)$/i)?.[1];if(!token)throw new UnauthorizedException('Sign-in required.');
    const {account}=await this.auth.verifyIdentity(token);
    if(!account||account.status!=='active'||!['patient','caregiver'].includes(account.role)||account.demo_owner_id||account.demo_access_owner_id)throw new ForbiddenException('Calendar access denied.');
    return {account,client:this.database.forUser(token)};
  }
  private async connection(id:string):Promise<Connection|null> {
    const result=await this.database.forIntegration().from('calendar_connections').select('*').eq('account_id',id).maybeSingle();this.check(result.error);return result.data;
  }
  async status(header?:string) {
    const {account}=await this.access(header);
    if(!this.configured())return {configured:false,connected:false,status:'unconfigured'};
    const c=await this.connection(account.id);
    return {configured:true,connected:c?.status==='connected',status:c?.status??'disconnected'};
  }
  async authorize(header?:string) {
    const {account}=await this.access(header);this.requireConfiguration();const db=this.database.forIntegration();
    this.check((await db.from('calendar_connections').upsert({account_id:account.id},{onConflict:'account_id',ignoreDuplicates:true})).error);
    const connection=await this.connection(account.id);if(!connection||connection.status==='disconnecting')throw new ConflictException('Calendar disconnection is still pending.');
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    this.check((await db.from('calendar_oauth_states').delete().eq('account_id',account.id)).error);
    this.check((await db.from('calendar_oauth_states').insert({state_hash:createHash('sha256').update(state).digest('hex'),account_id:account.id,connection_version:connection.version,verifier,expires_at:new Date(Date.now()+600000).toISOString()})).error);
    const url=new URL(GOOGLE_CALENDAR_API.authorization);
    url.search=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID!,redirect_uri:process.env.GOOGLE_CALENDAR_REDIRECT_URI!,response_type:'code',scope:`openid ${GOOGLE_CALENDAR_API.scope}`,access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
    return {url:url.toString()};
  }
  private async fetch(url:string,init:RequestInit) {
    // Deadline includes body consumption; never log provider bodies or credentials.
    const response=await fetch(url,{...init,signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(5000)])});
    const body=await response.text();let data:any=null;try{data=JSON.parse(body);}catch{/* Empty DELETE response. */}
    return {response,data};
  }
  async callback(query:{state?:string;code?:string;error?:string}) {
    this.requireConfiguration();if(!query.state||!/^[A-Za-z0-9_-]{43}$/.test(query.state))throw new BadRequestException('Invalid Calendar callback.');
    const db=this.database.forIntegration();
    // Atomic delete consumes state once, including denied consent.
    const state=await db.from('calendar_oauth_states').delete().eq('state_hash',createHash('sha256').update(query.state).digest('hex')).neq('verifier','confirmation').gt('expires_at',new Date().toISOString()).select('*').maybeSingle();
    this.check(state.error);if(!state.data)throw new BadRequestException('Calendar consent expired.');
    if(query.error||!query.code)return false;
    if(query.code.length>4096)throw new BadRequestException('Invalid Calendar callback.');
    const actor=await db.from('accounts').select('id,auth_user_id,role,status,demo_owner_id').eq('id',state.data.account_id).single();this.check(actor.error);
    if(!actor.data?.auth_user_id||actor.data.status!=='active'||!['patient','caregiver'].includes(actor.data.role)||actor.data.demo_owner_id)throw new ForbiddenException('Calendar access denied.');
    const identity=await db.auth.admin.getUserById(actor.data.auth_user_id);
    if(identity.error||!identity.data.user?.email_confirmed_at||!identity.data.user.identities?.some(item=>item.provider==='google'))throw new ForbiddenException('Calendar access denied.');
    const {response,data}=await this.fetch(GOOGLE_CALENDAR_API.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:query.code,client_id:process.env.GOOGLE_CLIENT_ID!,client_secret:process.env.GOOGLE_CLIENT_SECRET!,redirect_uri:process.env.GOOGLE_CALENDAR_REDIRECT_URI!,grant_type:'authorization_code',code_verifier:state.data.verifier})});
    if(!response.ok||typeof data?.access_token!=='string'||typeof data?.refresh_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0||!String(data.scope??'').split(' ').includes(GOOGLE_CALENDAR_API.scope))throw unavailable();
    // Bind grants to a stable Google account; reconnect cannot orphan events in another calendar.
    const google=await this.fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${data.access_token}`}});
    if(!google.response.ok||typeof google.data?.sub!=='string'||!google.data.sub||google.data.sub.length>255)throw unavailable();
    const connection=await this.connection(state.data.account_id);
    if(!connection||connection.version!==state.data.connection_version||connection.status==='disconnecting')throw new ConflictException('Calendar connection changed.');
    if(connection.google_subject&&connection.google_subject!==google.data.sub)throw new ConflictException({code:'calendar_account_mismatch',message:'Reconnect the previously connected Google account, or disconnect first.'});
    // Only the returning authenticated app account can consume this fresh opaque ticket.
    // The original OAuth state is not a ticket and cannot be exchanged for the grant.
    const ticket=randomBytes(32).toString('base64url');
    this.check((await db.from('calendar_oauth_states').insert({state_hash:createHash('sha256').update(ticket).digest('hex'),account_id:state.data.account_id,connection_version:state.data.connection_version,verifier:'confirmation',encrypted_tokens:this.seal({access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Date.now()+data.expires_in*1000}),google_subject:google.data.sub,expires_at:new Date(Date.now()+300000).toISOString()})).error);
    return ticket;
  }
  async confirm(header:string|undefined,body:unknown) {
    const {account}=await this.access(header);this.requireConfiguration();
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='ticket'))throw new BadRequestException('Invalid Calendar confirmation.');
    const ticket=(body as {ticket?:unknown}).ticket;
    if(typeof ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ticket))throw new BadRequestException('Invalid Calendar confirmation.');
    const db=this.database.forIntegration();
    const pending=await db.from('calendar_oauth_states').delete().eq('state_hash',createHash('sha256').update(ticket).digest('hex')).eq('account_id',account.id).eq('verifier','confirmation').gt('expires_at',new Date().toISOString()).select('*').maybeSingle();
    this.check(pending.error);if(!pending.data?.encrypted_tokens||!pending.data.google_subject)throw new BadRequestException('Calendar consent expired or belongs to another account.');
    const current=await this.connection(account.id);
    if(current?.google_subject&&current.google_subject!==pending.data.google_subject)throw new ConflictException('Reconnect the previously connected Google account.');
    const saved=await db.from('calendar_connections').update({encrypted_tokens:pending.data.encrypted_tokens,google_subject:pending.data.google_subject,status:'connected',version:pending.data.connection_version+1,updated_at:new Date().toISOString()}).eq('account_id',account.id).eq('version',pending.data.connection_version).neq('status','disconnecting').select('account_id').maybeSingle();
    this.check(saved.error);if(!saved.data)throw new ConflictException('Calendar connection changed. Try connecting again.');
    return {configured:true,connected:true,status:'connected'};
  }
  async disconnect(header?:string) {
    const {account}=await this.access(header);this.requireConfiguration();const db=this.database.forIntegration(),c=await this.connection(account.id);
    this.check((await db.from('calendar_oauth_states').delete().eq('account_id',account.id)).error);
    if(c){const saved=await db.from('calendar_connections').update({status:'disconnecting',version:c.version+1}).eq('account_id',account.id).eq('version',c.version).select('account_id').maybeSingle();this.check(saved.error);if(!saved.data)throw new ConflictException('Calendar connection changed. Please try again.');}
    return {connected:false,status:c?'disconnecting':'disconnected'};
  }
  private async trip(header:string|undefined,id:string) {
    if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new BadRequestException('Invalid trip.');
    const access=await this.access(header),result=await access.client.from('trips').select('id,demo_owner_id').eq('id',id).is('deleted_at',null).maybeSingle();
    this.check(result.error);if(!result.data)throw new NotFoundException('Trip unavailable.');if(result.data.demo_owner_id)throw new ForbiddenException('Calendar is unavailable for demo trips.');
    return access;
  }
  async reminder(header:string|undefined,id:string) {
    const {account}=await this.trip(header,id);if(!this.configured())return {configured:false,connected:false,enabled:false};
    const c=await this.connection(account.id),r=await this.database.forIntegration().from('calendar_reminders').select('enabled,minutes,sync_status').eq('account_id',account.id).eq('trip_id',id).maybeSingle();this.check(r.error);
    return {configured:true,connected:c?.status==='connected',status:c?.status??'disconnected',enabled:false,minutes:null,...r.data};
  }
  async setReminder(header:string|undefined,id:string,body:unknown) {
    const {client}=await this.trip(header,id);this.requireConfiguration();
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['minutes','enabled'].includes(k)))throw new BadRequestException('Invalid reminder.');
    const input=body as {minutes?:unknown;enabled?:unknown};if((input.minutes!==null&&![15,30,60,120,1440].includes(input.minutes as number))||typeof input.enabled!=='boolean')throw new BadRequestException('Invalid reminder.');
    const result=await client.rpc('calendar_set_reminder',{target:id,reminder_minutes:input.minutes,desired:input.enabled});
    if(result.error?.code==='42501')throw new ForbiddenException('Calendar access denied.');if(result.error?.code==='22023')throw new BadRequestException('Connect Calendar before adding an event.');this.check(result.error);return result.data;
  }
  private async token(c:Connection) {
    if(!c.encrypted_tokens)throw new GoogleFailure(true);
    const tokens=this.unseal(c.encrypted_tokens);if(tokens.expires_at>Date.now()+60000)return tokens.access_token;
    const {response,data}=await this.fetch(GOOGLE_CALENDAR_API.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID!,client_secret:process.env.GOOGLE_CLIENT_SECRET!,refresh_token:tokens.refresh_token,grant_type:'refresh_token'})});
    if(!response.ok){throw new GoogleFailure(data?.error==='invalid_grant'||data?.error==='invalid_client');}
    if(typeof data?.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new GoogleFailure();
    const next={access_token:data.access_token,refresh_token:data.refresh_token??tokens.refresh_token,expires_at:Date.now()+data.expires_in*1000};
    const updated=await this.database.forIntegration().from('calendar_connections').update({encrypted_tokens:this.seal(next)}).eq('account_id',c.account_id).eq('version',c.version).select('account_id').maybeSingle();
    this.check(updated.error);if(!updated.data)throw new GoogleFailure();return next.access_token;
  }
  private async sync(job:Job) {
    const db=this.database.forIntegration();const c=await this.connection(job.account_id);if(!c)return;
    const filters=()=>db.from('calendar_reminders').update({...(!job.desired?{event_id:randomUUID(),enabled:false}:{}),synced_revision:job.revision,sync_status:'synced',attempts:0,lease_token:null,lease_until:null}).eq('id',job.id).eq('revision',job.revision).eq('lease_token',job.lease_token);
    try {
      if(!c.encrypted_tokens&&!job.desired){this.check((await filters()).error);return;}
      const token=await this.token(c);let eventId=job.event_id.replace(/-/g,'');
      const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
      const nextDay=new Date(Date.parse(`${job.session_date}T00:00:00Z`)+86400000).toISOString().slice(0,10);
      const event={summary:job.lifecycle==='cancelled'?'Transport pickup (cancelled)':'Transport pickup',location:job.origin,
        description:`${job.pickup_at?'':'Pickup time to be confirmed.\n'}Destination: ${job.destination}`,
        start:job.pickup_at?{dateTime:job.pickup_at,timeZone:'Asia/Singapore'}:{date:job.session_date},
        end:job.pickup_at?{dateTime:job.dropoff_at??new Date(Date.parse(job.pickup_at)+1800000).toISOString(),timeZone:'Asia/Singapore'}:{date:nextDay},
        reminders:{useDefault:false,overrides:job.minutes===null?[]:[{method:'popup',minutes:job.minutes}]}};
      let result=await this.fetch(`${GOOGLE_CALENDAR_API.events}/${eventId}`,{method:job.desired?'PUT':'DELETE',headers,...(job.desired?{body:JSON.stringify(event)}:{})});
      if(job.desired&&result.response.status===410){
        // Google keeps deleted event IDs as tombstones. Persist a fresh ID before retrying.
        const event_id=randomUUID();
        const rotated=await db.from('calendar_reminders').update({event_id}).eq('id',job.id).eq('revision',job.revision).eq('lease_token',job.lease_token).select('id').maybeSingle();
        this.check(rotated.error);if(!rotated.data)return;eventId=event_id.replace(/-/g,'');
        result=await this.fetch(`${GOOGLE_CALENDAR_API.events}/${eventId}`,{method:'PUT',headers,body:JSON.stringify(event)});
      }
      if(job.desired&&result.response.status===404){
        result=await this.fetch(GOOGLE_CALENDAR_API.events,{method:'POST',headers,body:JSON.stringify({id:eventId,...event})});
        if(result.response.status===409)result=await this.fetch(`${GOOGLE_CALENDAR_API.events}/${eventId}`,{method:'PUT',headers,body:JSON.stringify(event)});
      }
      if(!result.response.ok&&!(!job.desired&&[404,410].includes(result.response.status)))throw new GoogleFailure([401,403].includes(result.response.status)&&!['rateLimitExceeded','userRateLimitExceeded','quotaExceeded','dailyLimitExceeded'].includes(result.data?.error?.errors?.[0]?.reason));
      this.check((await filters()).error);
    } catch(error) {
      const reconnect=error instanceof GoogleFailure&&error.reconnect;
      if(reconnect&&c.status==='disconnecting'){this.check((await filters()).error);return;}
      if(reconnect)this.check((await db.from('calendar_connections').update({status:'reconnect'}).eq('account_id',job.account_id).eq('version',c.version).neq('status','disconnecting')).error);
      this.check((await db.from('calendar_reminders').update({sync_status:reconnect?'reconnect':'retry',attempts:job.attempts+1,next_attempt_at:new Date(Date.now()+Math.min(1800000,30000*2**Math.min(job.attempts,6))).toISOString(),lease_token:null,lease_until:null}).eq('id',job.id).eq('revision',job.revision).eq('lease_token',job.lease_token)).error);
    } finally {
      // A newer trip revision stays pending, but need not wait out the old lease.
      this.check((await db.from('calendar_reminders').update({lease_token:null,lease_until:null}).eq('id',job.id).eq('lease_token',job.lease_token)).error);
    }
  }
  /** Durable work survives restarts; leases prevent two backends publishing the same job concurrently. */
  async synchronize() {
    this.requireConfiguration();const db=this.database.forIntegration();
    this.check((await db.from('calendar_oauth_states').delete().lt('expires_at',new Date().toISOString())).error);
    const jobs=await db.rpc('calendar_claim_jobs');this.check(jobs.error);
    for(const job of (jobs.data??[]) as Job[]) {if(this.shutdown.signal.aborted)return;await this.sync(job);}
    const closing=await db.rpc('calendar_claim_disconnects');this.check(closing.error);
    for(const c of closing.data??[]) {
      if(c.encrypted_tokens){const tokens=this.unseal(c.encrypted_tokens);const result=await this.fetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:tokens.refresh_token})});if(!result.response.ok&&![400,401].includes(result.response.status))continue;}
      // Retain a monotonic connection version and clear reminders/credentials atomically.
      this.check((await db.rpc('calendar_finish_disconnect',{target:c.account_id,expected_version:c.version,token:c.cleanup_token})).error);
    }
  }
  onModuleInit() {
    if(process.env.NODE_ENV==='test'||!this.configured())return;
    const run=async()=>{try{await this.synchronize();}catch{if(!this.shutdown.signal.aborted)this.logger.warn('Calendar sync unavailable; reminders remain queued.');}finally{if(!this.shutdown.signal.aborted){this.timer=setTimeout(run,30000);this.timer.unref();}}};
    this.timer=setTimeout(run,1000);this.timer.unref();
  }
  onModuleDestroy(){this.shutdown.abort();if(this.timer)clearTimeout(this.timer);}
}
