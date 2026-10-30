# Project map: where everything lives

Reindexed from the local files on **30 October 2026**, branch **`feat/google-calendar`**.

Application root: `D:/2006-SCS1-X4/dialysis-transport-app`.
The sibling `lab1/`, `lab2/` and `lab3/` folders hold earlier deliverables. This guide describes the application folder, including the Google Calendar implementation and the separate backend test TypeScript configuration.

## Quick lookup

All paths below are relative to the application root.

| What you want to find | Start here |
| --- | --- |
| Frontend startup | [frontend/src/main.tsx](../frontend/src/main.tsx) |
| Navigation and role-specific routes | [frontend/src/app/routes.tsx](../frontend/src/app/routes.tsx) |
| Dashboard layout and page composition | [frontend/src/app/Dashboard.tsx](../frontend/src/app/Dashboard.tsx) |
| A feature's screen or dialog | `frontend/src/features/<feature>/pages/` or `components/` |
| Shared controls | `frontend/src/shared/ui/` |
| Backend startup | [backend/src/main.ts](../backend/src/main.ts) |
| Backend module registration | [backend/src/app.module.ts](../backend/src/app.module.ts) |
| HTTP endpoints | The owning backend domain's `*.controller.ts` |
| Request checks and orchestration | The owning backend domain's `*.service.ts` |
| Database rules, permissions and atomic operations | [database/schema.sql](../database/schema.sql) |
| Google Calendar | `frontend/src/features/calendar/` and `backend/src/integrations/calendar/` |
| Styles and ownership rules | [frontend/src/styles/README.md](../frontend/src/styles/README.md) |
| Setup and deployment | [docs/development.md](development.md) |
| Scope and implementation status | [docs/use-case-map.md](use-case-map.md) |

## How one request flows

```text
User interaction
  -> React feature page/component
  -> shared/lib/api.ts (request + access token)
  -> NestJS controller (HTTP endpoint)
  -> domain service (identity, role, input checks and coordination)
  -> Supabase client scoped to the user / authorised integration identity
  -> PostgreSQL tables, functions, permissions and constraints
  -> response returned to the UI
```

Google sign-in also talks directly to Supabase Auth through the frontend client. OneMap, LTA and Calendar provider calls are coordinated on the backend. The frontend role-based menu is only the navigation layer: backend and database checks enforce access.

## 1. Frontend application shell

`frontend/src/main.tsx` mounts React and imports `styles.css`. `app/App.tsx` opens the authentication/session screen. `app/Dashboard.tsx` composes the signed-in workspace, and `app/routes.tsx` defines the custom browser-history router and role-specific route list.

`app/components/PageLayout.tsx` supplies the public page layout. `DashboardViewState.tsx` supplies shared dashboard view state.

## 2. Frontend feature ownership

| Folder under `frontend/src/features/` | Main files and responsibilities |
| --- | --- |
| `auth/` | `pages/LoginPage.tsx`: login, session restoration and dashboard admission. `pages/AccountPanel.tsx`: account registration. `lib/googleAccountSelection.ts`: Google account selection flow. |
| `profiles/` | `pages/PatientProfile.tsx` and `DriverProfile.tsx`: owned profiles. `pages/PatientsPage.tsx`: coordinator patient directory. `components/PersonalFields.tsx`: reusable personal detail fields. `CoordinatorLinks.tsx`: coordinator navigation links. |
| `caregivers/` | `pages/CaregiversPage.tsx`: coordinator caregiver directory. `pages/CaregiverConnections.tsx`: invitations and explicit patient-caregiver relationships. |
| `drivers/` | `pages/DriversPage.tsx`: coordinator driver directory and review entry points. `pages/DriverRegistration.tsx`: driver vehicle submission and vehicle details. Driver personal profiles remain in `profiles/`. |
| `availability/` | `pages/DriverAvailability.tsx`: driver availability editor. `components/WeeklyAvailabilityView.tsx`: weekly calendar. `DriverAvailabilityDialog.tsx`: driver calendar dialog. `lib/planningWindow.ts`: planning date helpers. |
| `treatments/` | `pages/TreatmentSchedules.tsx`: treatment creation, listing, change review and generation controls. `components/TreatmentChangeDialog.tsx`: proposed schedule changes. |
| `trips/` | `pages/TripsPage.tsx`: role-specific trip lists and details. Components and helpers are explained below. |
| `calendar/` | `components/CalendarControls.tsx`: Google Calendar connection, consent return handling and per-trip event/reminder controls. |
| `notifications/` | `components/TripNotifications.tsx`: persistent inbox, unread state and notification actions. |
| `demo/` | `components/DemoTools.tsx`: authorised scenario controls. `lib/demoSession.ts`: in-memory switched identity and session-change notifications. |

