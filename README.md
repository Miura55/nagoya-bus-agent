# Nagoya BUS Agent

名古屋の市バスの運行情報を調べるエージェントです

## Require
- AWS CLI
- uv
- Node.js 20+ / npm（インフラの CDK デプロイ用）
- Docker（`buildx` による linux/arm64 ビルドに対応していること）

## Install

```bash
uv sync
```

## Usage
### AWS認証情報の設定
ローカル上でAWSの認証情報を設定しておきます

- オプション1：AWS Configureの実行

```bash
aws configure
```

- オプション2：AWS Loginの実行

```bash
aws login
```

- オプション3：環境変数の設定

```bash
export AWS_ACCESS_KEY_ID=your_access_key_id
export AWS_SECRET_ACCESS_KEY=your_secret_access_key
export AWS_DEFAULT_REGION=your_aws_region
```

### エージェントの実行
以下のコマンドでエージェントを実行します

```bash
uv run agent/main.py
```

上記を起動したら以下のCurlコマンドを実行すると出力を確認できる

```bash
 curl -X POST \
	 -H "Content-Type: application/json" \
	 -d '{"prompt": "大須から名古屋駅に向かう系統の時刻を調べてください"}' \
	 http://localhost:8080/invocations
```

### エージェントのデプロイ（CDK）
エージェント（Bedrock AgentCore Runtime / Memory / IAM ロール / ECR）は CDK アプリ
（`infra/`）で管理する。アカウントID・リージョンはソースに埋め込まず、デプロイ実行時の
AWS 認証情報（`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`）から解決される。

```bash
cd infra
npm install

# 初回のみ: 対象アカウント/リージョンを CDK bootstrap
npx cdk bootstrap

# デプロイ（ローカルで linux/arm64 のコンテナイメージをビルドして ECR へ push）
npx cdk deploy
```

デプロイすると Runtime ARN が SSM パラメータ `/nagoya-bus-agent/runtime-arn` に書き出され、
フロントエンド（Amplify）はこれを参照する。`CfnOutput` でも ARN / Runtime ID / Memory ID を出力する。

> **NOTE:** 旧 AgentCore CLI（`.bedrock_agentcore.yaml`）で作成済みの Runtime と Runtime 名
> （`nagoya_bus_agent`）が競合する場合は、旧 Runtime を削除してから `cdk deploy` すること。

### フロントエンドのバックエンドのデプロイ
Runtime ARN は SSM 経由で解決されるため、先に `infra` をデプロイしておくこと。

```bash
cd frontend
pnpm ampx:sandbox   # 開発サンドボックス
pnpm ampx:deploy    # 本番（pipeline-deploy --branch main）
```

## 使用データ
バス停データは以下のURLから取得しています
- [【名古屋市】市バスGTFS-JPデータ](https://data.bodik.jp/dataset/231002_7109030000_bus-gtfs-jp)

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
