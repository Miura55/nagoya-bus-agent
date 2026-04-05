import { defineFunction } from '@aws-amplify/backend'

export const chatAgent = defineFunction({
  name: 'chat-agent',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 120,
  memoryMB: 1024,
  environment: {
    AGENTCORE_REGION: 'ap-northeast-1',
    AGENTCORE_RUNTIME_ARN:
      'arn:aws:bedrock-agentcore:ap-northeast-1:842842563143:runtime/nagoya_bus_agent-5kxzQ77l0p',
  },
})
