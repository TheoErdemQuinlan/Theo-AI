import * as vscode from 'vscode';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';


export function activate(context: vscode.ExtensionContext) {
    const provider = new TheoCodeViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('theocode.chatView', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('theocode.openChat', () => {
            vscode.commands.executeCommand('theocode.chatView.focus');
        }),
        vscode.commands.registerCommand('theocode.clearChat', () => {
            provider.clearChat();
        }),
        vscode.commands.registerCommand('theocode.newSession', () => {
            provider.newSession();
        })
    );
}

export function deactivate() {}


class TheoCodeViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _sessionId: string;

    // Subprocess state
    private _proc: childProcess.ChildProcess | null = null;
    private _procBuf: string = '';

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._sessionId = this._makeId();
    }

    private _makeId(): string {
        return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media')
            ]
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'send':
                    await this._handleChat(msg.text, msg.cwd, msg.attachments);
                    break;
                case 'clear':
                    this.clearChat();
                    break;
                case 'ready':
                    this._sendToWebview({ type: 'init', cwd: this._getCwd(), sessionId: this._sessionId });
                    break;
                case 'checkProxy':
                    await this._checkProxy();
                    break;
                case 'uploadFile':
                    // File content sent from webview as base64 or text
                    this._handleUpload(msg.name, msg.content, msg.isText);
                    break;
            }
        });
    }

    public clearChat() {
        this._sessionId = this._makeId();
        this._killProc();
        this._sendToWebview({ type: 'cleared' });
    }

    public newSession() {
        this.clearChat();
        vscode.window.showInformationMessage('Theo Code: New session started');
    }

    private _killProc() {
        if (this._proc) {
            try { this._proc.kill(); } catch {}
            this._proc = null;
        }
        this._procBuf = '';
    }

    private _getCwd(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (activeFile) {
            return path.dirname(activeFile);
        }
        return process.env.HOME || '/';
    }

    private _getProxyUrl(): string {
        return vscode.workspace.getConfiguration('theocode').get('proxyUrl', 'http://localhost:8082');
    }

    private _getModel(): string {
        return vscode.workspace.getConfiguration('theocode').get('model', 'claude-sonnet-4-5');
    }

    private async _checkProxy(): Promise<void> {
        const proxyUrl = this._getProxyUrl();
        try {
            const ok = await this._httpGet(`${proxyUrl}/health`);
            this._sendToWebview({ type: 'proxyStatus', ok: ok !== null });
        } catch {
            this._sendToWebview({ type: 'proxyStatus', ok: false });
        }
    }

    private _httpGet(url: string): Promise<string | null> {
        return new Promise((resolve) => {
            const lib = url.startsWith('https') ? https : http;
            const req = lib.get(url, { timeout: 3000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    private _sendToWebview(msg: object) {
        this._view?.webview.postMessage(msg);
    }

    private _pendingAttachments: string[] = [];

    private _handleUpload(name: string, content: string, isText: boolean) {
        let preview: string;
        if (isText) {
            preview = `\n\n---\n**Attached file: ${name}**\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\`\n---`;
        } else {
            // content is base64-encoded binary
            preview = extractBinaryAttachment(name, content);
        }
        this._pendingAttachments.push(preview);
        this._sendToWebview({ type: 'attachmentAdded', name });
    }

    private _spawnClaude(cwd: string): childProcess.ChildProcess {
        const model = this._getModel();
        const home = process.env.HOME || '/home/sudo-5034411';
        const theoDir = '/home/sudo-5034411/theo-code-app';
        const proc = childProcess.spawn(
            '/home/sudo-5034411/.local/bin/claude',
            [
                '--print',
                '--output-format=stream-json',
                '--input-format=stream-json',
                '--verbose',
                `--model=${model}`,
                '--dangerously-skip-permissions',
                '--permission-mode=bypassPermissions',
                '--add-dir', '/',
                '--add-dir', home,
                '--add-dir', theoDir,
            ],
            {
                cwd,
                env: {
                    ...process.env,
                    ANTHROPIC_BASE_URL: this._getProxyUrl(),
                    ANTHROPIC_API_KEY: 'theocode',
                    HOME: home,
                    CLAUDE_CODE_ENABLE_UNIFIED_READ_PERMISSION: '1',
                    // Point to Theo's CLAUDE.md so it loads on every session
                    CLAUDERC: `${theoDir}/CLAUDE.md`,
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            }
        );
        return proc;
    }

    private async _handleChat(userText: string, cwd?: string, _attachments?: any) {
        const workDir = cwd || this._getCwd();

        // Append any pending file attachments
        let fullText = userText;
        if (this._pendingAttachments.length > 0) {
            fullText += this._pendingAttachments.join('');
            this._pendingAttachments = [];
            this._sendToWebview({ type: 'attachmentsCleared' });
        }

        this._sendToWebview({ type: 'streamStart' });

        try {
            await this._runClaudeMessage(fullText, workDir);
        } catch (err: any) {
            this._sendToWebview({ type: 'error', message: String(err?.message || err) });
        }

        this._sendToWebview({ type: 'streamEnd' });
    }

    private _runClaudeMessage(text: string, cwd: string): Promise<void> {
        return new Promise((resolve, reject) => {
            // Spawn a fresh process if needed
            if (!this._proc || this._proc.killed || this._proc.exitCode !== null) {
                this._proc = this._spawnClaude(cwd);
                this._procBuf = '';

                // Drain stderr to avoid blocking
                this._proc.stderr?.resume();

                this._proc.on('error', (err) => {
                    reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
                });
            }

            const proc = this._proc!;
            let settled = false;

            const settle = (err?: Error) => {
                if (settled) { return; }
                settled = true;
                // Remove the per-message data listener added below
                proc.stdout?.removeListener('data', onData);
                if (err) { reject(err); } else { resolve(); }
            };

            // Track state to deduplicate streaming events
            let lastTextSent = '';
            const seenToolIds = new Set<string>();
            const seenToolResultIds = new Set<string>();
            const toolIdToName = new Map<string, string>();

            const onData = (chunk: Buffer) => {
                this._procBuf += chunk.toString();
                const lines = this._procBuf.split('\n');
                this._procBuf = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) { continue; }

                    let event: any;
                    try { event = JSON.parse(trimmed); } catch { continue; }

                    const etype: string = event.type || '';
                    const esubtype: string = event.subtype || '';

                    if (etype === 'system' && esubtype === 'init') {
                        this._sendToWebview({
                            type: 'init',
                            cwd,
                            sessionId: event.session_id || this._sessionId,
                        });

                    } else if (etype === 'assistant') {
                        const content: any[] = event.message?.content || [];
                        for (const block of content) {
                            if (block.type === 'text' && block.text) {
                                // CLI sends cumulative text — only send the new delta
                                const fullText: string = block.text;
                                if (fullText.length > lastTextSent.length) {
                                    const delta = fullText.slice(lastTextSent.length);
                                    this._sendToWebview({ type: 'text', text: delta });
                                    lastTextSent = fullText;
                                }
                            } else if (block.type === 'tool_use' && !seenToolIds.has(block.id)) {
                                seenToolIds.add(block.id);
                                toolIdToName.set(block.id, block.name);
                                lastTextSent = ''; // reset text tracking after a tool call
                                this._sendToWebview({
                                    type: 'toolCall',
                                    name: block.name,
                                    input: block.input,
                                });
                            }
                        }

                    } else if (etype === 'user') {
                        // CLI echoes tool results back as user messages
                        const content: any[] = event.message?.content || [];
                        for (const block of content) {
                            if (block.type === 'tool_result' && !seenToolResultIds.has(block.tool_use_id)) {
                                seenToolResultIds.add(block.tool_use_id);
                                lastTextSent = ''; // reset text tracking after tool result
                                // Extract tool output from tool_use_result
                                const tur = event.tool_use_result || {};
                                const resultContent = tur.stdout
                                    || tur.stderr
                                    || (Array.isArray(block.content)
                                        ? block.content.map((c: any) => c.text || c.content || JSON.stringify(c)).join('\n')
                                        : String(block.content || ''));
                                const toolName = toolIdToName.get(block.tool_use_id) || 'tool';
                                this._sendToWebview({
                                    type: 'toolResult',
                                    name: toolName,
                                    result: resultContent.slice(0, 4000),
                                });
                            }
                        }

                    } else if (etype === 'tool') {
                        // Older CLI versions send this
                        const toolId = event.tool_use_id || '';
                        if (!seenToolResultIds.has(toolId)) {
                            seenToolResultIds.add(toolId);
                            this._sendToWebview({
                                type: 'toolResult',
                                name: event.tool_name || '',
                                result: String(event.content || '').slice(0, 4000),
                            });
                        }

                    } else if (etype === 'result') {
                        if (esubtype === 'success') {
                            this._sendToWebview({ type: 'streamEnd' });
                            settle();
                        } else {
                            const errMsg = event.error?.message || event.result || 'Unknown error from claude CLI';
                            this._sendToWebview({ type: 'error', message: errMsg });
                            settle(new Error(errMsg));
                        }

                    } else if (etype === 'error') {
                        const errMsg = event.error?.message || event.message || 'Unknown error';
                        this._sendToWebview({ type: 'error', message: errMsg });
                        settle(new Error(errMsg));
                    }
                }
            };

            proc.stdout?.on('data', onData);

            proc.on('exit', (code) => {
                settle(code !== 0 ? new Error(`claude CLI exited with code ${code}`) : undefined);
            });

            // Write the user message to stdin
            const userMsg = JSON.stringify({
                type: 'user',
                message: {
                    role: 'user',
                    content: [{ type: 'text', text }],
                },
            });

            proc.stdin?.write(userMsg + '\n', (err) => {
                if (err) { settle(new Error(`Failed to write to claude stdin: ${err.message}`)); }
            });
        });
    }

    private _getHtml(_webview: vscode.Webview): string {
        return getWebviewHtml();
    }
}

// ── Binary attachment extraction ──────────────────────────────────────────────

function extractBinaryAttachment(name: string, base64: string): string {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theocode-'));
    const tmpFile = path.join(tmpDir, name);

    try {
        fs.writeFileSync(tmpFile, Buffer.from(base64, 'base64'));

        if (ext === '.zip') {
            return extractZip(name, tmpFile, tmpDir);
        }

        // For other binary types: show file info
        const stat = fs.statSync(tmpFile);
        return `\n\n---\n**Attached binary: ${name}** (${(stat.size / 1024).toFixed(1)} KB, type: ${ext || 'unknown'})\n---`;
    } catch (e: any) {
        return `\n\n---\n**Attached file: ${name}** (failed to process: ${e.message})\n---`;
    } finally {
        // Clean up temp file (not dir — zip extraction needs it briefly above)
        try { fs.unlinkSync(tmpFile); } catch {}
        try { fs.rmdirSync(tmpDir, { recursive: true } as any); } catch {}
    }
}

function extractZip(name: string, zipPath: string, _tmpDir: string): string {
    // List all entries
    const listResult = childProcess.spawnSync('unzip', ['-l', zipPath], {
        encoding: 'utf8', timeout: 15000
    });

    if (listResult.error || listResult.status !== 0) {
        // unzip not available, try python
        const pyList = childProcess.spawnSync('python3', ['-c',
            `import zipfile,sys; z=zipfile.ZipFile('${zipPath}'); [print(i.filename,i.file_size) for i in z.infolist()]`
        ], { encoding: 'utf8', timeout: 10000 });
        if (pyList.status !== 0) {
            return `\n\n---\n**Attached ZIP: ${name}** (could not list contents — unzip or python3 required)\n---`;
        }
    }

    const listing = listResult.stdout || '';
    // Parse file entries from unzip -l output
    const fileEntries: string[] = [];
    for (const line of listing.split('\n')) {
        const m = line.match(/^\s+\d+\s+[\d-]+\s+[\d:]+\s+(.+)$/);
        if (m && !m[1].endsWith('/')) {
            fileEntries.push(m[1].trim());
        }
    }

    const TEXT_EXTS = new Set(['.txt','.md','.py','.js','.ts','.tsx','.jsx','.json',
        '.yaml','.yml','.toml','.ini','.cfg','.conf','.sh','.bash','.html','.css',
        '.scss','.xml','.csv','.log','.env','.rs','.go','.java','.cpp','.c','.h',
        '.rb','.php','.swift','.kt','.r','.sql','.graphql','.proto','.dockerfile',
        '.gitignore','.editorconfig']);

    const MAX_FILE_CHARS = 3000;
    const MAX_TOTAL_CHARS = 20000;
    let output = `\n\n---\n**Attached ZIP: ${name}**\n\n**Contents (${fileEntries.length} files):**\n`;

    // File tree
    const treeLines = listing.split('\n').slice(3, -3);
    output += '```\n' + treeLines.slice(0, 50).join('\n') + '\n```\n\n';

    // Extract text files
    let totalChars = output.length;
    let extracted = 0;

    for (const entry of fileEntries) {
        if (totalChars >= MAX_TOTAL_CHARS) {
            output += `\n_...${fileEntries.length - extracted} more files not shown (limit reached)_\n`;
            break;
        }
        const entryExt = entry.slice(entry.lastIndexOf('.')).toLowerCase();
        if (!TEXT_EXTS.has(entryExt)) { continue; }

        const result = childProcess.spawnSync('unzip', ['-p', zipPath, entry], {
            encoding: 'utf8', timeout: 10000, maxBuffer: 5 * 1024 * 1024
        });
        if (result.status !== 0 || !result.stdout) { continue; }

        const fileContent = result.stdout.slice(0, MAX_FILE_CHARS);
        const truncated = result.stdout.length > MAX_FILE_CHARS ? `\n_...truncated_` : '';
        output += `**${entry}:**\n\`\`\`\n${fileContent}${truncated}\n\`\`\`\n\n`;
        totalChars += output.length;
        extracted++;
    }

    output += '---';
    return output;
}

// ── Webview HTML ──────────────────────────────────────────────────────────────
function getWebviewHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Theo Code</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:var(--vscode-sideBar-background,#0f0f0f);
  --bg2:var(--vscode-editor-background,#141414);
  --bg3:var(--vscode-input-background,#1c1c1c);
  --bg4:#222;
  --border:var(--vscode-panel-border,#2a2a2a);
  --border2:#333;
  --text:var(--vscode-foreground,#e8e8e8);
  --text2:var(--vscode-descriptionForeground,#888);
  --navy:#1a70c0;
  --navy2:#0f4d8a;
  --gold:#c8960c;
  --gold2:#e8b020;
  --green:#22c55e;
  --red:#ef4444;
  --cyan:#22d3ee;
  --font-mono:var(--vscode-editor-font-family,'JetBrains Mono','Fira Code','Consolas',monospace);
  --font-ui:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
  --radius:8px;
  --radius-sm:5px;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:13px;line-height:1.5;overflow:hidden}
::-webkit-scrollbar{width:3px;height:3px}
::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
::-webkit-scrollbar-thumb:hover{background:#444}
.app{display:flex;flex-direction:column;height:100vh;background:var(--bg)}
.hdr{display:flex;align-items:center;gap:8px;padding:0 10px;height:44px;flex-shrink:0;background:var(--bg2);border-bottom:1px solid var(--border)}
.logo{display:flex;align-items:center;gap:7px;flex-shrink:0}
.logo-badge{width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg,var(--navy),var(--navy2));display:flex;align-items:center;justify-content:center;font-weight:900;font-size:10px;color:#fff;font-family:var(--font-mono);letter-spacing:-0.5px;box-shadow:0 1px 4px rgba(0,0,0,0.4)}
.logo-name{font-weight:700;font-size:13px;color:var(--text);letter-spacing:-0.2px}
.hdr-fill{flex:1}
.nim-pill{display:flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:2px 8px;font-size:10px;color:var(--text2)}
.dot{width:6px;height:6px;border-radius:50%;background:#444;flex-shrink:0;transition:background 0.3s}
.dot.on{background:var(--green);box-shadow:0 0 5px var(--green)}
.dot.off{background:var(--red)}
.cwd-bar{padding:5px 10px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg)}
.cwd-pill{display:flex;align-items:center;gap:5px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:3px 8px;cursor:pointer;transition:border-color 0.15s;max-width:100%}
.cwd-pill:hover{border-color:var(--navy)}
.cwd-icon{font-size:11px;flex-shrink:0;opacity:0.7}
.cwd-text{font-size:10.5px;font-family:var(--font-mono);color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.msgs{flex:1;overflow-y:auto;padding:4px 0}
.welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 16px;gap:6px;text-align:center;min-height:200px}
.wlc-icon{width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,var(--navy),var(--navy2));display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:6px;box-shadow:0 4px 16px rgba(26,112,192,0.3)}
.wlc-title{font-size:17px;font-weight:700;color:var(--text);letter-spacing:-0.3px}
.wlc-sub{font-size:11.5px;color:var(--text2)}
.wlc-model{font-size:10.5px;color:var(--navy);font-family:var(--font-mono);margin-top:2px}
.chips{display:flex;flex-direction:column;gap:5px;width:100%;margin-top:14px}
.chip-label{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:2px}
.chip{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px 10px;color:var(--text2);font-size:11.5px;cursor:pointer;text-align:left;transition:all 0.15s}
.chip:hover{border-color:var(--navy);color:var(--text);background:var(--bg4)}
.msg{display:flex;gap:8px;padding:6px 10px;transition:background 0.1s}
.msg:hover{background:rgba(255,255,255,0.015)}
.av{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:700;flex-shrink:0;margin-top:2px}
.av-u{background:var(--navy2);color:#fff}
.av-a{background:var(--bg3);color:var(--gold2);border:1px solid var(--border2)}
.av-e{background:#2d0000;color:var(--red)}
.mb{flex:1;min-width:0;line-height:1.65}
.msg-u .mb{color:var(--text);white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.msg-a .mb{color:var(--text);font-size:12.5px}
.msg-e .mb{color:var(--red);background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.18);border-radius:var(--radius-sm);padding:6px 9px;font-family:var(--font-mono);font-size:11px}
.md p{margin-bottom:7px}
.md p:last-child{margin-bottom:0}
.md code{background:rgba(34,211,238,0.08);color:var(--cyan);padding:1px 5px;border-radius:3px;font-family:var(--font-mono);font-size:11.5px}
.md pre{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;overflow-x:auto;margin:6px 0}
.md pre code{background:none;color:var(--text);padding:0;font-size:11.5px;line-height:1.6}
.md h1,.md h2,.md h3{color:var(--text);margin:10px 0 4px;font-weight:600}
.md h1{font-size:15px}.md h2{font-size:14px}.md h3{font-size:13px}
.md ul,.md ol{padding-left:18px;margin-bottom:6px}
.md li{margin-bottom:2px}
.md table{border-collapse:collapse;width:100%;margin:6px 0;font-size:11.5px}
.md th{background:var(--bg3);padding:5px 8px;border:1px solid var(--border);color:var(--text);font-size:11px}
.md td{padding:4px 8px;border:1px solid var(--border);color:var(--text2)}
.md blockquote{border-left:2px solid var(--navy);padding-left:10px;color:var(--text2);margin:6px 0}
.md a{color:var(--navy)}
.md hr{border:none;border-top:1px solid var(--border);margin:8px 0}
.md strong{font-weight:600}
.md em{font-style:italic}
.blink{display:inline-block;color:var(--navy);animation:blink 1s step-end infinite;font-family:var(--font-mono);font-size:12px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.tool-wrap{margin:3px 0}
.tool-hdr{display:flex;align-items:center;gap:5px;background:var(--bg3);border:1px solid var(--border);border-left:2px solid var(--gold);border-radius:var(--radius-sm);padding:4px 8px;cursor:pointer;font-family:var(--font-mono);font-size:11px;transition:border-color 0.15s;user-select:none}
.tool-hdr:hover{border-color:var(--gold)}
.tool-hdr.result{border-left-color:var(--green)}
.tool-hdr.result:hover{border-color:var(--green)}
.ti{color:var(--gold);font-size:10px}
.ti.ok{color:var(--green)}
.tn{color:var(--gold);font-weight:600;font-size:11px}
.tn.ok{color:var(--green)}
.tp{color:#555;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px}
.tm{color:#444;font-size:10px;flex-shrink:0}
.tv{color:#444;font-size:9px;margin-left:auto;flex-shrink:0}
.tool-body{background:rgba(0,0,0,0.25);border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius-sm) var(--radius-sm);padding:6px 8px;font-family:var(--font-mono);font-size:11px;color:var(--text2);line-height:1.5;overflow-x:auto;white-space:pre;max-height:220px;overflow-y:auto}
.attach-bar{display:flex;flex-wrap:wrap;gap:4px;padding:4px 10px;border-top:1px solid var(--border);background:var(--bg)}
.attach-chip{display:flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;padding:2px 6px;font-size:10.5px;color:var(--text2);font-family:var(--font-mono)}
.attach-rm{background:none;border:none;color:#555;cursor:pointer;font-size:11px;padding:0 1px;line-height:1}
.attach-rm:hover{color:var(--red)}
.bottom{flex-shrink:0;background:var(--bg2);border-top:1px solid var(--border)}
.upload-btn-row{display:flex;align-items:center;gap:6px;padding:6px 10px 0}
.upload-btn{display:flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:3px 8px;color:var(--text2);font-size:11px;cursor:pointer;transition:all 0.15s}
.upload-btn:hover{border-color:var(--navy);color:var(--text)}
#fileInput{display:none}
.inputrow{display:flex;align-items:flex-end;gap:6px;padding:6px 10px 5px}
.ta{flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--radius);padding:8px 10px;color:var(--text);font-size:12.5px;font-family:var(--font-ui);line-height:1.5;resize:none;outline:none;min-height:36px;max-height:160px;overflow-y:auto;transition:border-color 0.15s}
.ta:focus{border-color:var(--navy)}
.ta::placeholder{color:#444}
.ta:disabled{opacity:0.4;cursor:not-allowed}
.sbtn{width:32px;height:32px;border-radius:var(--radius);background:var(--bg3);border:1px solid var(--border2);color:#444;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s}
.sbtn.on{background:var(--navy);border-color:var(--navy);color:#fff}
.sbtn.on:hover{background:#1e80d8}
.sbtn:disabled{opacity:0.3;cursor:not-allowed}
.sbar{display:flex;align-items:center;gap:5px;padding:1px 10px 7px;font-size:10px;color:#444}
.ss{opacity:0.35}.si{color:var(--green)}.ss-stream{color:var(--navy)}.ss-tools{color:var(--gold2)}
.stok{font-family:var(--font-mono)}
</style>
</head>
<body>
<div class="app">
  <div class="hdr">
    <div class="logo">
      <div class="logo-badge">TC</div>
      <span class="logo-name">Theo Code</span>
    </div>
    <div class="hdr-fill"></div>
    <div class="nim-pill">
      <div class="dot" id="dot"></div>
      <span>NIM</span>
    </div>
  </div>
  <div class="cwd-bar">
    <div class="cwd-pill" id="cwdPill" title="Click to change directory">
      <span class="cwd-icon">&#128193;</span>
      <span class="cwd-text" id="cwdText">Loading...</span>
    </div>
  </div>
  <div class="msgs" id="msgs">
    <div class="welcome" id="welcome">
      <div class="wlc-icon">&#9889;</div>
      <div class="wlc-title">Theo Code</div>
      <div class="wlc-sub">Sovereign Coding Intelligence &middot; Theodore Quinlan</div>
      <div class="wlc-model">Qwen3-Coder 480B &middot; Nemotron Ultra 253B &middot; NVIDIA NIM</div>
      <div class="chips" id="chips">
        <div class="chip-label">Try asking</div>
      </div>
    </div>
  </div>
  <div class="bottom">
    <div class="attach-bar" id="attachBar" style="display:none"></div>
    <div class="upload-btn-row">
      <button class="upload-btn" onclick="document.getElementById('fileInput').click()" title="Attach files">
        <span>&#128206;</span>
        <span>Attach file</span>
      </button>
      <input type="file" id="fileInput" multiple accept="*/*">
      <span id="attachCount" style="font-size:10px;color:#555"></span>
    </div>
    <div class="inputrow">
      <textarea class="ta" id="ta" placeholder="Ask Theo Code... (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
      <button class="sbtn" id="sbtn" title="Send">&#8593;</button>
    </div>
    <div class="sbar">
      <span>Qwen3-Coder 480B</span>
      <span class="ss">&middot;</span>
      <span id="ss" class="si">Ready</span>
      <span class="ss" id="tokSep" style="display:none">&middot;</span>
      <span class="stok" id="tok" style="display:none"></span>
    </div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const CHIPS = ['Explain the structure of this project','Find all TODO comments in the codebase','Run the tests and show me the results','What recent git changes have been made?'];
let S = { cwd:'', streaming:false, aiId:null, totalIn:0, totalOut:0, buf:'', attachments:[] };
const msgsEl = document.getElementById('msgs');
const welcomeEl = document.getElementById('welcome');
const taEl = document.getElementById('ta');
const sbtn = document.getElementById('sbtn');
const cwdText = document.getElementById('cwdText');
const cwdPill = document.getElementById('cwdPill');
const dot = document.getElementById('dot');
const ssEl = document.getElementById('ss');
const tokEl = document.getElementById('tok');
const tokSep = document.getElementById('tokSep');
const chipsEl = document.getElementById('chips');
const attachBar = document.getElementById('attachBar');
const fileInput = document.getElementById('fileInput');
const attachCount = document.getElementById('attachCount');
CHIPS.forEach(c => {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = c;
  b.onclick = () => send(c);
  chipsEl.appendChild(b);
});
taEl.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
  sbtn.className = 'sbtn' + (this.value.trim() && !S.streaming ? ' on' : '');
});
taEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!S.streaming) doSend(); }
});
sbtn.onclick = () => { if (!S.streaming) doSend(); };
cwdPill.onclick = () => {
  const v = prompt('Working directory:', S.cwd);
  if (v && v.trim()) { S.cwd = v.trim(); cwdText.textContent = S.cwd; }
};
fileInput.addEventListener('change', async function() {
  for (const file of Array.from(this.files || [])) {
    const isText = isTextFile(file.name);
    try {
      const content = isText ? await readAsText(file) : await readAsBinary(file);
      S.attachments.push({ name: file.name, content, isText });
      vscode.postMessage({ type: 'uploadFile', name: file.name, content, isText });
    } catch(e) { console.error('File read error', e); }
  }
  this.value = ''; renderAttachments();
});
function isTextFile(name) {
  const exts = ['.txt','.md','.py','.js','.ts','.tsx','.jsx','.json','.yaml','.yml','.toml','.ini','.cfg','.conf','.sh','.bash','.zsh','.fish','.html','.css','.scss','.xml','.csv','.log','.env','.rs','.go','.java','.cpp','.c','.h','.rb','.php','.swift','.kt','.r','.sql','.graphql','.proto'];
  return exts.includes(name.slice(name.lastIndexOf('.')).toLowerCase());
}
function readAsText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
}
function readAsBinary(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      // Convert ArrayBuffer to base64 so the extension host can decode it
      const bytes = new Uint8Array(r.result);
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      res(btoa(bin));
    };
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}
function renderAttachments() {
  attachBar.innerHTML = '';
  if (!S.attachments.length) { attachBar.style.display = 'none'; attachCount.textContent = ''; return; }
  attachBar.style.display = 'flex';
  attachCount.textContent = S.attachments.length + ' file' + (S.attachments.length > 1 ? 's' : '') + ' attached';
  S.attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.innerHTML = '<span>&#128196; ' + esc(a.name) + '</span><button class="attach-rm" title="Remove">&#x2715;</button>';
    chip.querySelector('.attach-rm').onclick = () => { S.attachments.splice(i,1); renderAttachments(); };
    attachBar.appendChild(chip);
  });
}
function doSend() {
  const v = taEl.value.trim(); if (!v) return;
  send(v); taEl.value = ''; taEl.style.height = 'auto'; sbtn.className = 'sbtn';
}
function send(text) {
  if (S.streaming) return;
  addUserMsg(text); startAiMsg(); setStatus('streaming');
  const attachments = [...S.attachments]; S.attachments = []; renderAttachments();
  vscode.postMessage({ type: 'send', text, cwd: S.cwd, attachments });
}
function setStatus(s) {
  S.streaming = s !== 'idle'; taEl.disabled = S.streaming; sbtn.disabled = S.streaming;
  if (s === 'idle') { ssEl.className = 'si'; ssEl.textContent = 'Ready'; }
  else if (s === 'streaming') { ssEl.className = 'ss-stream'; ssEl.textContent = 'Thinking...'; }
  else if (s === 'tools') { ssEl.className = 'ss-tools'; ssEl.textContent = 'Using tools...'; }
}
function hideWelcome() { if (welcomeEl.parentNode) welcomeEl.parentNode.removeChild(welcomeEl); }
function addUserMsg(text) {
  hideWelcome();
  const d = document.createElement('div'); d.className = 'msg msg-u';
  d.innerHTML = '<div class="av av-u">T</div><div class="mb">' + esc(text) + '</div>';
  msgsEl.appendChild(d); scroll();
}
function startAiMsg() {
  hideWelcome();
  const id = 'ai' + Date.now(); S.aiId = id; S.buf = '';
  const d = document.createElement('div'); d.className = 'msg msg-a'; d.id = id;
  d.innerHTML = '<div class="av av-a">&#9889;</div><div class="mb"><div class="md" id="md' + id + '"></div><span class="blink" id="cur' + id + '">&#9607;</span></div>';
  msgsEl.appendChild(d); scroll();
}
function appendText(t) {
  S.buf += t;
  const el = document.getElementById('md' + S.aiId);
  if (el) { el.innerHTML = md(S.buf); scroll(); }
}
function addToolBlock(name, input, isResult, detail) {
  const wrap = document.createElement('div'); wrap.className = 'tool-wrap';
  const keyP = (input && (input.command || input.path || input.pattern)) || '';
  const cls = isResult ? 'tool-hdr result' : 'tool-hdr';
  const icon = isResult ? '&#10003;' : '&#9889;';
  const icls = isResult ? 'ti ok' : 'ti';
  const ncls = isResult ? 'tn ok' : 'tn';
  const paramStr = keyP ? String(keyP).slice(0, 60) : '';
  const lines = detail ? detail.split('\\n').length : 0;
  let html = '<div class="' + cls + '"><span class="' + icls + '">' + icon + '</span><span class="' + ncls + '">' + esc(name) + '</span>';
  if (paramStr) html += '<span class="tp">' + esc(paramStr) + '</span>';
  if (isResult) html += '<span class="tm">' + lines + ' lines</span>';
  html += '<span class="tv">&#9660;</span></div>';
  wrap.innerHTML = html;
  if (detail) {
    const body = document.createElement('div'); body.className = 'tool-body'; body.style.display = 'none'; body.textContent = detail;
    wrap.appendChild(body);
    wrap.querySelector('.tool-hdr').onclick = () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      wrap.querySelector('.tv').innerHTML = open ? '&#9660;' : '&#9650;';
    };
  }
  const msgEl = document.getElementById(S.aiId);
  if (msgEl) { const mb = msgEl.querySelector('.mb'); mb.insertBefore(wrap, mb.querySelector('.blink')); }
  scroll();
}
function finishAiMsg() {
  const cur = document.getElementById('cur' + S.aiId); if (cur) cur.remove();
  S.buf = ''; S.aiId = null;
}
function addErrMsg(text) {
  const d = document.createElement('div'); d.className = 'msg msg-e';
  d.innerHTML = '<div class="av av-e">!</div><div class="mb">' + esc(text) + '</div>';
  msgsEl.appendChild(d); scroll();
}
function scroll() { msgsEl.scrollTop = msgsEl.scrollHeight; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function md(s) {
  let h = esc(s);
  h = h.replace(/\`\`\`[\\w-]*\\n([\\s\\S]*?)\`\`\`/g, function(_,c){ return '<pre><code>' + c + '</code></pre>'; });
  h = h.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  h = h.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  h = h.replace(/^---$/gm, '<hr>');
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  h = h.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>.*<\\/li>)+/gs, '<ul>$&</ul>');
  h = h.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
  h = h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
  h = h.replace(/\\n\\n/g, '</p><p>');
  h = '<p>' + h + '</p>';
  ['h1','h2','h3','pre','ul','ol','blockquote','hr'].forEach(function(t) {
    h = h.replace(new RegExp('<p>(<' + t + '[^>]*>)', 'g'), '$1');
    h = h.replace(new RegExp('(<\\\\/' + t + '>)<\\/p>', 'g'), '$1');
  });
  h = h.replace(/<p><\\/p>/g,'');
  return h;
}
window.addEventListener('message', e => {
  const m = e.data;
  switch(m.type) {
    case 'init': S.cwd = m.cwd || ''; cwdText.textContent = S.cwd || '~'; break;
    case 'proxyStatus': dot.className = 'dot ' + (m.ok ? 'on' : 'off'); break;
    case 'cleared':
      msgsEl.innerHTML = ''; msgsEl.appendChild(welcomeEl);
      S.totalIn = 0; S.totalOut = 0; S.buf = '';
      tokEl.style.display = 'none'; tokSep.style.display = 'none'; break;
    case 'streamStart': break;
    case 'text': appendText(m.text); break;
    case 'toolCall': setStatus('tools'); addToolBlock(m.name, m.input, false, JSON.stringify(m.input, null, 2)); break;
    case 'toolResult': addToolBlock(m.name, null, true, m.result); setStatus('streaming'); break;
    case 'usage':
      S.totalIn += m.input_tokens||0; S.totalOut += m.output_tokens||0;
      tokEl.textContent = S.totalIn.toLocaleString()+' in / '+S.totalOut.toLocaleString()+' out';
      tokSep.style.display=''; tokEl.style.display=''; break;
    case 'error': finishAiMsg(); addErrMsg(m.message); setStatus('idle'); break;
    case 'streamEnd': finishAiMsg(); setStatus('idle'); break;
  }
});
vscode.postMessage({ type: 'ready' });
vscode.postMessage({ type: 'checkProxy' });
setInterval(() => vscode.postMessage({ type: 'checkProxy' }), 15000);
</script>
</body>
</html>`;
}
