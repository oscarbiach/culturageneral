import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El repo se publica en https://<usuario>.github.io/culturageneral/, asi que el
// bundle tiene que resolver sus assets desde ese subdirectorio. En dev queda en '/'.
const base = process.env.APP_BASE ?? '/culturageneral/';

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : base,
  plugins: [react()],
  build: {
    target: 'es2020',
    cssTarget: 'safari15',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
