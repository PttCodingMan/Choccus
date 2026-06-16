import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    fs: {
      // Allow importing ../shared (outside the client root).
      allow: ['..'],
    },
  },
});
