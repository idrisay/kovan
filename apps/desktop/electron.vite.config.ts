import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * The workspace packages are bundled rather than externalized.
 *
 * `tsc` emits extensionless relative imports (`export * from './types'`), which
 * Node's ESM resolver rejects outright. Rewriting every import in the ported
 * extension code to carry a `.js` suffix would be a large, purely mechanical
 * diff across code that is otherwise unmodified — so the bundler resolves them
 * instead, which also gives the main process a single file to load and keeps
 * `asar` packing simple.
 */
const bundleWorkspace = { exclude: ['@baton/core', '@baton/host', '@baton/providers'] };

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin(bundleWorkspace)] },
  preload: { plugins: [externalizeDepsPlugin(bundleWorkspace)] },
  renderer: { plugins: [react()] }
});