### Trip components

These live in `frontend/src/features/trips/components/`.

| File | Responsibility |
| --- | --- |
| `TripAssignmentDialog.tsx` | Coordinator driver selection and assignment confirmation. |
| `TripProgress.tsx` | Explicit driver Start/Complete actions and location-sharing controls. |
| `TripRouteMap.tsx` | Leaflet route, endpoints, incident markers and tracking display. |
| `TripTraffic.tsx` | Traffic assessment and warning presentation. |
| `TripRecoveryDialog.tsx` | Recovery proposals and coordinator approval, including handover confirmation. |
| `TripHistoryDialog.tsx` | Paginated trip event history. |
| `TripFeedback.tsx` | Completed-trip ratings and driver preference controls. |

`features/trips/lib/location.ts` wraps browser geolocation. `tripClock.ts` supplies demo-aware business time; it is separate from ordinary credential/cache time.

## 3. Shared frontend code and styling

| Location | Responsibility |
| --- | --- |
| `shared/lib/api.ts` | HTTP requests, access-token selection, cancellation, deadlines and API errors. |
| `shared/lib/supabase.ts` | Browser Supabase client and authentication configuration. |
| `shared/ui/DashboardUI.tsx` | Common headings, overlays, list controls and feedback states. |
| `shared/ui/Dropdown.tsx` | Shared dropdown control. |
| `shared/ui/Toast.tsx` | Toast notifications. |
| `shared/ui/ThemeControl.tsx` | Light/dark theme controls. |
| `shared/ui/BrandMark.tsx` | Shared brand presentation. |
| `styles/tokens.css` | Theme colours, typography defaults and design tokens. |
| `styles/base.css`, `public.css`, `dashboard.css` | Base rules, public/auth screens and signed-in shell styling. |
| `styles/components/` | Shared forms, lists, dropdowns, dialogs, buttons and feedback styling. |
| `styles/pages/` | Patient, profile, trip, schedule and availability styling. |
| `styles.css` | Import manifest; preserve stylesheet order. |

The folders express ownership, not strict dependency isolation. Existing cross-feature imports remain, including shared API code reading demo-session state and UI code referencing account types. Put feature-specific UI with its feature; use `shared/` for code needed across features.

## 4. Backend domains

Most domains contain a controller, service and Nest module. Controllers expose HTTP routes; services check and coordinate requests; modules register controllers/providers and dependencies.

| Folder under `backend/src/` | Responsibility |
| --- | --- |
| `auth/` | Verifies Supabase identities, reads current account permissions and registers eligible account roles. |
| `profiles/` | Owned profiles, coordinator patient/caregiver operations, caregiver invitations and link management. `validation/` contains `patient-input.ts` and `personal-input.ts`. |
| `drivers/` | Driver records, vehicle submissions, coordinator approval/rejection and driver statistics. `availability/` contains the availability controller and service. |
| `scheduling/` | Treatment schedules, change requests, reviews and automatic-generation settings. `validation/treatment-input.ts` validates schedule details. |
| `trips/` | Trip lists, generation, assignment, patient actions, execution, location sharing, notifications, history and feedback. Subfolders are explained below. |
| `demo/` | `demo.module.ts` contains the protected demo controller, service and module: fixture setup, actor switching and simulation controls. |

