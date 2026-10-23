# Authentication

Supabase manages Google identities and sessions. The application stores each account's username, role and active/inactive status separately.

## Account flow

1. **Continue with Google** verifies the user's identity.
2. All active accounts open `/dashboard/trips` in the shared role-specific workspace. New users enter **Username → Role → Next** and continue signup inside the same landing-page card. Patients supply personal and transport details before **Sign Up**; Drivers supply personal details; Caregivers review their account details before submitting. Patient and Driver personal details include full name, contact number, date of birth and gender (including “Prefer not to say”).
3. Only the final submission creates an active account. Patient and Driver signup each create the account and its owned profile in one transaction; invalid details create neither record. Date of birth must be a real date from 1 January 1900 through today in Singapore.

Coordinator accounts are provisioned directly in Supabase. Public signup cannot assign coordinator access, change an existing role or reactivate an inactive account. Sign-out appears after an application account exists. During signup, Cancel clears the session on this device and returns to the Google sign-in card without creating an application account or showing a sign-out toast.

The signup Email field is disabled and follows the verified Google identity. Its change button opens Google’s account picker and preserves the entered username and role. A separate, tab-scoped PKCE session checks the selection through `/api/auth/me` before replacing the current sign-in. Registered or inactive accounts show “Google account already in use” and retain the previous selection; provider cancellation or lookup failure also retains it. A later sign-out in another tab cancels a pending account change, including during session activation. Temporary selection data is cleared on return. Ordinary login to an existing account still opens its role view.

A user can appear in Supabase **Authentication → Users** before submitting the signup form. Their `accounts` row is created when final signup succeeds; Next and Back do not write database records. The username uses the `display_name` column; identity and email establish account uniqueness.

Driver signup collects personal information only; it does not register a vehicle or verify drivers for trip assignment or grant caregivers access to patients. Those require operational profiles and explicit caregiver–patient links. Transport features remain under development.

Session and account checks show a centred spinner with matching-size 'Loading...' text to its right. If the backend is unavailable, sign-in waits behind the spinner and its health check retries every 30 seconds or when the window regains focus. If the account service is unavailable, the spinner remains and the lookup retries automatically every five seconds after a failed response. Account requests time out after 15 seconds so a hung connection can enter the retry cycle. Temporary Supabase Auth failures return 503 and preserve the local session; rejected credentials still return 401. Account access stays blocked until verification succeeds. After ten seconds of continuous loading, a toast says “This is taking us longer than expected.”. While loading continues, the reminder repeats ten seconds after each toast finishes closing. Recovery dismisses the reminder and stops the cycle.

## Coordinator dashboard

All active roles use `/dashboard/trips` for Trips and `/dashboard/account` for My Account. Coordinators additionally have `/dashboard/patients`. `/dashboard` and unknown dashboard paths redirect to Trips; there is no Overview page. Account and role verification still gate all content, and incomplete Patients or Drivers finish personal signup on the landing page. Only Transport Coordinators see the generic Account details section (username, email, role and status). Patients see their owned transport profile, locked until Edit profile; Drivers see their saved personal details as read-only; patients, drivers and caregivers do not see the generic Account details section.

The shared responsive header, Menu drawer, account dropdown and blurred loading backdrop apply to every role. Refresh, bookmarks and browser history are supported. Trip services remain unimplemented, so trip data is explicitly unavailable rather than fabricated. Caregiver access to patient data still requires an explicit link, and driver verification remains separate from account creation.

Existing Patient records retain NULL birth dates and gender after applying the schema; no personal information is fabricated. Populate mock records manually in Supabase or complete both fields when editing My Account. Existing Driver accounts without a `drivers` row complete their personal details on the landing page before entering the dashboard. Account active/inactive status retains its login meaning. Driver Trips remains the existing unavailable placeholder; vehicle registration, coordinator approval and new driver/coordinator tabs are deferred.

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
| `PATCH /api/profiles/driver` | Complete a missing personal profile for an existing active Driver; cannot overwrite an existing profile |

The backend validates tokens with Supabase and uses the caller's JWT for database requests. Permissions come from database records, never user-editable metadata. Future transport endpoints must enforce current account status, role, patient links and assigned-trip scope.

Sign-out clears the current device's application session. It does not sign the user out of Google or other devices. Sign-outs and expired sessions show a compact, dismissible toast with a three-second progress bar; it fades out when the bar fills or the dismiss button is pressed. Hovering over it or focusing its dismiss button pauses progress. Reduced-motion settings disable the entrance slide and continuous bar movement.

References: [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google), [database functions](https://supabase.com/docs/guides/database/functions), [row security](https://supabase.com/docs/guides/database/postgres/row-level-security).
