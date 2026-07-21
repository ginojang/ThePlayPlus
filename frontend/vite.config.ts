import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 서버에서 https://elda-ai.org/theplayplus/ 경로로 서빙되므로
// base 를 반드시 '/theplayplus/' 로 맞춰야 asset 경로가 어긋나지 않는다.
export default defineConfig({
  base: '/theplayplus/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    // 개발 시 /theplayplus/api → 로컬 백엔드(3700) 로 프록시
    proxy: {
      '/theplayplus/api': {
        target: 'http://localhost:3700',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/theplayplus\/api/, '/api'),
      },
    },
  },
});
