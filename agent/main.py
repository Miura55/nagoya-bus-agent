"""
名古屋の市バスの運行情報を提供するエージェントです
"""
import os
import logging
from datetime import datetime
from zoneinfo import ZoneInfo
import pandas as pd
from mcp import stdio_client, StdioServerParameters
from strands import Agent, tool
from strands.tools.mcp import MCPClient
from bedrock_agentcore.runtime import BedrockAgentCoreApp


LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger("strands")

app = BedrockAgentCoreApp()

SYSTEM_PROMPT = """
あなたは名古屋の市営バスについての情報を提供するエージェントです。
以下の要件を満たしてください。
- ユーザーが入力した内容に対して、名古屋の市バスについての情報を提供してください。
- 出てきた返答を元に該当する系統の時刻表をテーブル形式で表示してください。カラムは `時`, `平日`, `土曜`, `日曜・休日` とします。
- 行き先が指定された場合、その行き先に向かう系統の時刻表、及びその乗り場の位置情報を提供してください。
- 時刻表に該当する系統の時刻表が存在しない場合は「該当する系統の時刻表が存在しません。」と表示してください。
- ユーザーが現在地を提供した場合、最寄りのバス停を特定し、そのバス停に関する情報を提供してください。
- ユーザーが特定のバス停に関する情報を求めた場合、そのバス停に関する情報を提供してください。
"""

mcp_client = MCPClient(lambda:stdio_client(
        StdioServerParameters(
            command="nagoya-bus-mcp",
            args=[]
        )
    )
)


@tool
def get_current_time():
    return datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d %H:%M:%S")


@tool
def get_bus_stops(lon: float, lat: float) -> list[dict]:
    """    Get bus stops near the given longitude and latitude.

    Args:
        lon (float): _longitude_
        lat (float): _latitude_

    Returns:
        list[dict]: List of bus stops with stop_id, stop_name, stop_lon, stop_lat
    """
    df = pd.read_csv("stops.csv")
    # Calculate distance and filter stops within a certain radius (e.g., 0.01 degrees)
    df['distance'] = ((df['stop_lon'] - lon) ** 2 + (df['stop_lat'] - lat) ** 2) ** 0.5
    nearby_stops = df[df['distance'] < 0.01]
    return nearby_stops[['stop_id', 'stop_name', 'stop_lon', 'stop_lat']].to_dict(orient='records')


@app.entrypoint
async def entrypoint(payload):
    """アプリケーションのエンドポイント

    Args:
        payload: クライアントからの入力
    """
    logger.info("Received payload: %s", payload)
    user_prompt = payload.get("prompt", "")

    with mcp_client:
        # Get the tools from the MCP server
        tools = mcp_client.list_tools_sync() + [get_current_time, get_bus_stops]

        # Create the agent
        agent = Agent(
            tools=tools,
            system_prompt=SYSTEM_PROMPT
        )

        # Run Agent
        stream_messages= agent.stream_async(user_prompt)
        async for message in stream_messages:
            if "event" in message:
                yield message


if __name__ == "__main__":
    app.run()
