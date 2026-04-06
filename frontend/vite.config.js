import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@aws-sdk/client-bedrock-agentcore') || id.includes('@aws-sdk/client-lambda')) {
            return 'aws-sdk';
          }
          if (id.includes('aws-amplify') || id.includes('@aws-amplify')) {
            return 'aws-amplify';
          }
        },
      },
    },
  },
})
