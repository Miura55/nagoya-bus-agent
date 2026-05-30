# CLAUDE.md

名古屋市営バスの運行情報を提供する AI エージェント。Strands Agents 製のエージェントを
AWS Bedrock AgentCore Runtime 上でホストし、React フロントエンドから AppSync 経由で
ストリーミング応答する構成。

## アーキテクチャ

ハイブリッド構成（バックエンド = Python エージェント / フロントエンド = React + Amplify Gen2）。

```
ブラウザ (React/Vite)
  └─ AppSync GraphQL (Amplify Gen2: auth/data)
       ├─ chat mutation ─────────────┐
       └─ onChatChunk subscription ◄─┐│
                                     ││
       chat-agent Lambda ────────────┘│  ← 自己再帰 Invoke(Event) で非同期化
         └─ InvokeAgentRuntime ───────┼─► Bedrock AgentCore Runtime (Python コンテナ)
              ストリーム応答を         │        └─ Strands Agent + Bedrock (Claude Sonnet 4.6)
              publishChunk で配信 ─────┘             └─ nagoya-bus-mcp (MCP/stdio) + ローカルツール
```

ストリーミングの流れ:
1. フロントが `chat` mutation を呼ぶ → Lambda が `runtimeUserId`（Cognito sub）付きで自身を
   `InvocationType: 'Event'` で再 Invoke し、即座に 202 を返す
2. 非同期側の Lambda が AgentCore Runtime を呼び、SSE 風のレスポンスを 1 行ずつパース
3. テキスト delta を `publishChunk` mutation で AppSync に流すと、`onChatChunk` 購読中の
   フロントへリアルタイム配信される（terminal は `done=true`）

## ディレクトリ構成

- `agent/main.py` — エージェント本体。`BedrockAgentCoreApp` のエントリポイント、MCP クライアント
  （`nagoya-bus-mcp` を stdio 起動）、カスタムツール（`get_current_time` / `get_bus_stops_by_location`）
- `stops.csv` — バス停データ（GTFS-JP由来）。`get_bus_stops_by_location` が緯度経度で近傍検索
- `prototype.py` — Streamlit ベースのローカル検証用プロトタイプ
- `frontend/` — React 19 + Vite。`frontend/amplify/` が Amplify Gen2 バックエンド定義
  - `amplify/data/resource.ts` — AppSync スキーマ（chat / publishChunk / onChatChunk / healthCheck）
  - `amplify/functions/chat-agent/` — オーケストレーション Lambda（`handler.ts` / `resource.ts`）
  - `amplify/backend.ts` — Runtime ARN を SSM（`/nagoya-bus-agent/runtime-arn`）から解決して Lambda に注入
  - `amplify/auth/resource.ts` — Cognito（email 認証）
- `infra/` — エージェントの CDK アプリ（TypeScript）。`lib/agent-runtime-stack.ts` が
  AgentCore Runtime / Memory / IAM ロール / ECR(DockerImageAsset) を定義
- `Dockerfile` — エージェントのコンテナ定義（リポジトリルート。CDK の DockerImageAsset が参照）
- `pyproject.toml` / `uv.lock` — Python 依存（uv 管理）

## 主要な技術スタック / 設定値

- Python 3.13、`uv` でパッケージ管理
- エージェントフレームワーク: `strands-agents`、ランタイム: `bedrock-agentcore`（CLI は
  `bedrock-agentcore-starter-toolkit`）
- モデル: `jp.anthropic.claude-sonnet-4-6`（推論プロファイル、temperature 0.7 / max_tokens 4096）
- リージョン: `ap-northeast-1`（東京）固定
- コンテナ: `linux/arm64`、observability（OpenTelemetry / `aws-opentelemetry-distro`）有効
- Memory: `STM_ONLY`、TTL 30日
- フロント: React 19 / Vite 6 / pnpm 8 / Node 20

## 開発・実行

### エージェント（ローカル）
```bash
uv sync
uv run agent/main.py          # localhost:8080 で起動
# 動作確認
curl -X POST -H "Content-Type: application/json" \
  -d '{"prompt": "大須から名古屋駅に向かう系統の時刻を調べてください"}' \
  http://localhost:8080/invocations
```

### デプロイ
```bash
# エージェント（Bedrock AgentCore Runtime / Memory / IAM / ECR を CDK で管理）
cd infra
npm install
npx cdk bootstrap            # 初回のみ
npx cdk deploy               # ローカルで arm64 イメージをビルドし ECR へ push
# → Runtime ARN を SSM /nagoya-bus-agent/runtime-arn に書き出す

# フロントエンドのバックエンド（Amplify Gen2。先に infra をデプロイしておく）
cd frontend
pnpm ampx:sandbox            # 開発サンドボックス
pnpm ampx:deploy             # 本番（pipeline-deploy --branch main）

# フロント本体は amplify.yml に従い Amplify Hosting がビルド（Vite → frontend/dist）
```

CDK は `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`（利用中のAWS認証情報）から環境を解決する。
ソースにアカウントID/ARN は持たない。

### フロントエンド
```bash
cd frontend
pnpm install --frozen-lockfile
pnpm dev                      # 開発サーバー
pnpm build                    # 本番ビルド
pnpm lint                     # ESLint
```

## CI

- `.github/workflows/pnpm-frozen-lockfile.yml` — PR で frontend の pnpm lockfile 整合性を検証
  （Node 20 / pnpm 8）。デプロイの自動化はなく、デプロイは手動 CLI。

## 注意点・規約

- **このリポジトリはパブリック**。AWS アカウントID・ARN・ECR URI 等をソースに新規でハードコード
  しないこと。CDK では `this.account` / `this.region` を使い、フロントは SSM パラメータ
  （`/nagoya-bus-agent/runtime-arn`）経由で Runtime ARN を解決する。
- インフラは CDK（`infra/`、エージェント側）と Amplify Gen2（フロント側）の二系統で管理。
  両者は SSM パラメータ `/nagoya-bus-agent/runtime-arn` で疎結合。Terraform/SAM は使っていない。
  なお過去のコミット履歴にはアカウントIDが残っている（履歴の書き換えはしていない）。
- システムプロンプト・UI 文言・README は日本語。応答も日本語前提。
- バス情報の取得は MCP サーバー（`nagoya-bus-mcp`）のツール経由が原則。時刻表は系統単位で
  テーブル表示するのがエージェントの仕様（`agent/main.py` の `SYSTEM_PROMPT` 参照）。

## 進行中の作業

`feature/migrate-cdk` ブランチで AgentCore CLI から CDK へ移行済み（パブリックリポジトリからの
アカウントID除去が目的）。エージェント（Runtime/Memory/IAM/ECR）は CDK アプリ `infra/` で管理し、
コンテナは `DockerImageAsset`（ARM64）でビルド、Runtime ARN は SSM 経由で Amplify と連携する。
旧 `.bedrock_agentcore.yaml` / `.bedrock_agentcore/` は削除済み。

未実施の運用作業:
- `cd infra && npx cdk deploy` で新 Runtime を作成（旧 CLI 製 Runtime と名前が競合する場合は先に削除）
- Amplify を再デプロイして新 ARN（SSM 経由）に切り替え
- 旧 CLI 製の Runtime / Memory / ECR / CodeBuild / IAM ロールを確認のうえ手動削除
