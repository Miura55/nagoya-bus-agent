import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
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

// Pass the AppSync GraphQL endpoint to the Lambda so it can publish streaming chunks.
const { cfnResources } = backend.data.resources;
(backend.chatAgent.resources.lambda as LambdaFunction).addEnvironment(
  'APPSYNC_GRAPHQL_URL',
  cfnResources.cfnGraphqlApi.attrGraphQlUrl,
);
