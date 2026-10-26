import type { Map as LeafletMap, LayerGroup } from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet } from '../lib/api';
import TripTraffic, { type TrafficView } from './TripTraffic';

export interface RoadRoute {
  origin:string; destination:string; geometry:[number,number][];
  origin_coordinates:{latitude:number;longitude:number}; destination_coordinates:{latitude:number;longitude:number};
  distance_metres:number; duration_minutes:number; duration_seconds:number; assessed_at:string;
}
export interface TrackingPoint { latitude:number; longitude:number; accuracy_metres:number; recorded_at:string; received_at:string }
interface RouteView { route:RoadRoute; reserved_minutes:number|null; saved:boolean }
const attribution='<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:20px;width:20px" alt="OneMap"/>&nbsp;<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>';

/** Map data is read from an authorised trip endpoint; no credentials enter the browser. */
export default function TripRouteMap({tripId,onSessionExpired,location=null,locationStale=false,version=0,activeTrip=false,showTraffic=true}:{tripId:string;version?:number;activeTrip?:boolean;showTraffic?:boolean;onSessionExpired:()=>void;location?:TrackingPoint|null;locationStale?:boolean}) {
  const [data,setData]=useState<RouteView|null>(null);
  const [traffic,setTraffic]=useState<TrafficView|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const [mapReady,setMapReady]=useState(0);
  const controls=useRef<{map:LeafletMap;layer:LayerGroup;traffic:LayerGroup;L:typeof import('leaflet')}|null>(null);
  const canShowMap=!!data||!!location;
  const canvas=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let active=true;setData(null);setLoading(true);setError('');
    apiGet<RouteView>(`/trips/${tripId}/route`).then(result=>{if(active)setData(result);}).catch(reason=>{
      if(!active)return;
      if(reason instanceof ApiError&&reason.status===401)onSessionExpired();
      setError(reason instanceof ApiError&&reason.code==='route_address_unresolved'?'The pickup or destination address could not be located. Please ask your coordinator to check it.':'Route information is currently unavailable.');
    }).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[tripId,retry,onSessionExpired]);
  useEffect(()=>{
    if(!canShowMap||!canvas.current)return;
    let active=true;let cleanup=()=>{};
    void import('leaflet').then(L=>{
      if(!active||!canvas.current)return;
      const map=L.map(canvas.current,{scrollWheelZoom:false,minZoom:11,maxZoom:19});
      L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',{attribution,minZoom:11,maxZoom:19,noWrap:true}).addTo(map);
      if(data){
        const line=L.polyline(data.route.geometry,{color:'#a83c65',weight:4,opacity:.9}).addTo(map);
        for(const [label,coordinate,title] of [['A',data.route.origin_coordinates,'Pickup'],['B',data.route.destination_coordinates,'Destination']] as const){
          L.marker([coordinate.latitude,coordinate.longitude],{title,icon:L.divIcon({className:'trip-map-marker',html:`<span>${label}</span>`,iconSize:[30,30],iconAnchor:[15,15]})}).addTo(map);
        }
        map.fitBounds(line.getBounds(),{padding:[28,28],maxZoom:16,animate:false});
      } else if(location)map.setView([location.latitude,location.longitude],15,{animate:false});
      controls.current={map,layer:L.layerGroup().addTo(map),traffic:L.layerGroup().addTo(map),L};setMapReady(value=>value+1);
      const observer=new ResizeObserver(()=>map.invalidateSize({animate:false,pan:false}));observer.observe(canvas.current);
      cleanup=()=>{controls.current=null;observer.disconnect();map.remove();};
    }).catch(()=>{if(active)setError('The map could not be loaded.');});
    return()=>{active=false;cleanup();};
  },[data,error,canShowMap]);
  useEffect(()=>{
    const control=controls.current;if(!control)return;
    control.layer.clearLayers();if(!location)return;
    const coordinate:[number,number]=[location.latitude,location.longitude];
    const color=locationStale?'#777':'#276b9d';
    control.L.circle(coordinate,{radius:location.accuracy_metres,color,weight:1,fillOpacity:.08,interactive:false}).addTo(control.layer);
    control.L.circleMarker(coordinate,{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:1}).bindTooltip(locationStale?'Last known driver location':'Driver location').addTo(control.layer);
  },[location,mapReady,locationStale]);
  useEffect(()=>{
    const control=controls.current;if(!control)return;
    control.traffic.clearLayers();if(!showTraffic||traffic?.state!=='current')return;
    for(const road of traffic.speed_bands??[]){
      if(road.speedBand>3)continue;
      const line=control.L.polyline([[road.start.latitude,road.start.longitude],[road.end.latitude,road.end.longitude]],{color:road.speedBand<=2?'#b83d42':'#ad7215',weight:5,opacity:.8}).addTo(control.traffic);
      const label=document.createElement('span');label.textContent=`${road.roadName}: ${road.minimumSpeedKmh}–${road.maximumSpeedKmh} km/h`;
      line.bindTooltip(label);
    }
    for(const incident of traffic.incidents??[]){
      const marker=control.L.circleMarker([incident.latitude,incident.longitude],{radius:7,color:'#fff',weight:2,fillColor:'#b83d42',fillOpacity:1}).addTo(control.traffic);
      const label=document.createElement('span');label.textContent=`${incident.type}: ${incident.message}`;
      marker.bindTooltip(label);
    }
  },[traffic,mapReady,showTraffic]);
  const stale=data&&Date.parse(data.route.assessed_at)<Date.now()-24*3600000;
  return <section className="trip-map" aria-label="Driving route">
    <div className="trip-map-heading"><h3>Route</h3>{data&&!error&&<span>Approx. {data.route.duration_minutes} min · {(data.route.distance_metres/1000).toFixed(1)} km</span>}</div>
    {!canShowMap?<div className="trip-map-status" role="status">{error?<><p>{error}</p><button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>Retry route</button></>:'Loading route…'}</div>:<>
      <div className="trip-map-canvas" ref={canvas} role="region" aria-label="Driving route map" />
      {error&&<p className="trip-map-note" role="status">{error}{!data&&location?' Showing driver location only. ':''} <button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>Retry route</button></p>}
      {data&&<p className="trip-map-note">{stale?'Saved route estimate. ':'Planning estimate. '}Traffic conditions may change before departure.{data.reserved_minutes!==null&&data.reserved_minutes!==data.route.duration_minutes?` Current reservation: ${data.reserved_minutes} min.`:''}</p>}
      {location&&<button className="trip-map-locate" type="button" disabled={!mapReady} onClick={()=>controls.current?.map.panTo([location.latitude,location.longitude],{animate:false})}>Show driver</button>}
    </>}
    {showTraffic&&<TripTraffic tripId={tripId} version={version} activeTrip={activeTrip} locationAvailable={!!location&&!locationStale&&location.accuracy_metres<=100} onSessionExpired={onSessionExpired} onUpdate={setTraffic}/>}
  </section>;
}