### Trip backend internals

| Location under `backend/src/trips/` | Responsibility |
| --- | --- |
| `trips.controller.ts` | Trip HTTP endpoints. |
| `trips.service.ts` | Access/input checks and orchestration of trip database operations. |
| `trips.module.ts` | Registers trip services and their dependencies. |
| `routing/trip-routing.service.ts` | Route preparation, trusted cache use, traffic assessment, recovery assessment and approval revalidation. |
| `traffic/route-traffic.ts` | Matches provider traffic observations to road-route geometry. |
| `traffic/traffic-monitor.service.ts` | Leased background traffic/recovery processing. |
| `lib/trip-clock.ts` | Backend trip business-time helper for tagged demo scenarios. |

## 5. Integrations and infrastructure

| Location under `backend/src/` | Responsibility |
| --- | --- |
| `integrations/calendar/calendar.controller.ts` | Connection status, authorisation, callback/confirmation, disconnect and trip reminder endpoints. |
| `integrations/calendar/calendar.service.ts` | OAuth/PKCE, encrypted tokens, refresh, Calendar event synchronisation, queued retries and disconnect cleanup. This is implemented code, not a stub. |
| `integrations/onemap/onemap.service.ts` | Provider authentication, address search/resolution and driving routes. |
| `integrations/lta/lta.service.ts` | Traffic incidents/speed feeds, caching and provider deadlines. |
| `integrations/integrations.module.ts` | Registers the provider services and Calendar controller. |
| `infrastructure/database/supabase.module.ts` | User-scoped database clients and separate server integration client. |
| `common/filters/request-body.filter.ts` | Sanitises malformed-request parser errors. |
| `common/types.ts` | Shared roles, coordinates, locations and trip status/lifecycle types. |

Provider credentials stay on the backend where required. Consult setup documentation for required environment variables; file presence does not prove hosted configuration or successful live integration.

## 6. Database: storage and business rules

[database/schema.sql](../database/schema.sql) is the consolidated schema. It includes tables, row-level security, grants, functions, triggers and constraints. Multi-step operations such as assignment and change approval use database operations to preserve ownership, version checks and atomicity.

| Area | Main table groups |
| --- | --- |
| Accounts and relationships | `accounts`, `patients`, `drivers`, `caregivers`, `caregiver_links`, private invitation/link records. |
| Vehicles and availability | `driver_vehicles`, `driver_availability`, `driver_week_availability`. |
| Treatments | `dialysis_centres`, `treatment_schedules`, `treatment_change_requests`, `treatment_trip_generation`. |
| Trips and communication | `trips`, `trip_history`, `trip_notifications`, `trip_locations`. |
| Routing and recovery | `driving_routes`, private traffic checks and recovery options/checks. |
| Feedback | Private driver ratings and preferences. |
| Calendar | `calendar_connections`, `calendar_oauth_states`, `calendar_reminders`. |
| Demo | Private seeded-account and demo-scenario records. |

[database/seed.sql](../database/seed.sql) contains seed setup. Keep schema statement order intact; domain folders do not imply separate SQL migrations or a different deployment process.

## 7. Tests and TypeScript configuration

| Location | Purpose |
| --- | --- |
| `frontend/tests/*.spec.ts` | Playwright user workflows; `support/fixtures.ts` holds synthetic identities and API/Auth mocks. |
| `backend/test/*.test.ts` | API, validation, access boundaries, provider behavior and supporting logic. |
| `database/tests/*.test.mjs` | Database permissions, functions, integrity and demo-clock coverage. |
| [frontend/tsconfig.json](../frontend/tsconfig.json) | Frontend and frontend-test checking: `ESNext` modules with `Bundler` resolution. |
| [backend/tsconfig.json](../backend/tsconfig.json) | Production backend source: `NodeNext` modules/resolution; emits to `backend/dist/`. |
| [backend/test/tsconfig.json](../backend/test/tsconfig.json) | Test editor/check configuration: explicit Node types, `ESNext`/`Bundler`, no emitted files. |

