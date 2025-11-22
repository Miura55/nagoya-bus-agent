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
uv run main.py
```