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
});
