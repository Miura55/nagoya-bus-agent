FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
WORKDIR /app

ENV UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_PROGRESS=1 \
    PYTHONUNBUFFERED=1 \
    DOCKER_CONTAINER=1 \
    AWS_REGION=ap-northeast-1 \
    AWS_DEFAULT_REGION=ap-northeast-1 \
    BEDROCK_AGENTCORE_MEMORY_ID=nagoya_bus_agent_mem-RuR7TxH05s

COPY . .

RUN uv pip install . && \
    uv pip install aws-opentelemetry-distro==0.12.2

# 非rootユーザー作成 + /appの所有権を付与
RUN useradd -m -u 1000 bedrock_agentcore && \
    chown -R bedrock_agentcore:bedrock_agentcore /app

USER bedrock_agentcore

EXPOSE 9000
EXPOSE 8000
EXPOSE 8080

CMD ["opentelemetry-instrument", "python", "-m", "agent.main"]
