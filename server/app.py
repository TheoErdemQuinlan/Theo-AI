"""
Theo Code Web Server
Streams AI responses and executes tools, served as SSE to the React UI.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent.parent))

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import httpx

from src.theocode.tools import TOOL_SCHEMAS, execute_tool

app = FastAPI(title="Theo Code", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PROXY_URL = os.environ.get("ANTHROPIC_BASE_URL", "http://localhost:8082")
MODEL = "claude-sonnet-4-5"
MAX_TOKENS = 8192

SYSTEM_PROMPT = """You are Theo Code, an expert coding assistant built by Theodore Quinlan, PhD researcher at Newcastle University.

You have access to tools that let you read, write, and edit files; execute bash commands; search code with grep; find files with glob; and list directories. Use them freely — don't ask permission to read a file, just read it.

Your approach:
- Read files before modifying them
- Make precise, minimal edits unless a rewrite is clearly better
- Run tests after making changes
- Explain what you did concisely
- Never truncate file content you're writing

Working directory: {cwd}
"""

# In-memory sessions keyed by session_id
sessions: dict[str, dict] = {}


@app.get("/api/health")
async def health():
    # Check NIM proxy
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{PROXY_URL}/health")
            proxy_ok = r.status_code == 200
    except Exception:
        proxy_ok = False
    return {"status": "ok", "proxy": proxy_ok, "proxy_url": PROXY_URL}


@app.post("/api/session")
async def create_session(req: Request):
    body = await req.json()
    cwd = body.get("cwd", os.getcwd())
    session_id = body.get("session_id", __import__('uuid').uuid4().hex)
    sessions[session_id] = {"messages": [], "cwd": cwd}
    return {"session_id": session_id, "cwd": cwd}


@app.post("/api/session/{session_id}/clear")
async def clear_session(session_id: str):
    if session_id in sessions:
        sessions[session_id]["messages"] = []
    return {"ok": True}


@app.post("/api/session/{session_id}/cwd")
async def set_cwd(session_id: str, req: Request):
    body = await req.json()
    cwd = body.get("cwd", os.getcwd())
    if Path(cwd).is_dir():
        if session_id not in sessions:
            sessions[session_id] = {"messages": [], "cwd": cwd}
        sessions[session_id]["cwd"] = cwd
        return {"ok": True, "cwd": cwd}
    return JSONResponse({"error": f"Not a directory: {cwd}"}, status_code=400)


@app.post("/api/chat/{session_id}")
async def chat(session_id: str, req: Request):
    body = await req.json()
    user_message = body.get("message", "")

    if session_id not in sessions:
        sessions[session_id] = {"messages": [], "cwd": os.getcwd()}

    session = sessions[session_id]
    session["messages"].append({"role": "user", "content": user_message})

    # Keep rolling window
    if len(session["messages"]) > 80:
        session["messages"] = session["messages"][-80:]

    async def event_stream():
        cwd = session["cwd"]
        messages = session["messages"]

        async with httpx.AsyncClient(timeout=120.0) as client:
            payload = {
                "model": MODEL,
                "max_tokens": MAX_TOKENS,
                "system": SYSTEM_PROMPT.format(cwd=cwd),
                "messages": messages,
                "tools": TOOL_SCHEMAS,
                "stream": True,
            }

            assistant_content = []
            assistant_text = ""
            current_tool = None
            current_tool_json = ""
            tool_calls_this_turn = []

            try:
                async with client.stream(
                    "POST",
                    f"{PROXY_URL}/v1/messages",
                    headers={
                        "x-api-key": "theocode",
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    content=json.dumps(payload),
                ) as response:

                    if response.status_code != 200:
                        body_bytes = await response.aread()
                        err = body_bytes.decode()
                        yield f"data: {json.dumps({'type': 'error', 'message': f'Proxy error {response.status_code}: {err}'})}\n\n"
                        return

                    async for line in response.aiter_lines():
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
                                current_tool = {"id": block["id"], "name": block["name"]}
                                current_tool_json = ""

                        elif etype == "content_block_delta":
                            delta = event.get("delta", {})
                            dtype = delta.get("type", "")
                            if dtype == "text_delta":
                                text = delta.get("text", "")
                                assistant_text += text
                                yield f"data: {json.dumps({'type': 'text', 'text': text})}\n\n"
                            elif dtype == "input_json_delta":
                                current_tool_json += delta.get("partial_json", "")

                        elif etype == "content_block_stop":
                            if current_tool is not None:
                                try:
                                    tool_input = json.loads(current_tool_json) if current_tool_json else {}
                                except json.JSONDecodeError:
                                    tool_input = {}
                                current_tool["input"] = tool_input
                                tool_calls_this_turn.append(current_tool.copy())

                                if assistant_text:
                                    assistant_content.append({"type": "text", "text": assistant_text})
                                    assistant_text = ""
                                assistant_content.append({
                                    "type": "tool_use",
                                    "id": current_tool["id"],
                                    "name": current_tool["name"],
                                    "input": tool_input,
                                })

                                # Notify UI tool is being called
                                yield f"data: {json.dumps({'type': 'tool_call', 'name': current_tool['name'], 'input': tool_input})}\n\n"

                                # Execute tool
                                result = execute_tool(current_tool["name"], tool_input, cwd)

                                yield f"data: {json.dumps({'type': 'tool_result', 'name': current_tool['name'], 'result': result[:2000]})}\n\n"

                                current_tool = None
                                current_tool_json = ""

                        elif etype == "message_delta":
                            usage = event.get("usage", {})
                            reason = event.get("delta", {}).get("stop_reason", "")
                            if usage:
                                yield f"data: {json.dumps({'type': 'usage', 'input_tokens': usage.get('input_tokens',0), 'output_tokens': usage.get('output_tokens',0)})}\n\n"

                    # Save assistant turn
                    if assistant_text:
                        assistant_content.append({"type": "text", "text": assistant_text})

                    if assistant_content:
                        session["messages"].append({"role": "assistant", "content": assistant_content})

                    # If there were tool calls, feed results back
                    if tool_calls_this_turn:
                        tool_results = []
                        for tc in tool_calls_this_turn:
                            result = execute_tool(tc["name"], tc["input"], cwd)
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": tc["id"],
                                "content": result,
                            })
                        session["messages"].append({"role": "user", "content": tool_results})

                yield f"data: {json.dumps({'type': 'done'})}\n\n"

            except httpx.ConnectError:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Cannot connect to NIM proxy at ' + PROXY_URL + '. Start it first.'})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# Serve React build
ui_build = Path(__file__).parent.parent / "ui" / "dist"
if ui_build.exists():
    app.mount("/assets", StaticFiles(directory=str(ui_build / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        return FileResponse(str(ui_build / "index.html"))
