"""
Theo Code — Interactive REPL.
Handles user input, slash commands, multi-line input, history persistence.
"""
from __future__ import annotations

import os
import sys
import readline
import atexit
from pathlib import Path

from .agent import Session, TheoCodeClient, run_turn, c, NAVY, GOLD, CYAN, GRAY, DIM, RESET, BOLD, GREEN, RED, WHITE


# ── History ────────────────────────────────────────────────────────────────────

HISTORY_FILE = Path.home() / ".theocode_history"

def setup_readline():
    if HISTORY_FILE.exists():
        try:
            readline.read_history_file(HISTORY_FILE)
        except Exception:
            pass
    readline.set_history_length(2000)
    atexit.register(lambda: readline.write_history_file(HISTORY_FILE))


# ── Splash screen ─────────────────────────────────────────────────────────────

SPLASH = r"""
  ████████╗██╗  ██╗███████╗ ██████╗      ██████╗ ██████╗ ██████╗ ███████╗
     ██╔══╝██║  ██║██╔════╝██╔═══██╗    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
     ██║   ███████║█████╗  ██║   ██║    ██║     ██║   ██║██║  ██║█████╗
     ██║   ██╔══██║██╔══╝  ██║   ██║    ██║     ██║   ██║██║  ██║██╔══╝
     ██║   ██║  ██║███████╗╚██████╔╝    ╚██████╗╚██████╔╝██████╔╝███████╗
     ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝      ╚═════╝ ╚═════╝╚═════╝ ╚══════╝
"""


def print_splash(base_url: str, model: str, cwd: str):
    if not sys.stdout.isatty():
        return
    print(f"\033[38;5;25m\033[1m{SPLASH}\033[0m")
    print(f"\033[38;5;220m\033[1m              Sovereign Coding Intelligence\033[0m")
    print(f"\033[38;5;245m              Built by Theodore Quinlan · Newcastle University\033[0m")
    print()
    print(f"\033[2m  ─────────────────────────────────────────────────────\033[0m")
    print(f"\033[38;5;51m  Model  \033[0m\033[97mQwen3-Coder 480B  (via NVIDIA NIM)\033[0m")
    print(f"\033[38;5;51m  Deep   \033[0m\033[97mNemotron Ultra 253B\033[0m")
    print(f"\033[38;5;51m  Fast   \033[0m\033[97mLlama 3.3 70B\033[0m")
    print(f"\033[38;5;51m  Proxy  \033[0m\033[97m{base_url}\033[0m")
    print(f"\033[38;5;51m  Dir    \033[0m\033[97m{cwd}\033[0m")
    print(f"\033[2m  ─────────────────────────────────────────────────────\033[0m")
    print()
    print(f"\033[38;5;245m  Type your request. /help for commands. Ctrl+C to exit.\033[0m")
    print()


# ── Slash commands ─────────────────────────────────────────────────────────────

