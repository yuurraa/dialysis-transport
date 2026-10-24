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

The Playwright suite contains 58 browser tests grouped by feature in `frontend/tests/`:

| Spec | Tests | Scope |
| --- | ---: | --- |
| `auth.spec.ts` | 8 | Google PKCE/callback, logout, rejected/expired sessions, inactive accounts and sign-out races |
| `registration.spec.ts` | 5 | Patient/Driver personal signup, validation/Back, cancellation, retry and an already-registered Google identity |
| `dashboard.spec.ts` | 8 | Protected routes, role navigation, mobile menu focus/dismissal and account details |
| `patients.spec.ts` | 4 | Permitted coordinator edits, search/sorting/pagination, failures and version conflicts |
| `account.spec.ts` | 3 | In-place patient editing, cancellation, save failures, inactive profiles and version conflicts |
| `schedules.spec.ts` | 11 | Recurring/single sessions, rescheduling, deletion, search, load/save failures, stale versions and coordinator trip-generation coverage |
| `drivers.spec.ts` | 9 | Vehicle submission/retry, coordinator review and Status edits; approved-driver weekly availability, stale saves, mobile time-range editing, My Vehicle navigation through reapproval and personal-profile editing and coordinator read-only availability popups |
| `trips.spec.ts` | 7 | Role-specific journeys, pickup requirements, filters, generation and deletion recovery |
| `lists.spec.ts` | 3 | Search/filter/sort wiring across the three lists and mobile toolbar usability |

`support/fixtures.ts` holds shared synthetic session data, existing interaction helpers and explicit API/Auth mocks. Feature-specific responses stay in the specs. Browser tests exercise React and its requests against mocked services; they do not establish server authorisation or database integrity.

Detailed input/date validation and role restrictions belong in `backend/test/`. Ownership/RLS, overlap rules, atomic rescheduling/deletion, concurrency and idempotent trip generation remain covered in `database/tests/`. Representative phone interactions remain in feature tests; exhaustive viewport/theme matrices, pixel-level styling checks and bulk screenshot capture are outside this suite's scope. Add browser coverage for new operational features when they are implemented, rather than testing placeholder screens.

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
