import { defineBackend } from '@aws-amplify/backend';
import { Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
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

const lambda = backend.chatAgent.resources.lambda;
const stack = Stack.of(lambda);

// AgentCore Runtime ARN は CDK アプリ(infra/)が SSM パラメータに書き出した値を
// デプロイ時に参照する。これによりアカウントID/ARN をフロントのソースに埋め込まない。
const runtimeArn = StringParameter.valueForStringParameter(
  stack,
  '/nagoya-bus-agent/runtime-arn',
);

// Lambda には環境変数として注入（handler は process.env.AGENTCORE_RUNTIME_ARN を読む）。
// resources.lambda は IFunction のため、環境変数は Amplify のファクトリ経由で追加する。
backend.chatAgent.addEnvironment('AGENTCORE_RUNTIME_ARN', runtimeArn);

lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'bedrock-agentcore:InvokeAgentRuntime',
      'bedrock-agentcore:InvokeAgentRuntimeForUser',
    ],
    resources: [runtimeArn, `${runtimeArn}/runtime-endpoint/*`],
  }),
);

// Use wildcard resource here to avoid self-referential ARN dependencies that can
// create circular references with AppSync resolver resources in the same stack.
lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: ['*'],
  }),
);