def handle_slash(cmd: str, session: Session, client: TheoCodeClient) -> bool:
    """Handle slash commands. Returns True if handled, False otherwise."""
    cmd = cmd.strip()

    if cmd in ("/help", "/h"):
        print(f"""
{c('Theo Code — Commands', GOLD)}

  {c('/help', CYAN)}          Show this help
  {c('/clear', CYAN)}         Clear conversation history (start fresh)
  {c('/cd <path>', CYAN)}     Change working directory
  {c('/cwd', CYAN)}           Show current working directory
  {c('/status', CYAN)}        Show session stats (tokens, turns, time)
  {c('/model', CYAN)}         Show current model
  {c('/compact', CYAN)}       Summarise and compress conversation history
  {c('/exit', CYAN)}          Exit Theo Code

{c('Tips:', GOLD)}
  - Theo Code can read, write, and edit files automatically
  - It runs bash commands to test and build your code
  - Use natural language: "add error handling to main.py"
  - It remembers context across turns in this session
""")
        return True

    elif cmd in ("/clear", "/reset"):
        session.messages.clear()
        session.turn_count = 0
        print(c("  History cleared.", GREEN))
        return True

    elif cmd.startswith("/cd "):
        new_dir = cmd[4:].strip()
        new_path = Path(new_dir).expanduser()
        if not new_path.is_absolute():
            new_path = Path(session.cwd) / new_path
        new_path = new_path.resolve()
        if new_path.is_dir():
            session.cwd = str(new_path)
            os.chdir(new_path)
            print(c(f"  Working directory: {session.cwd}", GREEN))
        else:
            print(c(f"  Error: not a directory: {new_path}", RED))
        return True

    elif cmd == "/cwd":
        print(c(f"  {session.cwd}", CYAN))
        return True

    elif cmd == "/status":
        print(f"""
{c('Session Status', GOLD)}
  Turns:          {session.turn_count}
  Input tokens:   {session.total_input_tokens:,}
  Output tokens:  {session.total_output_tokens:,}
  Elapsed:        {session.elapsed()}
  Working dir:    {session.cwd}
  History msgs:   {len(session.messages)}
""")
        return True

    elif cmd == "/model":
        print(c(f"  Model: {client.model} -> routed to Qwen3-Coder 480B via NIM proxy", CYAN))
        return True

    elif cmd == "/compact":
        if not session.messages:
            print(c("  Nothing to compact.", GRAY))
            return True
        # Ask the model to summarise the conversation
        history_text = "\n".join(
            f"{m['role'].upper()}: {m['content'] if isinstance(m['content'], str) else '[tool use]'}"
            for m in session.messages[-20:]
        )
        summary_prompt = (
            f"Summarise the following conversation into a concise context paragraph "
            f"that preserves all important technical decisions, file paths, and code state:\n\n{history_text}"
        )
        old_messages = session.messages.copy()
        session.messages = []
        run_turn(client, session, summary_prompt)
        # Keep only the summary
        if session.messages:
            summary = session.messages[-1]
            session.messages = [
                {"role": "user", "content": "Previous conversation summary:"},
                summary,
            ]
        print(c(f"  Compacted {len(old_messages)} messages to summary.", GREEN))
        return True

    elif cmd in ("/exit", "/quit", "/q"):
        raise KeyboardInterrupt

    return False


# ── Multi-line input ───────────────────────────────────────────────────────────

def get_input(prompt: str) -> str:
    """Get user input, supporting multi-line with trailing backslash."""
    lines = []
    first = True
    while True:
        try:
            p = prompt if first else "... "
            line = input(p)
            first = False
            if line.endswith("\\"):
                lines.append(line[:-1])
            else:
                lines.append(line)
                break
        except EOFError:
            if lines:
                break
            raise
    return "\n".join(lines)


# ── Main REPL loop ─────────────────────────────────────────────────────────────

def run_repl(
    base_url: str = "http://localhost:8082",
    model: str = "claude-sonnet-4-5",
    cwd: str | None = None,
    prompt_arg: str | None = None,
):
    """Start the interactive Theo Code REPL."""
    if cwd is None:
        cwd = os.getcwd()

    setup_readline()

    session = Session(cwd=cwd)
    client = TheoCodeClient(base_url=base_url, model=model)

    print_splash(base_url, model, cwd)

    # Non-interactive: run single prompt and exit
    if prompt_arg:
        run_turn(client, session, prompt_arg)
        return

    prompt_str = c("theo> ", NAVY + BOLD) if sys.stdout.isatty() else "theo> "

    while True:
        try:
            user_input = get_input(prompt_str).strip()
        except KeyboardInterrupt:
            print(f"\n{c('  Goodbye.', GRAY)}")
            break
        except EOFError:
            print(f"\n{c('  Goodbye.', GRAY)}")
            break

        if not user_input:
            continue

        if user_input.startswith("/"):
            try:
                handle_slash(user_input, session, client)
            except KeyboardInterrupt:
                print(f"\n{c('  Goodbye.', GRAY)}")
                break
            continue

        try:
            run_turn(client, session, user_input)
        except KeyboardInterrupt:
            print(f"\n{c('  Interrupted.', GOLD)}")
            continue
