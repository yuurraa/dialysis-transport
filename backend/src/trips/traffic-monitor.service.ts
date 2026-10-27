import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { TripRoutingService } from './trip-routing.service';
import { SupabaseService } from '../supabase.module';

/** Leased batches allow multiple backend instances without duplicate continuous work. */
@Injectable()
export class TrafficMonitorService implements OnModuleInit, OnModuleDestroy {
  private timer:ReturnType<typeof setInterval>|undefined;
  private running=false;
  private stopped=false;
  private warned=false;
  private recoveryWarned=false;
  private readonly logger=new Logger(TrafficMonitorService.name);
  constructor(@Inject(SupabaseService) private readonly database:SupabaseService,@Inject(TripRoutingService) private readonly routes:TripRoutingService) {}

  onModuleInit() {
    if(process.env.NODE_ENV==='test'||process.env.TRAFFIC_MONITOR_ENABLED==='false')return;
    if(!['SUPABASE_URL','SUPABASE_SECRET_KEY','ONEMAP_EMAIL','ONEMAP_PASSWORD','LTA_ACCOUNT_KEY'].every(key=>!!process.env[key]))return;
    void this.run();
    this.timer=setInterval(()=>void this.run(),15000);
    this.timer.unref();
  }
  onModuleDestroy() {this.stopped=true;if(this.timer)clearInterval(this.timer);}

  private async run() {
    if(this.running||this.stopped)return;
    this.running=true;
    try {
      const client=this.database.forIntegration();
      const claimed=await client.rpc('claim_trip_traffic_checks').abortSignal(AbortSignal.timeout(5000));
      if(claimed.error||!Array.isArray(claimed.data))throw new Error('Traffic work unavailable.');
      const ids=claimed.data.filter((id:unknown):id is string=>typeof id==='string');
      let index=0,failed=false;
      await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
        while(index<ids.length&&!this.stopped){
          const id=ids[index++];
          try {await this.routes.traffic(client,id,true);}
          catch {failed=true;}
        }
      }));
      if(failed)throw new Error('Traffic assessment unavailable.');
      this.warned=false;
    } catch {
      // Provider/database details can contain credentials or transport data.
      if(!this.warned){this.logger.warn('Traffic monitoring is unavailable. Existing trip assignments and review flags are preserved.');this.warned=true;}
    } finally {if(!this.stopped)await this.runRecovery();this.running=false;}
  }

  private async runRecovery(){
    try{
      const client=this.database.forIntegration();
      const claimed=await client.rpc('claim_trip_recovery_checks').abortSignal(AbortSignal.timeout(5000));
      if(claimed.error||!Array.isArray(claimed.data))throw new Error('Recovery work unavailable.');
      const rows=claimed.data.filter((row:unknown):row is {id:string;version:number}=>!!row&&typeof row==='object'&&typeof (row as {id?:unknown}).id==='string'&&Number.isInteger((row as {version?:unknown}).version));
      let index=0,failed=false;
      await Promise.all(Array.from({length:Math.min(2,rows.length)},async()=>{
        while(index<rows.length&&!this.stopped){
          const row=rows[index++];
          try{await this.routes.automaticRecovery(row.id,row.version);}catch{failed=true;}
        }
      }));
      if(failed)throw new Error('Recovery assessment unavailable.');
      this.recoveryWarned=false;
    }catch{
      if(!this.recoveryWarned){this.logger.warn('Automatic recovery proposals are unavailable. Existing bookings are preserved; coordinator approval remains required.');this.recoveryWarned=true;}
    }
  }
}
