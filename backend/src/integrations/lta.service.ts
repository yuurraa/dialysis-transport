import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Coordinates } from '../types';

/** DataMall guide v6.10 (1 October 2026): current v4 speed-band endpoint. */
export const LTA_API = {
  incidents: 'https://datamall2.mytransport.sg/ltaodataservice/TrafficIncidents',
  speedBands: 'https://datamall2.mytransport.sg/ltaodataservice/v4/TrafficSpeedBands',
} as const;

export interface TrafficIncident extends Coordinates { type: string; message: string }
export interface RoadSpeedBand {
  linkId: string;
  roadName: string;
  speedBand: number;
  minimumSpeedKmh: number;
  maximumSpeedKmh: number;
  start: Coordinates;
  end: Coordinates;
}
export interface TrafficSnapshot {
  incidents: TrafficIncident[];
  speedBands: RoadSpeedBand[];
  retrievedAt: string;
}

/** UC-08: traffic observations, not a door-to-door ETA service. */
@Injectable()
export class LtaService {
  async getIncidents(signal?: AbortSignal): Promise<TrafficIncident[]> {
    // TODO: GET LTA_API.incidents: AccountKey: LTA_ACCOUNT_KEY, Accept: application/json.
    // Map value[].Type/Latitude/Longitude/Message. Updates about every two minutes.
    // Retrieve complete datasets using 500-record pages and $skip until exhausted.
    throw new NotImplementedException('LTA traffic incidents are awaiting implementation.');
  }

  async getSpeedBands(signal?: AbortSignal): Promise<RoadSpeedBand[]> {
    // TODO: GET LTA_API.speedBands with the same headers and $skip pagination.
    // Map LinkID/RoadName/SpeedBand/MinimumSpeed/MaximumSpeed and StartLat/StartLon/EndLat/EndLon.
    // Cache the complete dataset in this service near its five-minute update interval.
    throw new NotImplementedException('LTA speed bands are awaiting implementation.');
  }

  async getTraffic(signal?: AbortSignal): Promise<TrafficSnapshot> {
    // TODO: Combine validated complete datasets; record retrieval time and cache freshness.
    // Share the assessment deadline with OneMap; do not refetch all traffic per viewer.
    throw new NotImplementedException('LTA traffic snapshot is awaiting implementation.');
  }
}
