import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 前端 4025、后端 3025。用 proxy 把 /runs 转给后端，前端就能写相对路径，
// 不用处理 CORS，也不用把后端地址编进代码。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4025,
    strictPort: true,
    proxy: { '/runs': 'http://127.0.0.1:3025' },
  },
})
