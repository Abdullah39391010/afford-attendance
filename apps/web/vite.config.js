import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const version = JSON.parse(readFileSync(resolve(__dirname, '../version.json'), 'utf8'));

export default defineConfig(({ mode }) => {
  const app = mode === 'employee' ? 'employee' : 'admin';
  return {
    root: resolve(__dirname, app),
    publicDir: resolve(__dirname, 'public'),
    base: './',
    plugins: [preact()],
    define: {
      __APP_KIND__: JSON.stringify(app),
      __APP_VERSION__: JSON.stringify(version.version),
      __APP_BUILD__: JSON.stringify(process.env.BUILD_NUMBER || ''),
      __API_URL__: JSON.stringify(process.env.API_URL || ''),
      __WEB_APP__: JSON.stringify(process.env.WEB_APP === '1'),
    },
    server: { fs: { allow: [resolve(__dirname, '..')] }, port: app === 'admin' ? 5173 : 5174 },
    build: { outDir: process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(__dirname, `dist-${app}`), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  };
});
