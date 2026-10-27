import type { DrivingRoute } from '../integrations/onemap.service';
import type { TrafficSnapshot, RoadSpeedBand } from '../integrations/lta.service';

// Local metric projection is sufficient for proximity, not route navigation.
const x=(point:[number,number])=>point[1]*111200*Math.cos(1.32*Math.PI/180);
const y=(point:[number,number])=>point[0]*111200;
const point=(value:{latitude:number;longitude:number}):[number,number]=>[value.latitude,value.longitude];
const distance=(a:[number,number],b:[number,number])=>Math.hypot(x(a)-x(b),y(a)-y(b));
function proximity(p:[number,number],a:[number,number],b:[number,number]) {
  const dx=x(b)-x(a),dy=y(b)-y(a),length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,((x(p)-x(a))*dx+(y(p)-y(a))*dy)/length)):0;
  return Math.hypot(x(p)-x(a)-t*dx,y(p)-y(a)-t*dy);
}
const key=(a:number,b:number)=>`${a},${b}`;
const cell=(p:[number,number])=>[Math.floor(x(p)/200),Math.floor(y(p)/200)];

/** Nearby observations are advisory: grade separation and lane identity are not supplied. */
export function routeTraffic(route:DrivingRoute,snapshot:TrafficSnapshot) {
  const geometry=route.geometry;
  const roads=new Map<string,RoadSpeedBand[]>();
  for(const road of snapshot.speedBands){
    const start=point(road.start),end=point(road.end),a=cell(start),b=cell(end);
    // Unreasonably long feed links cannot establish local route correspondence.
    if(distance(start,end)>5000)continue;
    for(let i=Math.min(a[0],b[0])-1;i<=Math.max(a[0],b[0])+1;i++)for(let j=Math.min(a[1],b[1])-1;j<=Math.max(a[1],b[1])+1;j++){
      const id=key(i,j),entries=roads.get(id)??[];entries.push(road);roads.set(id,entries);
    }
  }
  let total=0,covered=0,fastest=0,slowest=0,unbounded=false;
  const matches=new Map<string,RoadSpeedBand&{route_geometry:[number,number][][]}>();
  const baseline=route.distanceMetres>0?route.durationSeconds/route.distanceMetres:0;
  const routeCells=new Map<string,{a:[number,number];b:[number,number]}[]>();
  for(let index=1;index<geometry.length;index++){
    const a=geometry[index-1],b=geometry[index],length=distance(a,b);
    if(!length)continue;
    const steps=Math.ceil(length/80);
    for(let step=0;step<steps;step++){
      const fraction=(step+.5)/steps,p:[number,number]=[a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction];
      const [i,j]=cell(p),id=key(i,j),segments=routeCells.get(id)??[];
      segments.push({a,b});routeCells.set(id,segments);
      let best:RoadSpeedBand|undefined,nearest=40;
      for(const road of roads.get(id)??[]){
        const start=point(road.start),end=point(road.end),roadLength=distance(start,end);
        // Directed links running against travel must not affect the estimate.
        const alignment=((x(b)-x(a))*(x(end)-x(start))+(y(b)-y(a))*(y(end)-y(start)))/(length*roadLength);
        if(!Number.isFinite(alignment)||alignment<.85)continue;
        const d=proximity(p,start,end);
        if(d<nearest){nearest=d;best=road;}
      }
      const metres=length/steps,base=metres*baseline;total+=metres;
      if(!best){fastest+=base;slowest+=base;continue;}
      let match=matches.get(best.linkId);
      if(!match){match={...best,route_geometry:[]};matches.set(best.linkId,match);}
      // Draw only the route portion used by this observation, never the provider's straight chord.
      const from:[number,number]=[a[0]+(b[0]-a[0])*step/steps,a[1]+(b[1]-a[1])*step/steps];
      const to:[number,number]=[a[0]+(b[0]-a[0])*(step+1)/steps,a[1]+(b[1]-a[1])*(step+1)/steps];
      const piece=match.route_geometry.at(-1),last=piece?.at(-1);
      if(piece&&last&&Math.abs(last[0]-from[0])<1e-10&&Math.abs(last[1]-from[1])<1e-10)piece.push(to);
      else match.route_geometry.push([from,to]);
      covered+=metres;
      fastest+=Math.max(base,metres/Math.max(best.maximumSpeedKmh,1)*3.6);
      if(best.minimumSpeedKmh<=0)unbounded=true;
      else slowest+=Math.max(base,metres/best.minimumSpeedKmh*3.6);
    }
  }
  const incidents=snapshot.incidents.filter(incident=>{
    const p=point(incident),[i,j]=cell(p);
    for(let a=i-1;a<=i+1;a++)for(let b=j-1;b<=j+1;b++){
      if((routeCells.get(key(a,b))??[]).some(segment=>proximity(p,segment.a,segment.b)<=100))return true;
    }
    return false;
  });
  // Align geometric sampling distance to the provider's reported road distance.
  const scale=total?route.distanceMetres/total:1;
  return {incidents,speed_bands:[...matches.values()],coverage_percent:total?Math.round(covered/total*100):0,
    minimum_seconds:Math.ceil(Math.max(route.durationSeconds,fastest*scale)),
    maximum_seconds:unbounded?null:Math.ceil(Math.max(route.durationSeconds,slowest*scale)),
    incidents_retrieved_at:snapshot.incidentsRetrievedAt,speeds_retrieved_at:snapshot.speedBandsRetrievedAt};
}
