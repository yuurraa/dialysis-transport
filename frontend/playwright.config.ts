import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 15000,
  expect: { timeout: 4000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    launchOptions: process.platform === 'win32' ? { channel: 'msedge' } : {},
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      VITE_SUPABASE_URL: 'https://auth.example.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture',
      VITE_API_URL: '',
    },
  },
});