Backend tests use `tsx`; their configuration is separate from the production build. Existing test discovery paths remain unchanged.

Run from the application root:

```sh
npm run dev                         # Frontend and backend development servers
npm run build                       # Both production builds
npm run check --workspace frontend  # Frontend and frontend-test type-checking
npm run check --workspace backend   # Backend source AND backend-test type-checking
```

The check commands compile types without executing test cases. Automated test execution requires an explicit user request under the repository's existing policy. This reindex only verifies file locations and document links; it is not a new runtime verification.

## 8. Documentation and submitted artifacts

| Location | What to read it for |
| --- | --- |
| [README.md](../README.md) | Startup, commands, repository overview and test policy. |
| [docs/development.md](development.md) | Environment/deployment setup, demo walkthrough and verification limitations. |
| [docs/authentication.md](authentication.md) | Authentication setup and account behavior. |
| [docs/use-case-map.md](use-case-map.md) | Feature coverage, scope and operational rules. |
| [docs/apis-and-responsive-design.md](apis-and-responsive-design.md) | Integration/UI conventions. |
| `docs/use-cases.pdf`, `use-case-model.pdf` | Submitted use-case descriptions and model. |
| `docs/System_Architecture.pdf`, `Dynamic_Model_Dialog_Map.pdf` | Submitted architecture and interaction diagrams. |
| `docs/system_architecture.py`, `dialog_map.py` | Diagram generators. |
| `docs/Design_Model.puml`, `Design_Model.jpeg` | Design-model source and rendered image. |
| `docs/test_cases_results.pdf` | Submitted test report; not proof of a new test run. |
| `docs/superpowers/specs/`, `plans/` | Design/implementation records; historical documents may use former paths. |
| [AGENTS.md](../AGENTS.md), [CLAUDE.md](../CLAUDE.md) | Agent instructions; consult current code and authoritative docs when older notes disagree. |

## 9. Suggested reading order for explaining the project

1. Read `app/routes.tsx` and `app/Dashboard.tsx` to see what each role can open.
2. Open a feature page such as `features/trips/pages/TripsPage.tsx` to see its user workflow.
3. Follow its API call through `shared/lib/api.ts` to the backend controller and service.
4. Follow the service's table or RPC call into `database/schema.sql` for the actual data/permission rules.
5. Follow routing, traffic or Calendar calls into the relevant integration.
6. Read the corresponding test files for examples and intended boundaries; distinguish those examples from tests actually executed.

## 10. Complete source-file index

The lists below are generated from the current filesystem. Paths are relative to the application root. Generated build output and dependencies are excluded.

### Frontend source

