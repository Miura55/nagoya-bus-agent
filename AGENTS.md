# AGENTS.md

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
              (requestId + sequence)
```

ストリーミングの流れ:
1. フロントが応答単位の `requestId` を生成し、`sessionId` + `requestId` で `onChatChunk` を購読してから
   `chat` mutation を呼ぶ
2. Lambda が `runtimeUserId`（Cognito sub）と `requestId` 付きで自身を
   `InvocationType: 'Event'` で再 Invoke し、即座に 202 を返す
3. 非同期側の Lambda が AgentCore Runtime を呼び、SSE 風のレスポンスを 1 行ずつパース
4. テキスト delta に 0 始まりの単調増加 `sequence` を付け、`publishChunk` mutation で AppSync に流す。
   publish は一時的な失敗をリトライし、復旧できない場合は後続 delta を正常扱いで配信し続けない
5. フロントはチャンクを `sequence` 順にバッファから取り出して連結する。順不同到着、重複到着、
   複数タブなどからの別リクエストの混在を防ぎ、terminal（`done=true`）も先行 sequence が
   揃ってから処理する

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
  - `src/ordered-chunk-consumer.js` — `sequence` に基づくチャンクの並べ替え・重複排除・terminal 制御
  - `src/ordered-chunk-consumer.test.js` — 順不同、重複、terminal の回帰テスト
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
pnpm test                     # node:test（ストリーミング順序制御など）
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
- ストリーミングでは AppSync のイベント到着順を信用しない。`requestId` で応答を分離し、すべての
  delta と terminal に連続した `sequence` を付ける。フロントは必ず
  `ordered-chunk-consumer.js` を通して適用し、この契約を変更するときは回帰テストも更新する。
- `publishChunk` の失敗を握りつぶして次の sequence へ進めない。欠落したチャンクのまま
  Markdown を完成扱いにしないこと。

## 現在の状態

AgentCore CLI から CDK への移行と旧 CLI 製リソースの整理は完了済み。エージェント
（Runtime/Memory/IAM/ECR）は CDK アプリ `infra/` で管理し、コンテナは
`DockerImageAsset`（ARM64）でビルドする。Runtime ARN は SSM 経由で Amplify と連携し、
旧 `.bedrock_agentcore.yaml` / `.bedrock_agentcore/` は削除済み。

`fix/stream-response` ブランチでは、AppSync ストリーミングに `requestId` / `sequence` を追加し、
フロントの順序保証と重複排除を実装済み。GraphQL スキーマを変更しているため、反映時は Amplify
バックエンドとフロントを同じ変更としてデプロイする。
