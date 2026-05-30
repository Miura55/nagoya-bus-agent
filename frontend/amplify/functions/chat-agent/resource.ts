import { defineFunction } from '@aws-amplify/backend'

export const chatAgent = defineFunction({
  name: 'chat-agent',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
  memoryMB: 1024,
  environment: {
    AGENTCORE_REGION: 'ap-northeast-1',
    // AGENTCORE_RUNTIME_ARN は backend.ts で SSM パラメータ
    // (/nagoya-bus-agent/runtime-arn) から解決して注入する。
    // ARN/アカウントID をソースに埋め込まないため、ここには記載しない。
  },
})