- [frontend/src/app/App.tsx](../frontend/src/app/App.tsx)
- [frontend/src/app/components/DashboardViewState.tsx](../frontend/src/app/components/DashboardViewState.tsx)
- [frontend/src/app/components/PageLayout.tsx](../frontend/src/app/components/PageLayout.tsx)
- [frontend/src/app/Dashboard.tsx](../frontend/src/app/Dashboard.tsx)
- [frontend/src/app/routes.tsx](../frontend/src/app/routes.tsx)
- [frontend/src/features/auth/lib/googleAccountSelection.ts](../frontend/src/features/auth/lib/googleAccountSelection.ts)
- [frontend/src/features/auth/pages/AccountPanel.tsx](../frontend/src/features/auth/pages/AccountPanel.tsx)
- [frontend/src/features/auth/pages/LoginPage.tsx](../frontend/src/features/auth/pages/LoginPage.tsx)
- [frontend/src/features/availability/components/DriverAvailabilityDialog.tsx](../frontend/src/features/availability/components/DriverAvailabilityDialog.tsx)
- [frontend/src/features/availability/components/WeeklyAvailabilityView.tsx](../frontend/src/features/availability/components/WeeklyAvailabilityView.tsx)
- [frontend/src/features/availability/lib/planningWindow.ts](../frontend/src/features/availability/lib/planningWindow.ts)
- [frontend/src/features/availability/pages/DriverAvailability.tsx](../frontend/src/features/availability/pages/DriverAvailability.tsx)
- [frontend/src/features/calendar/components/CalendarControls.tsx](../frontend/src/features/calendar/components/CalendarControls.tsx)
- [frontend/src/features/caregivers/pages/CaregiverConnections.tsx](../frontend/src/features/caregivers/pages/CaregiverConnections.tsx)
- [frontend/src/features/caregivers/pages/CaregiversPage.tsx](../frontend/src/features/caregivers/pages/CaregiversPage.tsx)
- [frontend/src/features/demo/components/DemoTools.tsx](../frontend/src/features/demo/components/DemoTools.tsx)
- [frontend/src/features/demo/lib/demoSession.ts](../frontend/src/features/demo/lib/demoSession.ts)
- [frontend/src/features/drivers/pages/DriverRegistration.tsx](../frontend/src/features/drivers/pages/DriverRegistration.tsx)
- [frontend/src/features/drivers/pages/DriversPage.tsx](../frontend/src/features/drivers/pages/DriversPage.tsx)
- [frontend/src/features/notifications/components/TripNotifications.tsx](../frontend/src/features/notifications/components/TripNotifications.tsx)
- [frontend/src/features/profiles/components/CoordinatorLinks.tsx](../frontend/src/features/profiles/components/CoordinatorLinks.tsx)
- [frontend/src/features/profiles/components/PersonalFields.tsx](../frontend/src/features/profiles/components/PersonalFields.tsx)
- [frontend/src/features/profiles/pages/DriverProfile.tsx](../frontend/src/features/profiles/pages/DriverProfile.tsx)
- [frontend/src/features/profiles/pages/PatientProfile.tsx](../frontend/src/features/profiles/pages/PatientProfile.tsx)
- [frontend/src/features/profiles/pages/PatientsPage.tsx](../frontend/src/features/profiles/pages/PatientsPage.tsx)
- [frontend/src/features/treatments/components/TreatmentChangeDialog.tsx](../frontend/src/features/treatments/components/TreatmentChangeDialog.tsx)
- [frontend/src/features/treatments/pages/TreatmentSchedules.tsx](../frontend/src/features/treatments/pages/TreatmentSchedules.tsx)
- [frontend/src/features/trips/components/TripAssignmentDialog.tsx](../frontend/src/features/trips/components/TripAssignmentDialog.tsx)
- [frontend/src/features/trips/components/TripFeedback.tsx](../frontend/src/features/trips/components/TripFeedback.tsx)
- [frontend/src/features/trips/components/TripHistoryDialog.tsx](../frontend/src/features/trips/components/TripHistoryDialog.tsx)
- [frontend/src/features/trips/components/TripProgress.tsx](../frontend/src/features/trips/components/TripProgress.tsx)
- [frontend/src/features/trips/components/TripRecoveryDialog.tsx](../frontend/src/features/trips/components/TripRecoveryDialog.tsx)
- [frontend/src/features/trips/components/TripRouteMap.tsx](../frontend/src/features/trips/components/TripRouteMap.tsx)
- [frontend/src/features/trips/components/TripTraffic.tsx](../frontend/src/features/trips/components/TripTraffic.tsx)
- [frontend/src/features/trips/lib/location.ts](../frontend/src/features/trips/lib/location.ts)
- [frontend/src/features/trips/lib/tripClock.ts](../frontend/src/features/trips/lib/tripClock.ts)
- [frontend/src/features/trips/pages/TripsPage.tsx](../frontend/src/features/trips/pages/TripsPage.tsx)
- [frontend/src/main.tsx](../frontend/src/main.tsx)
- [frontend/src/shared/lib/api.ts](../frontend/src/shared/lib/api.ts)
- [frontend/src/shared/lib/supabase.ts](../frontend/src/shared/lib/supabase.ts)
- [frontend/src/shared/ui/BrandMark.tsx](../frontend/src/shared/ui/BrandMark.tsx)
- [frontend/src/shared/ui/DashboardUI.tsx](../frontend/src/shared/ui/DashboardUI.tsx)
- [frontend/src/shared/ui/Dropdown.tsx](../frontend/src/shared/ui/Dropdown.tsx)
- [frontend/src/shared/ui/ThemeControl.tsx](../frontend/src/shared/ui/ThemeControl.tsx)
- [frontend/src/shared/ui/Toast.tsx](../frontend/src/shared/ui/Toast.tsx)
- [frontend/src/styles/base.css](../frontend/src/styles/base.css)
- [frontend/src/styles/components/button-variants.css](../frontend/src/styles/components/button-variants.css)
- [frontend/src/styles/components/controls.css](../frontend/src/styles/components/controls.css)
- [frontend/src/styles/components/dialogs.css](../frontend/src/styles/components/dialogs.css)
- [frontend/src/styles/components/dropdown.css](../frontend/src/styles/components/dropdown.css)
- [frontend/src/styles/components/feedback.css](../frontend/src/styles/components/feedback.css)
- [frontend/src/styles/components/lists.css](../frontend/src/styles/components/lists.css)
- [frontend/src/styles/dashboard.css](../frontend/src/styles/dashboard.css)
- [frontend/src/styles/pages/availability.css](../frontend/src/styles/pages/availability.css)
- [frontend/src/styles/pages/patients.css](../frontend/src/styles/pages/patients.css)
- [frontend/src/styles/pages/profile.css](../frontend/src/styles/pages/profile.css)
- [frontend/src/styles/pages/schedules.css](../frontend/src/styles/pages/schedules.css)
- [frontend/src/styles/pages/trips.css](../frontend/src/styles/pages/trips.css)
- [frontend/src/styles/public.css](../frontend/src/styles/public.css)
- [frontend/src/styles/README.md](../frontend/src/styles/README.md)
- [frontend/src/styles/tokens.css](../frontend/src/styles/tokens.css)
- [frontend/src/styles.css](../frontend/src/styles.css)

