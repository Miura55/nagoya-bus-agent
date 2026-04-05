import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { chatAgent } from './functions/chat-agent/resource';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  chatAgent,
});

backend.chatAgent.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'bedrock-agentcore:InvokeAgentRuntime',
      'bedrock-agentcore:InvokeAgentRuntimeForUser',
    ],
    resources: [
      'arn:aws:bedrock-agentcore:ap-northeast-1:842842563143:runtime/nagoya_bus_agent-5kxzQ77l0p',
      'arn:aws:bedrock-agentcore:ap-northeast-1:842842563143:runtime/nagoya_bus_agent-5kxzQ77l0p/runtime-endpoint/*',
    ],
  }),
);

// Use wildcard resource here to avoid self-referential ARN dependencies that can
// create circular references with AppSync resolver resources in the same stack.
backend.chatAgent.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: ['*'],
  }),
);
