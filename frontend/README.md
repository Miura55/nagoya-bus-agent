# Frontend

Amplify 認証付きで Bedrock Agent Core のランタイムに接続するチャット UI です。ブラウザから直接 runtime を叩かず、Amplify Data の custom mutation 経由で Lambda を呼び出します。

## Prerequisites

- Node.js 20.19 以上
- pnpm
- Amplify 用の AWS 認証

## Setup

```bash
pnpm install
```

## Amplify backend

backend をデプロイして認証・Data API・Lambda を作成します。

```bash
pnpm ampx sandbox
```

または本番環境へデプロイする場合:

```bash
pnpm ampx pipeline-deploy --branch main
```

デプロイ後に生成される amplify_outputs.json を frontend の配信対象に含めてください。

## Run

```bash
pnpm dev
```

## Validate

```bash
pnpm lint
pnpm build
```

Vite 8 は Node.js 20.19 以上を要求します。Node 18 系では build は失敗します。