### Backend source

- [backend/src/app.module.ts](../backend/src/app.module.ts)
- [backend/src/auth/auth.controller.ts](../backend/src/auth/auth.controller.ts)
- [backend/src/auth/auth.module.ts](../backend/src/auth/auth.module.ts)
- [backend/src/auth/auth.service.ts](../backend/src/auth/auth.service.ts)
- [backend/src/common/filters/request-body.filter.ts](../backend/src/common/filters/request-body.filter.ts)
- [backend/src/common/types.ts](../backend/src/common/types.ts)
- [backend/src/demo/demo.module.ts](../backend/src/demo/demo.module.ts)
- [backend/src/drivers/availability/availability.controller.ts](../backend/src/drivers/availability/availability.controller.ts)
- [backend/src/drivers/availability/availability.service.ts](../backend/src/drivers/availability/availability.service.ts)
- [backend/src/drivers/drivers.controller.ts](../backend/src/drivers/drivers.controller.ts)
- [backend/src/drivers/drivers.module.ts](../backend/src/drivers/drivers.module.ts)
- [backend/src/drivers/drivers.service.ts](../backend/src/drivers/drivers.service.ts)
- [backend/src/infrastructure/database/supabase.module.ts](../backend/src/infrastructure/database/supabase.module.ts)
- [backend/src/integrations/calendar/calendar.controller.ts](../backend/src/integrations/calendar/calendar.controller.ts)
- [backend/src/integrations/calendar/calendar.service.ts](../backend/src/integrations/calendar/calendar.service.ts)
- [backend/src/integrations/integrations.module.ts](../backend/src/integrations/integrations.module.ts)
- [backend/src/integrations/lta/lta.service.ts](../backend/src/integrations/lta/lta.service.ts)
- [backend/src/integrations/onemap/onemap.service.ts](../backend/src/integrations/onemap/onemap.service.ts)
- [backend/src/main.ts](../backend/src/main.ts)
- [backend/src/profiles/profiles.controller.ts](../backend/src/profiles/profiles.controller.ts)
- [backend/src/profiles/profiles.module.ts](../backend/src/profiles/profiles.module.ts)
- [backend/src/profiles/profiles.service.ts](../backend/src/profiles/profiles.service.ts)
- [backend/src/profiles/validation/patient-input.ts](../backend/src/profiles/validation/patient-input.ts)
- [backend/src/profiles/validation/personal-input.ts](../backend/src/profiles/validation/personal-input.ts)
- [backend/src/scheduling/scheduling.controller.ts](../backend/src/scheduling/scheduling.controller.ts)
- [backend/src/scheduling/scheduling.module.ts](../backend/src/scheduling/scheduling.module.ts)
- [backend/src/scheduling/scheduling.service.ts](../backend/src/scheduling/scheduling.service.ts)
- [backend/src/scheduling/validation/treatment-input.ts](../backend/src/scheduling/validation/treatment-input.ts)
- [backend/src/trips/lib/trip-clock.ts](../backend/src/trips/lib/trip-clock.ts)
- [backend/src/trips/routing/trip-routing.service.ts](../backend/src/trips/routing/trip-routing.service.ts)
- [backend/src/trips/traffic/route-traffic.ts](../backend/src/trips/traffic/route-traffic.ts)
- [backend/src/trips/traffic/traffic-monitor.service.ts](../backend/src/trips/traffic/traffic-monitor.service.ts)
- [backend/src/trips/trips.controller.ts](../backend/src/trips/trips.controller.ts)
- [backend/src/trips/trips.module.ts](../backend/src/trips/trips.module.ts)
- [backend/src/trips/trips.service.ts](../backend/src/trips/trips.service.ts)

