import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['recharts', 'reactflow', 'dagre', 'react-virtuoso', 'react', 'react-dom'],
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://nginx:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://nginx:8000',
        ws: true,
      },
    },
  },
})
