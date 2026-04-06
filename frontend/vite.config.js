import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'aws-sdk': [
            '@aws-sdk/client-bedrock-agentcore',
            '@aws-sdk/client-lambda',
          ],
          'aws-amplify': ['aws-amplify', '@aws-amplify/ui-react'],
        },
      },
    },
  },
})
