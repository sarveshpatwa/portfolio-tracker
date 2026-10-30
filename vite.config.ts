import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// `base: './'` keeps asset paths relative, so the same build works on
// GitHub Pages (served from /<repo>/) and Cloudflare Pages (served from /).
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    // Shown in Settings so you can tell which version a device is running.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
