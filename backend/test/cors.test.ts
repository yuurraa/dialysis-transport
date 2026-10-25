import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

/** Exercise main.ts itself: a mocked app configuration would miss the deployed CORS defect. */
test('a frontend URL with a trailing slash still allows the browser origin on account requests', { timeout: 45000 }, async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    env: { ...process.env, PORT: String(port), FRONTEND_ORIGIN: 'https://frontend.example.test/' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.stdout.on('data', data => { logs += String(data); });
  child.stderr.on('data', data => { logs += String(data); });
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    // Windows may need longer to load tsx/Nest while the other test files start.
    // Exit immediately on a process failure instead of treating it as a slow boot.
    const startupStarted = Date.now();
    const deadline = startupStarted + 30000;
    while (Date.now() < deadline && !spawnError && child.exitCode === null && child.signalCode === null) {
      try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Wait for the actual Nest listener. */ }
      if (ready) break;
      await setTimeout(50);
    }
    assert.ok(ready, `Backend did not start after ${Date.now() - startupStarted}ms. `
      + `Spawn error: ${spawnError?.message ?? 'none'}. Exit code: ${child.exitCode ?? 'none'}. Signal: ${child.signalCode ?? 'none'}. `
      + `Output: ${logs || '(no output received)'}`);
    const response = await fetch(`${base}/api/auth/me`, { method: 'OPTIONS', headers: {
      Origin: 'https://frontend.example.test',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://frontend.example.test');
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /authorization/i);
    const identity = await fetch(`${base}/api/auth/me`, { headers: { Origin: 'https://frontend.example.test' } });
    assert.equal(identity.status, 401); // CORS access must not bypass sign-in.
    assert.equal(identity.headers.get('access-control-allow-origin'), 'https://frontend.example.test');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = globalThis.setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
});
