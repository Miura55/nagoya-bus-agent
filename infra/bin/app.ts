#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentRuntimeStack } from '../lib/agent-runtime-stack';

const app = new cdk.App();

// アカウントID・リージョンはソースに埋め込まず、デプロイ実行環境の
// CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION（= 利用中のAWS認証情報）から解決する。
// リージョンは既存構成に合わせ ap-northeast-1 を既定にする。
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

new AgentRuntimeStack(app, 'NagoyaBusAgentStack', {
  env,
  description: 'Nagoya Bus Agent hosted on Bedrock AgentCore Runtime',
});
