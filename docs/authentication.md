# Authentication

Supabase manages Google identities and sessions. The application stores each account's username, role and active/inactive status separately.

## Account flow

1. **Continue with Google** verifies the user's identity.
2. Active roles open `/dashboard/trips` in the shared role-specific workspace. New users enter **Username → Role → Next** and continue signup inside the same landing-page card. Patients supply personal and transport details before **Sign Up**; Drivers supply personal details; Caregivers review their account details before submitting. Patient and Driver personal details include full name, contact number, date of birth and gender (including “Prefer not to say”).
3. Only the final submission creates an active account. Patient and Driver signup each create the account and its owned profile in one transaction; invalid details create neither record. Date of birth must be a real date from 1 January 1900 through today in Singapore.

Coordinator accounts are provisioned directly in Supabase. Public signup cannot assign coordinator access, change an existing role or reactivate an inactive account. Sign-out appears after an application account exists. During signup, Cancel clears the session on this device and returns to the Google sign-in card without creating an application account or showing a sign-out toast.

The signup Email field is disabled and follows the verified Google identity. Its change button opens Google’s account picker and preserves the entered username and role. A separate, tab-scoped PKCE session checks the selection through `/api/auth/me` before replacing the current sign-in. Registered or inactive accounts show “Google account already in use” and retain the previous selection; provider cancellation or lookup failure also retains it. A later sign-out in another tab cancels a pending account change, including during session activation. Temporary selection data is cleared on return. Ordinary login to an existing account still opens its role view.

A user can appear in Supabase **Authentication → Users** before submitting the signup form. Their `accounts` row is created when final signup succeeds; Next and Back do not write database records. The username uses the `display_name` column; identity and email establish account uniqueness.

Driver signup collects personal information. After signup, Drivers register one owned vehicle for coordinator approval, using mock licence and vehicle details without document uploads. Account active/inactive status still controls login; vehicle approval is a separate operational state. Caregiver patient access still requires explicit links. Manual assignment and assigned-driver Trips are implemented; trip execution is implemented with driver-only Start/Complete actions.

Session and account checks show a centred spinner with matching-size 'Loading...' text to its right. If the backend is unavailable, sign-in waits behind the spinner and its health check retries every 30 seconds or when the window regains focus. If the account service is unavailable, the spinner remains and the lookup retries automatically every five seconds after a failed response. Account requests time out after 15 seconds so a hung connection can enter the retry cycle. Temporary Supabase Auth failures return 503 and preserve the local session; rejected credentials still return 401. Account access stays blocked until verification succeeds. After ten seconds of continuous loading, a toast says “This is taking us longer than expected.”. While loading continues, the reminder repeats ten seconds after each toast finishes closing. Recovery dismisses the reminder and stops the cycle.

## Coordinator dashboard

All active roles land on `/dashboard/trips`; caregiver trips/schedules/actions are limited to currently linked active patients, with a linking prompt when none are linked. Drivers have Trips and Register Vehicle before first approval, then Trips, Availability and My Vehicle. `/dashboard`, unknown dashboard paths and the logo open Trips. All roles retain `/dashboard/account`; coordinators additionally have `/dashboard/patients`, `/dashboard/caregivers` and `/dashboard/drivers`. Incomplete Patients/Drivers finish signup before entering the workspace. Only coordinators see generic account metadata; Patients and Drivers edit their owned personal profiles using Edit profile.

The shared responsive header, menu drawer, account dropdown and loading state apply to every role. Refresh, bookmarks and browser history are supported. Patient, coordinator and assigned-driver trip retrieval is implemented; caregiver access requires linking. See [current coverage and priorities](use-case-map.md).

Existing Patient records may retain NULL demographics until manually updated; no values are fabricated. Driver accounts without a personal profile complete signup before entering the dashboard. Account status controls login separately from vehicle approval. Coordinators see Drivers with or without submissions and can version-check Active/Inactive status edits. Only current Pending review submissions from active Drivers can be approved/rejected; rejection requires a reason. Resubmission returns a vehicle to Pending review without deleting prior review history.

## Vehicle registration

The Register Vehicle form collects driving licence number, vehicle plate, make/model, passenger capacity excluding the Driver (1–12), and wheelchair accessibility. This school-project review is simulated; the app does not verify documents or legal eligibility. A Driver has one current vehicle. Plates are trimmed, uppercased and unique across submissions. Registering an account alone leaves the vehicle Not submitted. Submitting sets Pending review and returns the form to read-only mode. Edit registration is available for every saved submission, including Pending review. Every initial submission or edited resubmission opens a confirmation overlay warning that it replaces any previous vehicle registration and sends the details for review. Cancel leaves the draft intact and performs no write. Refresh status is removed; stale-version conflicts retain a separate reload action. Rejection feedback remains visible while correcting details; resubmission clears the current decision, keeps audit history and requires another review. Changing Approved details also requires a new review.

The coordinator Drivers list supports server-side name/phone/email/ID/plate search, registration-status filtering, sorting and pagination, newest accounts first by default. Sort by creation date, Driver ID, name, contact, vehicle plate or registration status using the same controls as Patient List. Details shows personal and vehicle information, account status and submission/review times. Drivers without personal profiles or vehicles are included. Approval/rejection checks the selected submission version and active roles in both the API and database. Stale decisions require reloading, and inactive Driver accounts cannot be approved. The Info button opens personal Driver Details and account Status editing. A separate car icon immediately to its left opens Car Details with licence number and Submitted on above the car data, plus approval/rejection actions. Once approved, Registered on replaces Submitted on and uses the approval timestamp. Account Status edits compare a separate status version, affect login access, and leave vehicle approval unchanged. Only active coordinators can change a Driver’s Status, including accounts without personal profiles; identity, role and vehicle data cannot be supplied to that endpoint. Direct account and vehicle writes are revoked; only the owner-submit and coordinator-review functions can change registration. Previous submission/review snapshots are retained in an internal audit table. Apply the complete `database/schema.sql` locally prepared file in Supabase; the application uses no service-role key.

