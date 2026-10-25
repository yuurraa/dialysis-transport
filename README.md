# Dialysis Transport

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

The entire suite has a shared ceiling of approximately **70 tests**, including future features. The current source declares **51 tests**: **16 frontend, 15 backend and 20 database**, including the optional local PostgreSQL concurrency test. This leaves 19 cases for remaining implementation. Counts include every parameterized variant and optional test; do not hide cases in giant combined tests to meet the limit.

Keep each concern at its strongest layer: frontend for a few real user workflows; backend for HTTP/session boundaries, request validation and error mapping; database for RLS, atomic updates, uniqueness, deletion/restoration and concurrency. Before adding a test, remove or replace lower-value overlap. Cosmetic changes do not warrant a new case.

| Layer / spec | Tests | Scope |
| --- | ---: | --- |
| Frontend `auth.spec.ts` | 2 | PKCE login and sign-out |
| Frontend `registration.spec.ts` | 2 | Patient and Driver signup |
| Frontend `dashboard.spec.ts` | 1 | Mobile navigation and focus/dismissal |
| Frontend `patients.spec.ts` | 1 | Coordinator patient editing |
| Frontend `account.spec.ts` | 1 | Patient profile editing and cancellation |
| Frontend `schedules.spec.ts` | 3 | Treatment save, rescheduling and auto-generation settings |
| Frontend `drivers.spec.ts` | 3 | Vehicle submission, coordinator review and availability editing |
| Frontend `trips.spec.ts` | 3 | Patient journey details, generation recovery and bulk deletion |
| Backend `accounts.test.ts` | 3 | Verified identities, signup privileges and provider failures |
| Backend `patients.test.ts` | 3 | Role access, coordinator field restrictions and owned profiles |
| Backend `drivers.test.ts` | 3 | Role access, vehicle review and availability validation |
| Backend `treatments.test.ts` | 5 | Treatment validation/access, trip requests and auto-generation permissions |
| Backend `cors.test.ts` | 1 | Actual startup and browser-origin CORS |
| Database `accounts.test.mjs` | 20 | Storage permissions, atomicity, current features and concurrency |

`support/fixtures.ts` holds shared synthetic session data, existing interaction helpers and explicit API/Auth mocks. Feature-specific responses stay in the specs. Browser tests exercise React and its requests against mocked services; they do not establish server authorisation or database integrity.

Detailed input/date validation and role restrictions belong in `backend/test/`. Ownership/RLS, overlap rules, atomic rescheduling/deletion, concurrency and idempotent trip generation remain covered in `database/tests/`. Representative phone interactions remain in feature tests; exhaustive viewport/theme matrices, pixel-level styling checks and bulk screenshot capture are outside this suite's scope. Add browser coverage for new operational features when they are implemented, rather than testing placeholder screens.

Cosmetic-only changes do not need new frontend tests. Keep browser coverage short and focused on user workflows; avoid pixel measurements, animation internals, DOM-identity checks and repeated assertions already covered by another feature test.

Tests are run manually by the user. Agents may update tests but must not execute them without an explicit request. The TypeScript check is static and does not run browser tests.

## Project structure

```text
frontend/   React application
backend/    NestJS API
database/  Database setup and permission tests
docs/      Setup, deployment and requirements reference
```

## Documentation

- [Development and deployment](docs/development.md)
- [Authentication](docs/authentication.md)
- [Use-case coverage](docs/use-case-map.md)
- [Integrations and responsive design](docs/apis-and-responsive-design.md)
