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
