import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Coordinates } from '../types';

/** Official REST endpoints checked on 14 October 2026. */
export const ONEMAP_API = {
  token: 'https://www.onemap.gov.sg/api/auth/post/getToken',
  search: 'https://www.onemap.gov.sg/api/common/elastic/search',
  route: 'https://www.onemap.gov.sg/api/public/routingsvc/route',
} as const;

export interface AddressMatch extends Coordinates { address: string; postalCode: string }
export interface DrivingRoute {
  encodedPolyline: string;
  distanceMetres: number;
  durationSeconds: number;
}

/** UC-08: address lookup and baseline driving route, independent of scheduling rules. */
@Injectable()
export class OneMapService {
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    // TODO: POST ONEMAP_EMAIL/ONEMAP_PASSWORD as email/password to ONEMAP_API.token.
    // Cache access_token until expiry_timestamp (Unix seconds); renew before expiry.
    throw new NotImplementedException('OneMap authentication is awaiting implementation.');
  }

  async searchAddresses(query: string, page = 1, signal?: AbortSignal): Promise<{ results: AddressMatch[]; totalPages: number }> {
    // TODO: GET ONEMAP_API.search: searchVal, returnGeom=Y, getAddrDetails=Y, pageNum.
    // Use Authorization: <OneMap token>, not the user's Supabase JWT.
    // Reject JSON error fields even on HTTP 200; convert LATITUDE/LONGITUDE strings.
    throw new NotImplementedException('OneMap address search is awaiting implementation.');
  }

  async getRoute(origin: Coordinates, destination: Coordinates, signal?: AbortSignal): Promise<DrivingRoute> {
    // TODO: GET ONEMAP_API.route: start=lat,lon, end=lat,lon, routeType=drive, Authorization token.
    // Map route_geometry and route_summary.total_distance/total_time to metres/seconds.
    // Validate status and use the caller's shared five-second assessment deadline.
    // Traffic-adjusted ETA and ranked alternatives remain application logic.
    throw new NotImplementedException('OneMap routing is awaiting implementation.');
  }
}
