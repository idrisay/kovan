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
const bundleWorkspace = { exclude: ['@kovan/core', '@kovan/host', '@kovan/providers'] };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: {
      rollupOptions: {
        // The terminal host (item 114) is its own small program, run by
        // Electron in Node mode from outside the app archive. `.mjs`, because
        // there it has no package.json saying "module".
        input: { index: 'src/main/index.ts', ptyHost: 'src/main/ptyHost.ts' },
        output: { entryFileNames: (chunk) => (chunk.name === 'ptyHost' ? '[name].mjs' : '[name].js') }
      }
    }
  },
  // CommonJS, because the window is sandboxed (security review, 2026-10) and
  // a sandboxed preload cannot be an ES module. `.cjs`, because the package
  // says "module" and a `.js` file would be read as one.
  preload: {
    plugins: [externalizeDepsPlugin(bundleWorkspace)],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: { plugins: [react()] }
});
