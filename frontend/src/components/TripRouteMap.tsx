import type { Map as LeafletMap, LayerGroup } from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { RefreshButton } from './DashboardUI';
import { ApiError, apiGet } from '../lib/api';
import TripTraffic, { incidentKey, type TrafficView } from './TripTraffic';

export interface RoadRoute {
  origin:string; destination:string; geometry:[number,number][];
  origin_coordinates:{latitude:number;longitude:number}; destination_coordinates:{latitude:number;longitude:number};
  distance_metres:number; duration_minutes:number; duration_seconds:number; assessed_at:string;
}
export interface TrackingPoint { latitude:number; longitude:number; accuracy_metres:number; recorded_at:string; received_at:string }
interface RouteView { route:RoadRoute; reserved_minutes:number|null; saved:boolean }
const attribution='<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:20px;width:20px" alt="OneMap"/>&nbsp;<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>';

/** Map data is read from an authorised trip endpoint; no credentials enter the browser. */
export default function TripRouteMap({tripId,onSessionExpired,location=null,locationStale=false,version=0,activeTrip=false,showTraffic=true,routeKey=''}:{tripId:string;version?:number;activeTrip?:boolean;showTraffic?:boolean;onSessionExpired:()=>void;location?:TrackingPoint|null;locationStale?:boolean;routeKey?:string}) {
  const [data,setData]=useState<RouteView|null>(null);
  const [traffic,setTraffic]=useState<TrafficView|null>(null);
  const [selectedIncident,setSelectedIncident]=useState<string|null>(null);
  const incidentMarkers=useRef(new Map<string,import('leaflet').Marker>());
  const endpointMarkers=useRef(new Map<string,import('leaflet').Marker>());
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const refresh=useRef<()=>void>(()=>{});
  const [mapReady,setMapReady]=useState(0);
  const controls=useRef<{map:LeafletMap;layer:LayerGroup;traffic:LayerGroup;L:typeof import('leaflet')}|null>(null);
  const canShowMap=!!data||!!location;
  const canvas=useRef<HTMLDivElement>(null);
  function showEndpoint(key:string){
    const marker=endpointMarkers.current.get(key);
    if(marker){controls.current?.map.panTo(marker.getLatLng(),{animate:false});marker.openPopup();}
  }
  function selectIncident(key:string){
    setSelectedIncident(current=>current===key?null:key);
  }
  useEffect(()=>{
    const dismiss=(event:PointerEvent)=>{
      if(event.target instanceof Element&&event.target.closest('.trip-obstacle, .trip-incident-marker, .trip-incident-popup'))return;
      setSelectedIncident(null);
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setSelectedIncident(null);};
    document.addEventListener('pointerdown',dismiss);
    document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};
  },[]);
  useEffect(()=>{
    let active=true,busy=false,failed=false,loaded=false,timer:number|undefined;
    setData(null);setLoading(true);setError('');
    async function load(){
      if(!active||busy||document.visibilityState==='hidden')return;
      busy=true;setLoading(true);window.clearTimeout(timer);
      try {
        const result=await apiGet<RouteView>(`/trips/${tripId}/route`);
        if(active){setData(result);setError('');failed=false;loaded=true;}
      } catch(reason){
        if(!active)return;
        failed=true;
        if(reason instanceof ApiError&&reason.status===401)onSessionExpired();
        setError(reason instanceof ApiError&&reason.code==='route_address_unresolved'?'The pickup or destination address could not be located. Please ask your coordinator to check it.':'Route information is currently unavailable.');
      } finally {
        busy=false;
        if(active){setLoading(false);if(failed)timer=window.setTimeout(()=>void load(),15000);}
      }
    }
    refresh.current=()=>void load();
    void load();
    const visible=()=>{if(document.visibilityState==='visible'&&(failed||!loaded))void load();};
    document.addEventListener('visibilitychange',visible);
    return()=>{active=false;window.clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[tripId,onSessionExpired,routeKey]);
  useEffect(()=>{
    if(!canShowMap||!canvas.current)return;
    let active=true;let cleanup=()=>{};
    void import('leaflet').then(L=>{
      if(!active||!canvas.current)return;
      const bounds=L.latLngBounds([1.144,103.535],[1.494,104.502]);
      const map=L.map(canvas.current,{scrollWheelZoom:true,touchZoom:true,minZoom:11,maxZoom:19,maxBounds:bounds});
      L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',{attribution,minZoom:11,maxZoom:19,noWrap:true,bounds,crossOrigin:'anonymous'}).addTo(map);
      if(data){
        const line=L.polyline(data.route.geometry,{color:'#376ac3',weight:4,opacity:.9}).addTo(map);
        for(const [label,coordinate,title,address] of [['A',data.route.origin_coordinates,'Pickup',data.route.origin],['B',data.route.destination_coordinates,'Destination',data.route.destination]] as const){
          const content=document.createElement('div'),heading=document.createElement('strong'),location=document.createElement('div');
          heading.textContent=title;location.textContent=address;content.append(heading,location);
          const marker=L.marker([coordinate.latitude,coordinate.longitude],{title,icon:L.divIcon({className:'trip-map-marker',html:`<span>${label}</span>`,iconSize:[30,30],iconAnchor:[15,15]})}).addTo(map);
          marker.bindPopup(content,{className:'trip-location-popup',maxWidth:280,minWidth:100,maxHeight:160,autoPan:true,autoPanPadding:[24,24]});
          endpointMarkers.current.set(label,marker);
        }
        map.fitBounds(line.getBounds(),{padding:[28,28],maxZoom:16,animate:false});
      } else if(location)map.setView([location.latitude,location.longitude],15,{animate:false});
      controls.current={map,layer:L.layerGroup().addTo(map),traffic:L.layerGroup().addTo(map),L};setMapReady(value=>value+1);
      const observer=new ResizeObserver(()=>map.invalidateSize({animate:false,pan:false}));observer.observe(canvas.current);
      cleanup=()=>{controls.current=null;endpointMarkers.current.clear();observer.disconnect();map.remove();};
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
    control.traffic.clearLayers();incidentMarkers.current.clear();if(!showTraffic||traffic?.state!=='current')return;
    for(const road of traffic.speed_bands??[]){
      if(road.speedBand>3)continue;
      for(const geometry of road.route_geometry??[]){
        const line=control.L.polyline(geometry,{color:road.speedBand<=2?'#b83d42':'#ad7215',weight:5,opacity:.8}).addTo(control.traffic);
        const label=document.createElement('span');label.textContent=`${road.roadName}: ${road.minimumSpeedKmh}–${road.maximumSpeedKmh} km/h`;
        line.bindTooltip(label);
      }
    }
    for(const [index,incident] of (traffic.incidents??[]).entries()){
      const key=incidentKey(incident);
      const marker=control.L.marker([incident.latitude,incident.longitude],{title:`Obstacle ${index+1}: ${incident.type}`,icon:control.L.divIcon({className:'trip-incident-marker',html:`<span>${index+1}</span>`,iconSize:[28,28],iconAnchor:[14,14]})}).addTo(control.traffic);
      const label=document.createElement('span');label.textContent=`${incident.type}: ${incident.message}`;
      marker.bindPopup(label,{className:'trip-incident-popup',maxWidth:Math.max(120,Math.min(280,control.map.getSize().x-80)),minWidth:100,maxHeight:160,closeButton:false,autoPan:true,autoPanPadding:[24,24]})
        .on('click',()=>setSelectedIncident(current=>current===key?null:key));incidentMarkers.current.set(key,marker);
    }
  },[traffic,mapReady,showTraffic]);
  useEffect(()=>{
    if(selectedIncident&&!traffic?.incidents?.some(incident=>incidentKey(incident)===selectedIncident)){setSelectedIncident(null);return;}
    for(const [key,marker] of incidentMarkers.current){
      const selected=key===selectedIncident;
      marker.getElement()?.classList.toggle('is-selected',selected);
      marker.getElement()?.setAttribute('aria-pressed',String(selected));
      if(selected){controls.current?.map.panTo(marker.getLatLng(),{animate:false});marker.openPopup();}else marker.closePopup();
    }
  },[selectedIncident,traffic,mapReady]);
  const stale=data&&Date.parse(data.route.assessed_at)<Date.now()-24*3600000;
  return <section className={`trip-map${showTraffic?' trip-route-layout':''}`} aria-label="Driving route">
    <div className="trip-route-visual">
    <div className="trip-map-heading"><h3>Route</h3>{data&&!error&&<span>Approx. {data.route.duration_minutes} min · {(data.route.distance_metres/1000).toFixed(1)} km</span>}</div>
    {!canShowMap?<div className="trip-map-status" role="status">{error?<><p className="trip-map-note trip-map-feedback"><span>{error}</span><RefreshButton label="Refresh route" busy={loading} onClick={()=>refresh.current()}/></p></>:'Loading route…'}</div>:<>
      <div className="trip-map-canvas" ref={canvas} role="region" aria-label="Driving route map" />
      {error&&<p className="trip-map-note trip-map-feedback" role="status"><span>{error}{!data&&location?' Showing driver location only.':''}</span><RefreshButton label="Refresh route" busy={loading} onClick={()=>refresh.current()}/></p>}
      {data&&stale&&<p className="trip-map-note">Saved route estimate.</p>}
      {location&&<button className="trip-map-locate" type="button" disabled={!mapReady} onClick={()=>controls.current?.map.panTo([location.latitude,location.longitude],{animate:false})}>Show driver</button>}
    </>}
    <div className="trip-map-legend" aria-label="Map legend"><button type="button" className="trip-legend-location" disabled={!data} onClick={()=>showEndpoint('A')}><i aria-hidden="true" className="trip-legend-endpoint">A</i>Pickup</button><button type="button" className="trip-legend-location" disabled={!data} onClick={()=>showEndpoint('B')}><i aria-hidden="true" className="trip-legend-endpoint">B</i>Destination</button><span><i aria-hidden="true" className="trip-legend-route"/>Route</span>{showTraffic&&<><span><i aria-hidden="true" className="trip-legend-slow"/>20–29 km/h</span><span><i aria-hidden="true" className="trip-legend-heavy"/>0–19 km/h</span><span><i aria-hidden="true" className="trip-legend-obstacle"/>Obstacle</span></>}</div>
    </div>
    {showTraffic&&<TripTraffic tripId={tripId} version={version} activeTrip={activeTrip} locationAvailable={!!location&&!locationStale&&location.accuracy_metres<=100} onSessionExpired={onSessionExpired} onUpdate={setTraffic} selectedIncident={selectedIncident} onSelectIncident={selectIncident}/>}
  </section>;
}
