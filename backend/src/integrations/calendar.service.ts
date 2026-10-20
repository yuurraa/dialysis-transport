import { Injectable, NotImplementedException } from '@nestjs/common';

export const GOOGLE_CALENDAR_API = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  events: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
  scope: 'https://www.googleapis.com/auth/calendar.events.owned',
} as const;

export interface PickupReminderInput {
  tripId: string;
  pickupAt: string;
  endAt: string;
  reminderMinutes: number;
}

/** UC-13: opt-in events on each recipient's own primary calendar, separate from app login. */
@Injectable()
export class CalendarService {
  async getAuthorizationUrl(userId: string): Promise<string> {
    // TODO: Bind a random, expiring OAuth state to this authenticated user server-side.
    // Request response_type=code, events.owned scope, access_type=offline.
    // Use GOOGLE_CLIENT_ID and registered GOOGLE_CALENDAR_REDIRECT_URI.
    throw new NotImplementedException('Calendar consent is awaiting implementation.');
  }

  async completeAuthorization(code: string, state: string): Promise<void> {
    // TODO: Validate and consume stored state before exchanging code with GOOGLE_CLIENT_SECRET.
    // Securely persist recipient refresh tokens; handle reconnect and revocation.
    // Never accept an arbitrary callback userId or expose tokens in frontend configuration.
    throw new NotImplementedException('Calendar connection is awaiting implementation.');
  }

  async createReminder(userId: string, reminder: PickupReminderInput): Promise<{ eventId: string }> {
    // TODO: Check recipient access to the trip; POST GOOGLE_CALENDAR_API.events with their Bearer token.
    // Use summary='Transport pickup', RFC3339 start/end dateTime and Asia/Singapore timezone.
    // Set reminders={useDefault:false,overrides:[{method:'popup',minutes:reminderMinutes}]}.
    // Persist event ID/sync status and prevent duplicate events on retried creation.
    throw new NotImplementedException('Calendar reminder creation is awaiting implementation.');
  }

  async updateReminder(userId: string, eventId: string, reminder: PickupReminderInput): Promise<void> {
    // TODO: Verify stored event ownership; PUT complete start/end event payload to /{eventId}.
    throw new NotImplementedException('Calendar reminder update is awaiting implementation.');
  }

  async deleteReminder(userId: string, eventId: string): Promise<void> {
    // TODO: Verify stored event ownership; DELETE /{eventId}; handle already removed events.
    throw new NotImplementedException('Calendar reminder removal is awaiting implementation.');
  }

  async syncReminder(userId: string, tripId: string): Promise<void> {
    // TODO: Choose create/update/delete from stored trip/reminder state; refresh user tokens as needed.
    // Record failure for retry after the trip commits; never roll back a trip for Google failure.
    throw new NotImplementedException('Calendar synchronisation is awaiting implementation.');
  }
}
