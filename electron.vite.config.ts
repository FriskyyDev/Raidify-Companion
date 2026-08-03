import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // CommonJS, explicitly, so the window can run with `sandbox: true`. A sandboxed
        // preload is not an ES module — with `"type": "module"` the default output would
        // be .mjs, which a sandboxed renderer silently refuses to load, and a preload
        // that silently fails to load is how this app shipped once already unable to do
        // anything at all. src/main/build.test.ts asserts the two agree.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@': resolve('src/renderer') },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