### Frontend tests

- [frontend/tests/account.spec.ts](../frontend/tests/account.spec.ts)
- [frontend/tests/auth.spec.ts](../frontend/tests/auth.spec.ts)
- [frontend/tests/dashboard.spec.ts](../frontend/tests/dashboard.spec.ts)
- [frontend/tests/drivers.spec.ts](../frontend/tests/drivers.spec.ts)
- [frontend/tests/patients.spec.ts](../frontend/tests/patients.spec.ts)
- [frontend/tests/registration.spec.ts](../frontend/tests/registration.spec.ts)
- [frontend/tests/routing.spec.ts](../frontend/tests/routing.spec.ts)
- [frontend/tests/schedules.spec.ts](../frontend/tests/schedules.spec.ts)
- [frontend/tests/support/fixtures.ts](../frontend/tests/support/fixtures.ts)
- [frontend/tests/trips.spec.ts](../frontend/tests/trips.spec.ts)

### Backend tests and their config

- [backend/test/accounts.test.ts](../backend/test/accounts.test.ts)
- [backend/test/blackbox-api.test.ts](../backend/test/blackbox-api.test.ts)
- [backend/test/cors.test.ts](../backend/test/cors.test.ts)
- [backend/test/demo-clock.test.ts](../backend/test/demo-clock.test.ts)
- [backend/test/drivers.test.ts](../backend/test/drivers.test.ts)
- [backend/test/input-boundaries.test.ts](../backend/test/input-boundaries.test.ts)
- [backend/test/patients.test.ts](../backend/test/patients.test.ts)
- [backend/test/route-traffic.test.ts](../backend/test/route-traffic.test.ts)
- [backend/test/routing.test.ts](../backend/test/routing.test.ts)
- [backend/test/service-boundaries.test.ts](../backend/test/service-boundaries.test.ts)
- [backend/test/treatments.test.ts](../backend/test/treatments.test.ts)
- [backend/test/tsconfig.json](../backend/test/tsconfig.json)

### Database files

- [database/schema.sql](../database/schema.sql)
- [database/seed.sql](../database/seed.sql)
- [database/tests/accounts.test.mjs](../database/tests/accounts.test.mjs)
- [database/tests/demo-clock.test.mjs](../database/tests/demo-clock.test.mjs)
