"""
Theo Code — Core agent loop.
Handles streaming API calls, tool use, multi-turn conversation,
context management, and session history.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Iterator

import httpx

from .tools import TOOL_SCHEMAS, execute_tool

# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_BASE_URL  = "http://localhost:8082"
DEFAULT_MODEL     = "claude-sonnet-4-5"   # remapped to Qwen3-Coder 480B by proxy
MAX_TOKENS        = 8192
MAX_CONTEXT_TURNS = 40   # rolling window — older turns dropped to save context
TOOL_TIMEOUT      = 60   # seconds

SYSTEM_PROMPT = """You are Theo Code, an expert coding assistant built by Theodore Quinlan.

You have access to tools that let you read, write, and edit files; execute bash commands; search code with grep; find files with glob; and list directories. Use them freely and proactively — don't ask permission to read a file, just read it.

Your approach:
- Read files before modifying them
- Make precise, minimal edits unless a rewrite is clearly better
- Run tests after making changes
- Explain what you did and why, concisely
- If something fails, diagnose the error before retrying
- Never truncate file content you're writing — write it completely

You are running in: {cwd}
"""

# ── Colours ───────────────────────────────────────────────────────────────────

RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
NAVY   = "\033[38;5;25m"
CYAN   = "\033[38;5;51m"
GOLD   = "\033[38;5;220m"
GREEN  = "\033[38;5;82m"
RED    = "\033[38;5;196m"
GRAY   = "\033[38;5;245m"
WHITE  = "\033[97m"


def c(text: str, colour: str) -> str:
    """Wrap text in colour if stdout is a tty."""
    if sys.stdout.isatty():
        return f"{colour}{text}{RESET}"
    return text


# ── Session history ────────────────────────────────────────────────────────────

class Session:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self.messages: list[dict] = []
        self.turn_count = 0
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.start_time = time.time()

    def add(self, role: str, content):
        self.messages.append({"role": role, "content": content})
        # Rolling window: keep last MAX_CONTEXT_TURNS pairs
        if len(self.messages) > MAX_CONTEXT_TURNS * 2:
            self.messages = self.messages[-(MAX_CONTEXT_TURNS * 2):]

    def system(self) -> str:
        return SYSTEM_PROMPT.format(cwd=self.cwd)

    def elapsed(self) -> str:
        s = int(time.time() - self.start_time)
        return f"{s // 60}m{s % 60}s"


# ── API client ────────────────────────────────────────────────────────────────

class TheoCodeClient:
    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.client = httpx.Client(timeout=120.0)

    def stream_response(self, session: Session) -> Iterator[dict]:
        """
        Stream a response from the API. Yields dicts:
          {"type": "text",  "text": str}
          {"type": "tool",  "name": str, "id": str, "input": dict}
          {"type": "usage", "input_tokens": int, "output_tokens": int}
          {"type": "stop",  "reason": str}
          {"type": "error", "message": str}
        """
        payload = {
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "system": session.system(),
            "messages": session.messages,
            "tools": TOOL_SCHEMAS,
            "stream": True,
        }

        try:
            with self.client.stream(
                "POST",
                f"{self.base_url}/v1/messages",
                headers={
                    "x-api-key": "theocode",
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                content=json.dumps(payload),
            ) as response:
                if response.status_code != 200:
                    body = response.read().decode()
                    yield {"type": "error", "message": f"HTTP {response.status_code}: {body}"}
                    return

                # Parse SSE stream
                current_tool_use: dict | None = None
                current_tool_json = ""

                for line in response.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break
                    try:
                        event = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    etype = event.get("type", "")

                    if etype == "content_block_start":
                        block = event.get("content_block", {})
                        if block.get("type") == "tool_use":
                            current_tool_use = {
                                "id": block["id"],
                                "name": block["name"],
                            }
                            current_tool_json = ""

                    elif etype == "content_block_delta":
                        delta = event.get("delta", {})
                        dtype = delta.get("type", "")
                        if dtype == "text_delta":
                            yield {"type": "text", "text": delta.get("text", "")}
                        elif dtype == "input_json_delta":
                            current_tool_json += delta.get("partial_json", "")

                    elif etype == "content_block_stop":
                        if current_tool_use is not None:
                            try:
                                tool_input = json.loads(current_tool_json) if current_tool_json else {}
                            except json.JSONDecodeError:
                                tool_input = {"raw": current_tool_json}
                            current_tool_use["input"] = tool_input
                            yield {"type": "tool", **current_tool_use}
                            current_tool_use = None
                            current_tool_json = ""

                    elif etype == "message_delta":
                        usage = event.get("usage", {})
                        reason = event.get("delta", {}).get("stop_reason", "")
                        if usage:
                            yield {"type": "usage",
                                   "input_tokens": usage.get("input_tokens", 0),
                                   "output_tokens": usage.get("output_tokens", 0)}
                        if reason:
                            yield {"type": "stop", "reason": reason}

                    elif etype == "message_start":
                        usage = event.get("message", {}).get("usage", {})
                        if usage:
                            yield {"type": "usage",
                                   "input_tokens": usage.get("input_tokens", 0),
                                   "output_tokens": usage.get("output_tokens", 0)}

                    elif etype == "error":
                        yield {"type": "error", "message": str(event.get("error", event))}

        except httpx.ConnectError:
            yield {"type": "error",
                   "message": f"Cannot connect to Theo Code server at {self.base_url}.\n"
                               "Run: cd ~/free-claude-code && .venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8082 &"}
        except Exception as e:
            yield {"type": "error", "message": f"Unexpected error: {e}"}


# ── Agent turn ────────────────────────────────────────────────────────────────

def run_turn(client: TheoCodeClient, session: Session, user_input: str) -> None:
    """Run one full agent turn: send message, handle streaming, execute tools."""
    session.add("user", user_input)
    session.turn_count += 1

    while True:
        assistant_text = ""
        tool_calls: list[dict] = []
        assistant_content: list[dict] = []

        print()

        # Stream the response
        for event in client.stream_response(session):
            if event["type"] == "text":
                text = event["text"]
                assistant_text += text
                print(text, end="", flush=True)

            elif event["type"] == "tool":
                tool_calls.append(event)
                if assistant_text:
                    assistant_content.append({"type": "text", "text": assistant_text})
                    assistant_text = ""
                assistant_content.append({
                    "type": "tool_use",
                    "id": event["id"],
                    "name": event["name"],
                    "input": event["input"],
                })

            elif event["type"] == "usage":
                session.total_input_tokens += event.get("input_tokens", 0)
                session.total_output_tokens += event.get("output_tokens", 0)

            elif event["type"] == "error":
                print(f"\n{c('Error: ' + event['message'], RED)}")
                return

        if assistant_text:
            assistant_content.append({"type": "text", "text": assistant_text})

        if assistant_content:
            session.add("assistant", assistant_content)

        # No tool calls — turn complete
        if not tool_calls:
            print()
            _print_status(session)
            return

        # Execute tool calls
        print()
        tool_results = []
        for tool in tool_calls:
            name = tool["name"]
            tool_input = tool["input"]
            tool_id = tool["id"]

            print(c(f"  Tool: {name}", GOLD), end="")
            # Show key input param
            key_param = (tool_input.get("command") or tool_input.get("path") or
                         tool_input.get("pattern") or "")
            if key_param:
                print(c(f"  {key_param[:80]}", GRAY), end="")
            print()

            result = execute_tool(name, tool_input, session.cwd)

            # Show truncated result
            preview = result[:200].replace("\n", " ")
            if len(result) > 200:
                preview += "..."
            print(c(f"  -> {preview}", DIM))

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tool_id,
                "content": result,
            })

        # Feed tool results back for next iteration
        session.add("user", tool_results)


def _print_status(session: Session):
    turns = session.turn_count
    tok_in = session.total_input_tokens
    tok_out = session.total_output_tokens
    elapsed = session.elapsed()
    print(c(f"  [{turns} turns | {tok_in:,} in / {tok_out:,} out tokens | {elapsed}]", DIM))
