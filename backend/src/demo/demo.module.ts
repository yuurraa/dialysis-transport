import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, Injectable, Module, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { SupabaseService } from '../supabase.module';
import { TripsModule } from '../trips/trips.module';
import { TripsService } from '../trips/trips.service';

interface DemoActor { id:string; auth_user_id:string|null; email:string; role:string; status:'active'|'inactive'; demo_access_owner_id:string; seed_key:string }
interface DemoState { actors:DemoActor[]; scenario:{trip_id:string;progress:number;traffic:string}|null; trip:{id:string;lifecycle:string;demo_owner_id:string}|null }

/** Fixture controls require the real Google coordinator, even while viewing a demo actor. */
@Injectable()
export class DemoService {
  private readonly preparing=new Map<string,Promise<DemoState>>();
  constructor(@Inject(AuthService) private readonly auth:AuthService,@Inject(SupabaseService) private readonly database:SupabaseService,@Inject(TripsService) private readonly trips:TripsService) {}

  private async owner(header?:string) {
    if(process.env.DEMO_ENABLED!=='true')throw new ForbiddenException({code:'demo_disabled'});
    const token=header?.match(/^Bearer (\S+)$/i)?.[1];
    if(!token)throw new UnauthorizedException('Sign-in required.');
    const {account}=await this.auth.verifyIdentity(token);
    if(!account||account.status!=='active'||account.role!=='coordinator'||!account.demo_admin||account.demo_owner_id||account.demo_access_owner_id)throw new ForbiddenException({code:'demo_forbidden'});
    return {id:account.id,token};
  }
  private async manage(owner:string,action:string,details:Record<string,unknown>={}) {
    const result=await this.database.forIntegration().rpc('demo_manage',{owner,action,details});
    if(result.error){
      if(result.error.code==='P5003')throw new ServiceUnavailableException({code:'dummy_seed_missing'});
      if(result.error.code==='42501')throw new ForbiddenException({code:'demo_forbidden'});
      if(['22023','PT409','23514','22P02'].includes(result.error.code??''))throw new BadRequestException({code:'demo_action_unavailable'});
      throw new ServiceUnavailableException({code:'demo_unavailable'});
    }
    return result.data as DemoState;
  }
  async state(header?:string) {const owner=await this.owner(header);return this.manage(owner.id,'state');}
  async setup(header?:string) {
    const owner=await this.owner(header);
    const pending=this.preparing.get(owner.id);if(pending)return pending;
    const work=(async()=>{
      const state=await this.manage(owner.id,'setup');
      for(const actor of state.actors){
        if(actor.auth_user_id)continue;
        const admin=this.database.forIntegration().auth.admin;
        const created=await admin.createUser({id:actor.id,email:actor.email,email_confirm:true,
          app_metadata:{demo_account_id:actor.id,demo_owner_id:owner.id}});
        const user=created.data.user??(await admin.getUserById(actor.id)).data.user;
        if(!user||user.id!==actor.id||user.email!==actor.email||user.app_metadata.demo_account_id!==actor.id||user.app_metadata.demo_owner_id!==owner.id)
          throw new ServiceUnavailableException({code:'demo_identity_unavailable'});
        await this.manage(owner.id,'attach',{account_id:actor.id});
      }
      return this.manage(owner.id,'state');
    })();
    this.preparing.set(owner.id,work);
    try{return await work;}finally{this.preparing.delete(owner.id);}
  }
  async switchActor(header:string|undefined,body:unknown) {
    const owner=await this.owner(header);
    const input=this.input(body,['account_id']);
    const state=await this.manage(owner.id,'state');
    const actor=state.actors.find(a=>a.id===input.account_id&&a.demo_access_owner_id===owner.id&&a.auth_user_id===a.id&&a.status==='active');
    if(!actor)throw new ForbiddenException({code:'demo_forbidden'});
    const existing=await this.database.forIntegration().auth.admin.getUserById(actor.id);
    if(existing.error||!existing.data.user||existing.data.user.email!==actor.email||existing.data.user.app_metadata.demo_account_id!==actor.id||existing.data.user.app_metadata.demo_owner_id!==owner.id)
      throw new ServiceUnavailableException({code:'demo_identity_unavailable'});
    const link=await this.database.forIntegration().auth.admin.generateLink({type:'magiclink',email:actor.email});
    if(link.error||link.data.user.id!==actor.id||!link.data.properties.hashed_token)throw new ServiceUnavailableException({code:'demo_identity_unavailable'});
    // A fresh client prevents replacing either the administrator or service-key session.
    const verified=await this.database.forUser(owner.token).auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});
    if(verified.error||!verified.data.session||verified.data.user?.id!==actor.id)throw new ServiceUnavailableException({code:'demo_identity_unavailable'});
    await this.owner(header); // Recheck capability after provider work.
    const session=verified.data.session;
    const identity=await this.auth.verifyIdentity(session.access_token);
    return {access_token:session.access_token,expires_at:session.expires_at,account:identity.account};
  }
  async control(header:string|undefined,body:unknown) {
    const owner=await this.owner(header),input=this.input(body,['action','scenario','percent','confirmed']);
    if(!['due','traffic','move','reset'].includes(String(input.action)))throw new BadRequestException('Invalid demo control.');
    if(input.action==='move'){
      if(!Number.isInteger(input.percent)||(input.percent as number)<0||(input.percent as number)>100)throw new BadRequestException('Choose a position from 0 to 100.');
      const state=await this.manage(owner.id,'state');
      if(!state.trip||state.trip.demo_owner_id!==owner.id||state.trip.lifecycle!=='in-progress')throw new BadRequestException({code:'demo_action_unavailable'});
      const result=await this.trips.tripRoute(header,state.trip.id);
      const geometry=result.route.geometry;
      // Interpolate by distance, so a dense section of the polyline does not slow movement.
      const lengths=geometry.slice(1).map((point,index)=>Math.hypot((point[0]-geometry[index][0])*111320,(point[1]-geometry[index][1])*111320*Math.cos(point[0]*Math.PI/180)));
      let remaining=lengths.reduce((sum,length)=>sum+length,0)*(input.percent as number)/100;
      let point=geometry[geometry.length-1];
      for(let i=0;i<lengths.length;i++){
        if(remaining<=lengths[i]){const ratio=lengths[i]?remaining/lengths[i]:0;point=[geometry[i][0]+(geometry[i+1][0]-geometry[i][0])*ratio,geometry[i][1]+(geometry[i+1][1]-geometry[i][1])*ratio];break;}
        remaining-=lengths[i];
      }
      if(!point)throw new ServiceUnavailableException({code:'route_unavailable'});
      return this.manage(owner.id,'move',{percent:input.percent,point:{latitude:point[0],longitude:point[1]}});
    }
    return this.manage(owner.id,String(input.action),input);
  }
  private input(body:unknown,keys:string[]) {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!keys.includes(key)))throw new BadRequestException('Invalid demo request.');
    return body as Record<string,unknown>;
  }
}

@Controller('demo')
export class DemoController {
  constructor(@Inject(DemoService) private readonly demo:DemoService) {}
  @Get() state(@Headers('authorization') header?:string){return this.demo.state(header);}
  @Post('setup') setup(@Headers('authorization') header:string|undefined){return this.demo.setup(header);}
  @Post('switch') switchActor(@Headers('authorization') header:string|undefined,@Body() body:unknown){return this.demo.switchActor(header,body);}
  @Post('control') control(@Headers('authorization') header:string|undefined,@Body() body:unknown){return this.demo.control(header,body);}
}
@Module({imports:[AuthModule,TripsModule],controllers:[DemoController],providers:[DemoService]})
export class DemoModule {}
