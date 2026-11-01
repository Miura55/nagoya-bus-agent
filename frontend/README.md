# Frontend

Amplify 認証付きで Bedrock Agent Core のランタイムに接続するチャット UI です。ブラウザから直接 runtime を叩かず、Amplify Data の custom mutation 経由で Lambda を呼び出します。

`ChatSession` と `ChatMessage` は Amplify Data に永続化され、ログインユーザーは自分の履歴だけを
読み取れます。メッセージの書き込みはオーケストレーション Lambda に限定しています。過去の会話を
選択すると保存済みの `sessionId` を AgentCore Runtime に渡し、対応する Memory を引き継ぎます。
「会話をリセット」すると、所有者を検証したうえで旧セッションを即座にリセット済みへ遷移させ、
新しい `sessionId` に切り替えます。表示履歴の削除は非同期で実行し、実行中だった古い応答は
セッション世代を検証して保存を拒否するため、リセット前の会話や AgentCore Memory は復活しません。
クリーンアップの状態は墓標に `pending` / `complete` として保存し、GSI の結果整合性を考慮して
複数回の空確認を行います。処理失敗時は Lambda の再試行に加え、後続チャットからも再送します。

会話一覧とメッセージ取得にはそれぞれ `owner / lastMessageAt`、`sessionId / orderKey` の
セカンダリインデックスを使用します。途中で失敗した回答は完了済みとして扱わず、失敗状態と
エラー内容を保存して履歴の再表示時にも明示します。

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
pnpm test
pnpm build
pnpm exec tsc --noEmit -p amplify/tsconfig.json
```

Vite 8 は Node.js 20.19 以上を要求します。Node 18 系では build は失敗します。
