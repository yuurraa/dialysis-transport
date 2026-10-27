import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import type { Trip } from '../pages/TripsPage';

interface Notification { id:string; trip_id:string; message:string; event:string; created_at:string; read_at:string|null }
interface Inbox { notifications:Notification[]; total:number; unread:number; page:number; pageSize:number }
const timestamp=(value:string)=>new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'}).format(new Date(value));
const unique=(items:Notification[])=>[...new Map(items.map(item=>[item.id,item])).values()];

/** A scrollable inbox; opening a trip always rechecks current access. */
const notificationMessage=(item:Notification)=>item.event==='confirmed'?item.message.replace(/^Pickup confirmed(?= ·|$)/,'Trip acknowledged'):item.message;

export default function TripNotifications({open,onUnread,onError,onSessionExpired,onOpenTrip}:{open:boolean;onUnread:(count:number)=>void;onError:(message:string)=>void;onSessionExpired:()=>void;onOpenTrip:(trip:Trip)=>void}) {
  const [data,setData]=useState<Inbox|null>(null);
  const [loading,setLoading]=useState(true),[loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState(false),[moreError,setMoreError]=useState(false),[hasMore,setHasMore]=useState(false);
  const [busy,setBusy]=useState(''),[retry,setRetry]=useState(0);
  const busyRef=useRef(''),fetching=useRef(false),pages=useRef(1),request=useRef(0),alive=useRef(false);
  const scroll=useRef<HTMLDivElement>(null),sentinel=useRef<HTMLDivElement>(null);
  const refreshNow=useRef(()=>{});
  const openRef=useRef(open);openRef.current=open;
  const callbacks=useRef({onUnread,onError,onSessionExpired,onOpenTrip});callbacks.current={onUnread,onError,onSessionExpired,onOpenTrip};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current++;};},[]);
  useEffect(()=>{if(data)callbacks.current.onUnread(data.unread);},[data?.unread]);
  useEffect(()=>{
    let active=true;
    async function load(background=false){
      if(fetching.current||busyRef.current)return;
      fetching.current=true;const sequence=++request.current;
      setLoadingMore(false);
      if(!background)setLoading(true);
      try {
        let result:Inbox|undefined;const items:Notification[]=[];
        // Refresh the loaded range so newly inserted rows do not create permanent gaps.
        const range=openRef.current?pages.current:1;let loaded=0;
        for(let page=1;page<=range;page++){
          result=await apiGet<Inbox>(`/trips/notifications?page=${page}`);
          if(!active||sequence!==request.current)return;
          items.push(...result.notifications);
          loaded=page;
          if(page*result.pageSize>=result.total)break;
        }
        if(result&&active&&sequence===request.current){
          pages.current=loaded;
          setData({...result,notifications:unique(items)});setError(false);setMoreError(false);
          setHasMore(pages.current*result.pageSize<result.total);
        }
      } catch(reason){
        if(active&&sequence===request.current){setError(true);if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();}
      } finally {if(sequence===request.current){fetching.current=false;if(active)setLoading(false);}}
    }
    void load();
    refreshNow.current=()=>void load(true);
    const refresh=()=>{if(document.visibilityState==='visible')void load(true);};
    const timer=window.setInterval(refresh,15000);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;request.current++;fetching.current=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[retry]);
  useEffect(()=>{if(open)refreshNow.current();},[open]);

  async function loadMore(){
    if(fetching.current||busyRef.current||!hasMore)return;
    fetching.current=true;setLoadingMore(true);setMoreError(false);
    const sequence=++request.current,next=pages.current+1;
    try {
      const result=await apiGet<Inbox>(`/trips/notifications?page=${next}`);
      if(!alive.current||sequence!==request.current)return;
      pages.current=next;
      setData(current=>({...result,notifications:unique([...(current?.notifications??[]),...result.notifications])}));
      setHasMore(next*result.pageSize<result.total);
    } catch(reason){
      if(alive.current&&sequence===request.current){setMoreError(true);if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();}
    } finally {if(sequence===request.current){fetching.current=false;if(alive.current)setLoadingMore(false);}}
  }
  const more=useRef(loadMore);more.current=loadMore;
  useEffect(()=>{
    if(!open||!hasMore||loading||loadingMore||error||moreError||busy||!sentinel.current)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))void more.current();},{root:scroll.current,rootMargin:'80px'});
    observer.observe(sentinel.current);return()=>observer.disconnect();
  },[open,hasMore,loading,loadingMore,error,moreError,busy,data?.notifications.length]);

  async function openNotification(item:Notification){
    if(busyRef.current||loading||loadingMore)return;
    busyRef.current=item.id;setBusy(item.id);request.current++;fetching.current=false;
    try {
      const trip=await apiGet<Trip>(`/trips/${item.trip_id}`);
      if(alive.current)callbacks.current.onOpenTrip(trip);
    } catch(reason){
      if(alive.current){
        if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();
        callbacks.current.onError(reason instanceof ApiError&&[403,404].includes(reason.status)?'These trip details are no longer available to your account.':'Trip details could not be opened. Please try again.');
      }
    }
    if(!alive.current)return;
    try {
      if(!item.read_at){
        const saved=await apiRequest<Notification>(`/trips/notifications/${item.id}/read`,'PATCH',{});
        if(alive.current)setData(current=>current&&({...current,unread:Math.max(0,current.unread-1),notifications:current.notifications.map(row=>row.id===saved.id?saved:row)}));
      }
    } catch(reason){
      if(alive.current){if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();callbacks.current.onError('The notification could not be marked as read. Please try again.');}
    } finally {busyRef.current='';if(alive.current)setBusy('');}
  }
  async function markAllRead(){
    if(busyRef.current||loading||loadingMore||!data?.unread)return;
    busyRef.current='all';setBusy('all');request.current++;fetching.current=false;
    try {
      const saved=await apiRequest<{read_at:string;unread:number}>('/trips/notifications/read-all','PATCH',{});
      if(alive.current)setData(current=>current&&({...current,unread:saved.unread,notifications:current.notifications.map(item=>({...item,read_at:item.read_at??(Date.parse(item.created_at)<=Date.parse(saved.read_at)?saved.read_at:null)}))}));
    } catch(reason){
      if(alive.current){if(reason instanceof ApiError&&reason.status===401)callbacks.current.onSessionExpired();callbacks.current.onError('Notifications could not be marked as read. Please try again.');}
    } finally {busyRef.current='';if(alive.current)setBusy('');}
  }
  if(!open)return null;
  return <>
    <h2>Notifications{data&&!error?` · ${data.unread} unread`:''}</h2>
    <div className="trip-notification-scroll" ref={scroll}>
      {loading&&!data?<p className="dashboard-notification-status" role="status">Loading notifications…</p>:null}
      {error&&<div className="dashboard-notification-status"><p>Notifications could not be refreshed.</p><button type="button" onClick={()=>setRetry(value=>value+1)}>Retry</button></div>}
      {!loading&&!error&&!data?.notifications.length&&<p className="dashboard-notification-status">No notifications yet.</p>}
      {!!data?.notifications.length&&<ul className="trip-notification-list">{data.notifications.map(item=><li key={item.id} data-unread={!item.read_at}><button className="trip-notification-open" type="button" disabled={!!busy||loading||loadingMore} onClick={()=>void openNotification(item)} aria-label={`${notificationMessage(item)} · ${timestamp(item.created_at)} · ${item.read_at?'Read':'Unread'}`}><span className="trip-notification-dot" aria-hidden="true"/><span><span className="trip-notification-message">{notificationMessage(item)}</span><time dateTime={item.created_at}>{timestamp(item.created_at)}</time></span></button></li>)}</ul>}
      {loadingMore&&<p className="dashboard-notification-status" role="status">Loading older notifications…</p>}
      {moreError&&<div className="dashboard-notification-status"><button type="button" onClick={()=>void loadMore()}>Retry loading older notifications</button></div>}
      {hasMore&&<div ref={sentinel} className="trip-notification-sentinel" aria-hidden="true"/>}
    </div>
    <footer className="trip-notification-footer"><button type="button" disabled={!!busy||loading||loadingMore||!data?.unread} onClick={()=>void markAllRead()}>{busy==='all'?'Marking all as read…':'Mark all as read'}</button></footer>
  </>;
}