## Google provider setup

1. Create a Google Cloud web OAuth client. Add the frontend origin, such as `http://localhost:5173`, to its authorised JavaScript origins.
2. Add the callback shown in Supabase's Google provider settings to Google's authorised redirect URIs:

   ```text
   https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
   ```

3. Enable Google in **Supabase → Authentication → Sign In / Providers**, supplying the Google client ID and secret.
4. In **Authentication → URL Configuration**, set the Site URL to the frontend address and allow each application callback:

   ```text
   http://localhost:5173/auth/callback
   https://YOUR-FRONTEND.onrender.com/auth/callback
   ```

Use the actual deployed hostname. Keep localhost for local development. If Google OAuth is in Testing mode, add the team's Google accounts as test users. Start and finish login in the same browser and origin; use HTTPS for phone testing.

Only the Supabase URL and publishable key belong in the frontend environment. Google Calendar uses separate consent and backend credentials; Google login alone does not grant Calendar access.

## Database setup

Run the entire [`database/schema.sql`](../database/schema.sql) file in the **Supabase SQL Editor** as the project owner. Use this same script for a fresh database or an existing installation; it is safe to reapply.

The script creates or updates the account table, functions and permissions without deleting accounts. It preserves roles, Google identity links and inactive accounts, and removes the earlier approval APIs. Older `pending`/`approved` statuses become `active`; `rejected` becomes `inactive`.

Apply the schema and deploy the current frontend/backend together. No separate SQL update file or manual account reset is required.

Keep `public` exposed to the Data API and `private` unexposed. The SQL scripts grant account reads through RLS and restrict writes to registration functions or the project owner. No service-role key is required by the application.

## Coordinator accounts

In **Supabase → Table Editor → accounts**, insert:

| Column | Value |
| --- | --- |
| `email` | Exact Google email, lowercase, without surrounding spaces |
| `display_name` | Username |
| `role` | `coordinator` |
| `status` | `active` |
| `auth_user_id` | NULL; first verified login links the identity |

Keep generated ID and timestamp defaults. For an email already registered, edit its existing row instead of inserting a duplicate, preserving `auth_user_id`. Use `inactive` to deactivate an account.

## API and access control

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/me` | Verify the Google session and return the application account, or NULL for a new user |
| `POST /api/auth/register` | Create an account using `displayName`, public `role` and a required `profile` for Patients/Drivers |
| `GET /api/profiles/driver` | Read the active Driver’s own personal profile |
| `GET /api/drivers/me` | Read the active Driver’s owned vehicle submission, or NULL before submission |
| `POST /api/drivers/me/vehicle` | Submit one owned vehicle with `version` (NULL initially; current integer for resubmission) |
| `GET /api/drivers` | Coordinator-only paginated Driver accounts with optional `search` and registration `status` |
| `PATCH /api/drivers/:id` | Coordinator-only account Status update using `status` (active/inactive) and current `version` from `status_version` |
| `PATCH /api/drivers/:id/review` | Coordinator-only Pending review decision, with `version`, `decision` and `reason` |
| `PATCH /api/profiles/driver` | Complete a missing personal profile without a version, or update the owned profile with its current `version`; stale updates return 409 |

The backend validates tokens with Supabase and uses the caller's JWT for database requests. Permissions come from database records, never user-editable metadata. Future transport endpoints must enforce current account status, role, patient links and assigned-trip scope.

Sign-out clears the current device's application session. It does not sign the user out of Google or other devices. Sign-outs and expired sessions show a compact, dismissible toast with a three-second progress bar; it fades out when the bar fills or the dismiss button is pressed. Hovering over it or focusing its dismiss button pauses progress. Reduced-motion settings disable the entrance slide and continuous bar movement.

References: [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google), [database functions](https://supabase.com/docs/guides/database/functions), [row security](https://supabase.com/docs/guides/database/postgres/row-level-security).

Saving Driver availability requires an active account and currently approved vehicle. Trips remains accessible during registration/reapproval. Previously registered Drivers can inspect their calendar during reapproval but cannot edit availability. Owned dated edits are versioned and atomic, and cannot remove booked intervals. See [Driver calendars and availability per week](development.md#driver-calendars-and-availability-per-week).

My Vehicle shows licence and car details, status, submission date and the current registration date. Registered on shows a dash after resubmission until approval returns. The persisted `registered_at` timestamp retains the previous approval through Pending review or Rejected edits, so My Vehicle remains visible after refresh. Reapproval updates this date. My Vehicle also shows completed-trip totals and the average rating/count derived from completed journeys and patient feedback. Drivers receive aggregate statistics only; individual patient ratings remain private.

All Account Details headings include the shared Account Management subheader. Drivers edit name, phone, birth date and gender through Edit profile → Save profile/Cancel. Owner updates send the profile version, preserve drafts on failure and use the shared viewport toast for errors. Login status, identity, role and vehicle approval are unchanged by personal edits.

Active coordinators inspect effective availability and bookings through the Driver List schedule icon and `GET /api/drivers/:id/week`. Drivers use the separate `GET /api/drivers/me/week` endpoint. Coordinator inspection grants no availability writes; inactive/unapproved Drivers remain visible with an eligibility note.
