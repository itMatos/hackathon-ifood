import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// This development container extracts optional system libraries into /tmp.
// Normal developer machines use Chromium's installed system dependencies.
const localLibraries = '/tmp/viu-browser-libs/extracted/usr/lib/x86_64-linux-gnu';
const browserEnvironment = existsSync(localLibraries)
  ? { ...process.env, LD_LIBRARY_PATH: [localLibraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
  : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 1 : 2,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: browserEnvironment ? { env: browserEnvironment } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
  webServer: { command: 'npm run dev', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 60_000 },
});
