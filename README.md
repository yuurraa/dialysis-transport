# OneDialysis

An SC2006 project for coordinating recurring transport to and from dialysis centres, supporting transport coordinators, drivers, patients and caregivers. The web interface adapts to mobile and desktop screens.

## Tech stack

- **Frontend:** React, TypeScript, Vite and Tailwind CSS
- **Backend:** NestJS and TypeScript
- **Database and authentication:** Supabase PostgreSQL, Auth and Realtime
- **Integrations:** OneMap, LTA DataMall and Google Calendar

## Getting started

Requires Node.js 24 LTS and npm. Run commands from the project root.

```sh
npm run install:all
npm run dev
```

Open [localhost:5173](http://localhost:5173). The backend runs on port 3000. Press Ctrl+C to stop both services.

To test on your phone, connect it to the same Wi-Fi as your computer and open the **Network** URL printed by Vite, such as `http://192.168.1.10:5173`. Frontend API requests are forwarded to the backend automatically.

For Supabase authentication, copy `frontend/.env.example` to `frontend/.env.local` and `backend/.env.example` to `backend/.env`. Add your Supabase project URL and publishable key to both files, then restart the services.

Sign-in uses Google through Supabase Auth; enable the Google provider and apply the account database setup before testing with a real account. See [Authentication](docs/authentication.md) for provider setup and the current implementation status.

The web-application is hosted live on https://dialysis-transport.onrender.com. The backend may take a short while to spin up.

## Commands

| Command | Description |
| --- | --- |
| `npm run install:all` | Install root, frontend and backend dependencies |
| `npm run dev` | Run frontend and backend together |
| `npm run dev:frontend` | Run frontend only |
| `npm run dev:backend` | Run backend only |
| `npm run build` | Build frontend and backend |
| `npm test` | Run database, API and browser tests |
| `npm run test --workspace frontend` | Run the Playwright browser suite |
| `npm run test --workspace frontend -- tests/schedules.spec.ts` | Run one browser feature suite |
| `npm run check --workspace frontend` | Check TypeScript without running tests |

## Testing scope

The entire suite has a shared ceiling of approximately **70 tests**, including future features. The current source declares **69 tests**: **19 frontend, 20 backend and 30 database**, including the optional local PostgreSQL concurrency test. This leaves 1 case for remaining implementation. Counts include every parameterized variant and optional test; do not hide cases in giant combined tests to meet the limit.

Keep each concern at its strongest layer: frontend for a few real user workflows; backend for HTTP/session boundaries, request validation and error mapping; database for RLS, atomic updates, uniqueness, deletion/restoration and concurrency. Before adding a test, remove or replace lower-value overlap. Cosmetic changes do not warrant a new case.

| Layer / spec | Tests | Scope |
| --- | ---: | --- |
| Frontend `auth.spec.ts` | 2 | PKCE login and sign-out |
| Frontend `registration.spec.ts` | 2 | Patient and Driver signup |
| Frontend `dashboard.spec.ts` | 1 | Mobile navigation and focus/dismissal |
| Frontend `patients.spec.ts` | 1 | Coordinator patient editing |
| Frontend `account.spec.ts` | 1 | Patient profile editing and cancellation |
| Frontend `schedules.spec.ts` | 3 | Creation confirmation, protected schedules, change-request decisions and auto-generation settings |
| Frontend `drivers.spec.ts` | 4 | Vehicle submission/review, availability editing and dated coordinator calendar |
| Frontend `trips.spec.ts` | 5 | Patient journey details, assignment across roles, generation recovery, bulk deletion, patient pickup actions and explicit driver execution/tracking |
| Backend `accounts.test.ts` | 3 | Verified identities, signup privileges and provider failures |
| Backend `patients.test.ts` | 3 | Role access, coordinator field restrictions and owned profiles |
| Backend `drivers.test.ts` | 3 | Role access, vehicle review and availability validation |
| Backend `treatments.test.ts` | 7 | Treatment validation/access, change requests, assignment validation and trip-generation permissions |
| Backend `routing.test.ts` | 3 | OneMap validation/token handling, LTA complete-feed caching/deadlines and directional route-traffic matching |
| Backend `cors.test.ts` | 1 | Actual startup and browser-origin CORS |
| Database `accounts.test.mjs` | 30 | Storage permissions, assignment eligibility/ownership, atomic approvals, reconciliation, recipient-only notifications/history, disruption reporting, route feasibility, active-trip location scope, trusted traffic-risk persistence, recovery approval and concurrency |

`support/fixtures.ts` holds shared synthetic session data, existing interaction helpers and explicit API/Auth mocks. Feature-specific responses stay in the specs. Browser tests exercise React and its requests against mocked services; they do not establish server authorisation or database integrity.

Detailed input/date validation and role restrictions belong in `backend/test/`. Ownership/RLS, overlap rules, atomic writes and schedule immutability, concurrency and idempotent trip generation remain covered in `database/tests/`. Representative phone interactions remain in feature tests; exhaustive viewport/theme matrices, pixel-level styling checks and bulk screenshot capture are outside this suite's scope. Add browser coverage for new operational features when they are implemented, rather than testing placeholder screens.

Cosmetic-only changes do not need new frontend tests. Keep browser coverage short and focused on user workflows; avoid pixel measurements, animation internals, DOM-identity checks and repeated assertions already covered by another feature test.

Tests run only on an explicit user request. Agents may update tests, but implementation or review requests alone do not authorise execution. The TypeScript check is static and does not run browser tests.

The latest requested combined run passed **68 tests**, with the optional local PostgreSQL concurrency case skipped. Both production builds passed. See [verified checkpoint and remaining setup](docs/development.md#verified-stopping-point) for scope, limitations and the routing/traffic values still needed.

## Project structure

```text
frontend/   React app: app/, features/, shared/, styles/
backend/    NestJS domain modules, common/, infrastructure/, integrations/
database/   Consolidated schema, seed data and permission tests
docs/       Setup, architecture, requirements and implementation records
```

## Documentation

- [Development and deployment](docs/development.md)
- [Authentication](docs/authentication.md)
- [Use-case coverage and ordered implementation priorities](docs/use-case-map.md)
- [Integrations and responsive design](docs/apis-and-responsive-design.md)

- [Source layout and ownership](docs/folder-structure.md)
