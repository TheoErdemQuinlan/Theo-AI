# Theo Code

**Sovereign Coding Intelligence** — built by Theodore Quinlan, Newcastle University.

A full coding agent that reads, writes, edits, and debugs your code. Powered by NVIDIA NIM free tier (Qwen3-Coder 480B, Nemotron Ultra 253B, Llama 3.3 70B). No token costs. Runs locally.

## Features

- **Full tool execution**: read files, write files, edit files, run bash, grep, glob, list directories
- **Streaming responses**: see output as it's generated
- **Session memory**: remembers context across turns with rolling window compaction
- **Slash commands**: `/clear`, `/cd`, `/compact`, `/status`, `/help`
- **Multi-line input**: end a line with `\` to continue on the next line
- **NVIDIA NIM routing**: Sonnet tier → Qwen3-Coder 480B, Opus → Nemotron Ultra 253B, Haiku → Llama 3.3 70B

## Installation

```bash
git clone https://github.com/TheoErdemQuinlan/Theo-AI.git
cd Theo-AI
pip install httpx
chmod +x theocode
```

Make sure the NIM proxy is running (see `~/free-claude-code`).

## Usage

```bash
# Interactive REPL
./theocode

# One-shot
./theocode "explain what main.py does"

# From anywhere (add to PATH)
echo 'export PATH="$HOME/Theo-AI:$PATH"' >> ~/.bashrc
source ~/.bashrc
theocode
```

## Architecture

```
theocode (launcher)
  └── src/theocode/
        ├── __main__.py     CLI entry point
        ├── repl.py         Interactive REPL, slash commands, input handling
        ├── agent.py        Core agent loop, streaming, tool orchestration
        └── tools.py        Tool execution: Read, Write, Edit, Bash, Glob, Grep
```

The agent connects to the NIM proxy at `localhost:8082`, which routes requests to NVIDIA's free inference API.

## Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/clear` | Reset conversation history |
| `/cd <path>` | Change working directory |
| `/cwd` | Show current directory |
| `/status` | Show token usage and session stats |
| `/compact` | Summarise and compress history |
| `/exit` | Exit |

---

*Built by Theodore Quinlan · Newcastle University · April 2026*
