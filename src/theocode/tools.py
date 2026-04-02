"""
Theo Code — Tool execution engine.
Provides Read, Write, Edit, Bash, Glob, Grep as real callable tools
with JSON schema definitions for the LLM to call.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import traceback
from pathlib import Path
from typing import Any


# ── Tool definitions (sent to the LLM as tool schemas) ────────────────────────

TOOL_SCHEMAS = [
    {
        "name": "read_file",
        "description": (
            "Read the contents of a file. Returns the file content with line numbers. "
            "Use offset and limit to read specific sections of large files."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute or relative file path"},
                "offset": {"type": "integer", "description": "Line number to start from (1-based)", "default": 1},
                "limit": {"type": "integer", "description": "Maximum number of lines to read", "default": 2000},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file, creating it if it doesn't exist. Overwrites existing content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to write to"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": (
            "Replace a specific string in a file with new content. "
            "old_string must exactly match what is in the file. "
            "Use read_file first to get the exact content."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to edit"},
                "old_string": {"type": "string", "description": "Exact string to replace"},
                "new_string": {"type": "string", "description": "Replacement string"},
                "replace_all": {"type": "boolean", "description": "Replace all occurrences", "default": False},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    {
        "name": "bash",
        "description": (
            "Execute a bash command and return stdout and stderr. "
            "Use for running tests, installing packages, git commands, etc. "
            "Commands time out after 30 seconds by default."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Bash command to execute"},
                "timeout": {"type": "integer", "description": "Timeout in seconds", "default": 30},
                "cwd": {"type": "string", "description": "Working directory for the command"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "glob",
        "description": "Find files matching a glob pattern. Returns matching file paths sorted by modification time.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern, e.g. '**/*.py' or 'src/*.ts'"},
                "path": {"type": "string", "description": "Directory to search in (defaults to cwd)"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "grep",
        "description": "Search file contents for a regex pattern. Returns matching lines with file and line number.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search for"},
                "path": {"type": "string", "description": "File or directory to search"},
                "glob": {"type": "string", "description": "File glob filter, e.g. '*.py'"},
                "case_insensitive": {"type": "boolean", "default": False},
                "context": {"type": "integer", "description": "Lines of context around match", "default": 0},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "list_dir",
        "description": "List directory contents with file sizes and types.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path (defaults to cwd)"},
            },
            "required": [],
        },
    },
]


# ── Tool execution ─────────────────────────────────────────────────────────────

def execute_tool(name: str, inputs: dict[str, Any], cwd: str) -> str:
    """Dispatch and execute a tool call. Returns string output."""
    try:
        if name == "read_file":
            return _read_file(inputs, cwd)
        elif name == "write_file":
            return _write_file(inputs, cwd)
        elif name == "edit_file":
            return _edit_file(inputs, cwd)
        elif name == "bash":
            return _bash(inputs, cwd)
        elif name == "glob":
            return _glob(inputs, cwd)
        elif name == "grep":
            return _grep(inputs, cwd)
        elif name == "list_dir":
            return _list_dir(inputs, cwd)
        else:
            return f"Error: Unknown tool '{name}'"
    except Exception as e:
        return f"Error executing {name}: {e}\n{traceback.format_exc()}"


def _resolve(path: str, cwd: str) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = Path(cwd) / p
    return p.resolve()


def _read_file(inputs: dict, cwd: str) -> str:
    path = _resolve(inputs["path"], cwd)
    if not path.exists():
        return f"Error: File not found: {path}"
    offset = max(1, inputs.get("offset", 1))
    limit = inputs.get("limit", 2000)
    lines = path.read_text(errors="replace").splitlines()
    selected = lines[offset - 1: offset - 1 + limit]
    numbered = "\n".join(f"{offset + i:4d}\t{line}" for i, line in enumerate(selected))
    total = len(lines)
    header = f"File: {path} ({total} lines total, showing {offset}-{min(offset+limit-1, total)})\n"
    return header + numbered


def _write_file(inputs: dict, cwd: str) -> str:
    path = _resolve(inputs["path"], cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(inputs["content"])
    lines = inputs["content"].count("\n") + 1
    return f"Written: {path} ({lines} lines)"


def _edit_file(inputs: dict, cwd: str) -> str:
    path = _resolve(inputs["path"], cwd)
    if not path.exists():
        return f"Error: File not found: {path}"
    content = path.read_text(errors="replace")
    old = inputs["old_string"]
    new = inputs["new_string"]
    replace_all = inputs.get("replace_all", False)
    if old not in content:
        # Show context to help debug
        snippet = content[:500] if len(content) > 500 else content
        return f"Error: old_string not found in {path}.\nFile starts with:\n{snippet}"
    if replace_all:
        new_content = content.replace(old, new)
        count = content.count(old)
    else:
        new_content = content.replace(old, new, 1)
        count = 1
    path.write_text(new_content)
    return f"Edited: {path} ({count} replacement{'s' if count > 1 else ''})"


def _bash(inputs: dict, cwd: str) -> str:
    command = inputs["command"]
    timeout = inputs.get("timeout", 30)
    work_dir = inputs.get("cwd", cwd)
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=work_dir,
        )
        out = result.stdout
        err = result.stderr
        code = result.returncode
        parts = []
        if out:
            parts.append(out.rstrip())
        if err:
            parts.append(f"[stderr]\n{err.rstrip()}")
        parts.append(f"[exit {code}]")
        return "\n".join(parts)
    except subprocess.TimeoutExpired:
        return f"Error: Command timed out after {timeout}s"


def _glob(inputs: dict, cwd: str) -> str:
    pattern = inputs["pattern"]
    search_dir = _resolve(inputs.get("path", cwd), cwd)
    if not search_dir.is_dir():
        return f"Error: Not a directory: {search_dir}"
    matches = sorted(search_dir.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    if not matches:
        return f"No files matching '{pattern}' in {search_dir}"
    lines = [str(m.relative_to(search_dir)) for m in matches[:200]]
    result = "\n".join(lines)
    if len(matches) > 200:
        result += f"\n... and {len(matches) - 200} more"
    return result


def _grep(inputs: dict, cwd: str) -> str:
    pattern = inputs["pattern"]
    path = inputs.get("path", cwd)
    glob_filter = inputs.get("glob", "*")
    case_insensitive = inputs.get("case_insensitive", False)
    context_lines = inputs.get("context", 0)

    flags = re.IGNORECASE if case_insensitive else 0
    try:
        regex = re.compile(pattern, flags)
    except re.error as e:
        return f"Error: Invalid regex: {e}"

    search_path = _resolve(path, cwd)
    results = []

    def search_file(fp: Path):
        try:
            lines = fp.read_text(errors="replace").splitlines()
            for i, line in enumerate(lines):
                if regex.search(line):
                    rel = str(fp.relative_to(search_path.parent if search_path.is_file() else search_path))
                    if context_lines:
                        ctx_start = max(0, i - context_lines)
                        ctx_end = min(len(lines), i + context_lines + 1)
                        for j in range(ctx_start, ctx_end):
                            marker = ">" if j == i else " "
                            results.append(f"{rel}:{j+1}{marker} {lines[j]}")
                    else:
                        results.append(f"{rel}:{i+1}: {line}")
        except Exception:
            pass

    if search_path.is_file():
        search_file(search_path)
    elif search_path.is_dir():
        for fp in search_path.rglob(glob_filter):
            if fp.is_file():
                search_file(fp)
            if len(results) > 500:
                break

    if not results:
        return f"No matches for '{pattern}'"
    output = "\n".join(results[:500])
    if len(results) > 500:
        output += f"\n... truncated at 500 matches"
    return output


def _list_dir(inputs: dict, cwd: str) -> str:
    path = _resolve(inputs.get("path", cwd), cwd)
    if not path.exists():
        return f"Error: Path not found: {path}"
    if path.is_file():
        stat = path.stat()
        return f"{path} ({stat.st_size} bytes)"
    entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name))
    lines = []
    for e in entries[:200]:
        if e.is_dir():
            lines.append(f"  {e.name}/")
        else:
            size = e.stat().st_size
            size_str = f"{size:,}" if size < 1_000_000 else f"{size/1_000_000:.1f}M"
            lines.append(f"  {e.name} ({size_str} bytes)")
    if len(entries) > 200:
        lines.append(f"  ... and {len(entries) - 200} more")
    return f"{path}:\n" + "\n".join(lines)
