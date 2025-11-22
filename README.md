# Nagoya BUS Agent

名古屋の市バスの運行情報を調べるエージェントです

## Require
- AWS CLI
- uv

## Install

```bash
uv sync
```

## Usage
### AWS認証情報の設定
ローカル上でAWSの認証情報を設定しておきます

```bash
aws configure
```

### エージェントの実行
以下のコマンドでエージェントを実行します

```bash
uv run main.py
```