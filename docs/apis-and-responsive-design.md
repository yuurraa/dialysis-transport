# APIs and responsive design

The integration adapters define endpoints and contracts but are not implemented. Configure their backend credentials when implementing each integration.

## Responsive web application

Use one React application across phone, tablet and desktop browsers. Patient, caregiver and driver views prioritise stacked cards, next pickup and large actions. The coordinator view uses a wider desktop workspace, adapting to cards on smaller screens. Roles determine access; screen width only changes presentation.

`PageLayout` contains the public landing page. The coordinator dashboard has a separate fluid workspace with its own navigation and account page. Both use responsive spacing. Use compact layouts for personal views and wider layouts for coordinator workflows. Keep text at least 16px, controls at least 44px tall, visible keyboard focus, and readable status labels. Dialogs and maps must fit the viewport. No separate mobile app, desktop app or PWA is needed for this scope.

## OneMap

| Purpose | Endpoint |
| --- | --- |
| Obtain token | `POST https://www.onemap.gov.sg/api/auth/post/getToken` |
| Resolve address/postal code | `GET https://www.onemap.gov.sg/api/common/elastic/search` |
| Baseline driving route | `GET https://www.onemap.gov.sg/api/public/routingsvc/route` |

Register an account and set backend-only `ONEMAP_EMAIL` and `ONEMAP_PASSWORD`. Search and routing use the returned token in `Authorization`. Tokens expire after three days; use the supplied Unix expiry. Search can return an error inside HTTP 200, so validate the body.

Search requests include `searchVal`, `returnGeom=Y`, `getAddrDetails=Y` and `pageNum`. Driving routes use WGS84 `start=latitude,longitude`, `end=latitude,longitude`, `routeType=drive`; normalise `route_geometry`, `total_distance` and `total_time` to the service contract. Traffic adjustment belongs in trip assessment.

For later map rendering, use OneMap's `https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png` with Leaflet and retain the required OneMap logo and SLA attribution. Basemap tiles do not need API tokens. The map library/component has not been added yet.

Sources: [Authentication](https://www.onemap.gov.sg/apidocs/authentication), [Search token handling](https://www.onemap.gov.sg/apidocs/docs/verifyingsearchapitoken), [Routing](https://www.onemap.gov.sg/apidocs/routing), [Basemap](https://www.onemap.gov.sg/docs/maps/index.html).

## LTA DataMall

Use `TrafficIncidents` and **`v4/TrafficSpeedBands`**, under `https://datamall2.mytransport.sg/ltaodataservice/`. The current user guide is version 6.10, dated 1 October 2026. Register for API access and supply backend-only `LTA_ACCOUNT_KEY` as the `AccountKey` header.

Responses contain `value` arrays. Retrieve complete feeds with 500-record pages and `$skip`. Incidents update about every two minutes, speed bands every five minutes; cache centrally and record freshness. Match observations to the route before adjusting ETA. These feeds do not provide a complete patient-trip ETA. OneMap and traffic assessment must share the five-second response budget; do not fetch an entire traffic feed for every browser viewer.

Source: [Official LTA API user guide, sections 1, 2.18 and 2.19](https://datamall.lta.gov.sg/content/dam/datamall/datasets/LTA_DataMall_API_User_Guide.pdf).

## Google Calendar

Calendar connection is optional and distinct from Supabase login. Enable the Calendar API in a Google Cloud project, configure a web OAuth client and test users, and set backend-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_CALENDAR_REDIRECT_URI`. The example callback URL reserves a future route; it is not available yet.

Request `calendar.events.owned` for each recipient's own primary calendar. Bind expiring OAuth state to the authenticated user; validate it before exchanging the code. Request offline access and securely store each user's refresh token for later schedule changes. A Google login alone does not grant Calendar access.

Create pickup events with `POST`, update with `PUT`, and remove with `DELETE` under `https://www.googleapis.com/calendar/v3/calendars/primary/events`. Use recipient tokens, RFC3339 start/end times, `Asia/Singapore` and popup reminder overrides. Store event IDs and sync status. Check trip access and stored event ownership; never include treatment details. Calendar failure must not undo a successful trip change.

Sources: [Scopes](https://developers.google.com/workspace/calendar/api/auth), [Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Update](https://developers.google.com/workspace/calendar/api/v3/reference/events/update), [Delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete).

## Driver location

Location comes from the driver's browser, not OneMap or LTA. `watchDriverLocation` is a small browser boundary: it requires a secure context and permission, returns coordinate/accuracy/time updates and supplies a cleanup function. It is not wired into trip pages or backend reporting yet.

Start only on the assigned active trip after an explicit driver action. Stop on trip end, cancellation, sign-out or leaving the view. Backend authorisation remains required. Browser updates are limited to active, visible documents; do not promise background or locked-phone tracking. If updates stop, display the last-update time and stale-location state.

A phone opening a local development server by LAN IP will need HTTPS for geolocation; desktop localhost is suitable for local testing. Production requires HTTPS.

Sources: [Geolocation standard](https://www.w3.org/TR/geolocation/), [Browser API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition).
