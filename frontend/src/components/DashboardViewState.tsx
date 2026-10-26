import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// Lives inside the account-keyed dashboard; no names/searches enter browser storage.
const ViewState=createContext<Map<string,unknown>|null>(null);
export function DashboardViewStateProvider({children}:{children:ReactNode}) {
  const values=useRef(new Map<string,unknown>());
  return <ViewState.Provider value={values.current}>{children}</ViewState.Provider>;
}

/** Persist applied list choices while individual dashboard pages unmount. */
export function useDashboardViewState<T>(key:string,initial:T|(()=>T)) {
  const values=useContext(ViewState);
  const state=useState<T>(()=>values?.has(key)?values.get(key) as T:typeof initial==='function'?(initial as ()=>T)():initial);
  useEffect(()=>{values?.set(key,state[0]);},[values,key,state[0]]);
  return state;
}
