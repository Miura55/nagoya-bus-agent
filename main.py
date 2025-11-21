from mcp import stdio_client, StdioServerParameters
from strands import Agent, tool
from strands.tools.mcp import MCPClient
from datetime import datetime
from zoneinfo import ZoneInfo


SYSTEM_PROMPT = """
あなたは名古屋の市営バスについての情報を提供するエージェントです。
以下の要件を満たしてください。
- ユーザーが入力した内容に対して、名古屋の市営バスについての情報を提供してください。
- 出てきた返答を元に該当する系統の時刻表をテーブル形式で表示してください。
- 時刻表には該当する系統の時刻表が存在しない場合は「該当する系統の時刻表が存在しません。」と表示してください。
- 現在時刻を取得するために、get_current_time()を使用してください。
"""

mcp_client = MCPClient(lambda:stdio_client(
        StdioServerParameters(
            command="uvx",
            args=["nagoya-bus-mcp"]
        )
    ),
)


@tool
def get_current_time():
    return datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d %H:%M:%S")


with mcp_client:
    # Get the tools from the MCP server
    tools = mcp_client.list_tools_sync() + [get_current_time]

    # Create the agent
    agent = Agent(
        tools=tools,
        system_prompt=SYSTEM_PROMPT
    )
    # Run the agent
    prompt = input("Enter a prompt: ")
    result = agent(prompt)
