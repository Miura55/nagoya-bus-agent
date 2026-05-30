import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_bedrockagentcore as agentcore,
  aws_ecr_assets as ecrAssets,
  aws_iam as iam,
  aws_ssm as ssm,
} from 'aws-cdk-lib';

/** AgentCore Runtime / Memory の論理名。CLI 構成と揃えている。 */
const AGENT_RUNTIME_NAME = 'nagoya_bus_agent';
const AGENT_MEMORY_NAME = 'nagoya_bus_agent_mem';

/** フロントエンド(Amplify)が Runtime ARN を読み取る SSM パラメータ名。 */
const RUNTIME_ARN_PARAMETER_NAME = '/nagoya-bus-agent/runtime-arn';

/** リポジトリルート(Dockerfile と agent/ がある場所)。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export class AgentRuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- コンテナイメージ -------------------------------------------------
    // cdk deploy 時にローカルで ARM64 イメージをビルドし、CDK 管理の ECR に push する。
    // ContainerUri は asset から解決するため、アカウントID/ECR URI をソースに書かない。
    const image = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: REPO_ROOT,
      file: 'Dockerfile',
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // --- Memory (STM_ONLY 相当) -------------------------------------------
    // MemoryStrategies を指定しないことで短期記憶のみ(STM_ONLY)になる。
    const memory = new agentcore.CfnMemory(this, 'AgentMemory', {
      name: AGENT_MEMORY_NAME,
      description: 'Short-term memory for the Nagoya Bus Agent',
      eventExpiryDuration: 30, // days
    });

    // --- 実行ロール -------------------------------------------------------
    const role = new iam.Role(this, 'AgentRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
      description: 'Execution role for the Nagoya Bus Agent AgentCore Runtime',
    });

    // ECR からのイメージ pull(GetAuthorizationToken 含む)。
    image.repository.grantPull(role);

    // CloudWatch Logs
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        ],
      }),
    );

    // 可観測性(OpenTelemetry / X-Ray / CloudWatch メトリクス)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' },
        },
      }),
    );

    // Bedrock モデル呼び出し(推論プロファイル jp.anthropic.claude-sonnet-4-6 と
    // それが束ねる各リージョンの基盤モデル)。
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // AgentCore Memory へのアクセス
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:ListSessions',
          'bedrock-agentcore:DeleteEvent',
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:GetMemoryRecord',
          'bedrock-agentcore:ListMemoryRecords',
        ],
        resources: [memory.attrMemoryArn, `${memory.attrMemoryArn}/*`],
      }),
    );

    // Workload identity トークン取得(runtimeUserId 付き呼び出しに必要)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${AGENT_RUNTIME_NAME}-*`,
        ],
      }),
    );

    // --- Runtime ----------------------------------------------------------
    const runtime = new agentcore.CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName: AGENT_RUNTIME_NAME,
      roleArn: role.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: image.imageUri,
        },
      },
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      protocolConfiguration: {
        serverProtocol: 'HTTP',
      }
      environmentVariables: {
        // agent/main.py は BEDROCK_AGENTCORE_MEMORY_ID を読み、CDK 管理の Memory を使う。
        // 旧CLI製 Memory ID を Dockerfile にハードコードしていたが、それは削除した。
        BEDROCK_AGENTCORE_MEMORY_ID: memory.attrMemoryId,
      },
    });
    runtime.node.addDependency(role);

    // --- フロントエンド連携 / 出力 ----------------------------------------
    // Runtime ARN を SSM に書き出し、Amplify 側はこれを参照する(ソースに ARN を書かない)。
    new ssm.StringParameter(this, 'RuntimeArnParameter', {
      parameterName: RUNTIME_ARN_PARAMETER_NAME,
      stringValue: runtime.attrAgentRuntimeArn,
      description: 'Bedrock AgentCore Runtime ARN for the Nagoya Bus Agent',
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN',
    });
    new cdk.CfnOutput(this, 'AgentRuntimeId', {
      value: runtime.attrAgentRuntimeId,
      description: 'AgentCore Runtime ID',
    });
    new cdk.CfnOutput(this, 'AgentMemoryId', {
      value: memory.attrMemoryId,
      description: 'AgentCore Memory ID',
    });
  }
}
