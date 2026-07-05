import * as vscode from 'vscode';
import { streamBuildLogs } from '../api/vercelApi';
import { VercelDeployment } from '../types';

export class DeploymentPanel {
  public static currentPanel: DeploymentPanel | undefined;
  private static readonly viewType = 'vercelDeployment';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private currentDeployment: VercelDeployment | undefined;
  private token: string;
  private teamId: string | undefined;
  private streamAbort: (() => void) | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    token: string,
    teamId?: string
  ) {
    this.panel = panel;
    this.token = token;
    this.teamId = teamId;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    token: string,
    teamId?: string
  ): DeploymentPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DeploymentPanel.currentPanel) {
      DeploymentPanel.currentPanel.panel.reveal(column);
      DeploymentPanel.currentPanel.token = token;
      DeploymentPanel.currentPanel.teamId = teamId;
      return DeploymentPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      DeploymentPanel.viewType,
      'Vercel Deployment',
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
      }
    );

    DeploymentPanel.currentPanel = new DeploymentPanel(panel, token, teamId);
    return DeploymentPanel.currentPanel;
  }

  public async update(deployment: VercelDeployment): Promise<void> {
    // Cancel any in-progress stream from a previous deployment
    this.streamAbort?.();
    this.streamAbort = undefined;

    this.currentDeployment = deployment;
    this.panel.title = `Vercel: ${deployment.name}`;

    // Render the shell HTML first (logs container is empty / shows spinner)
    this.panel.webview.html = this.buildHtml(deployment);

    // Only stream logs for states that have build output
    if (
      deployment.state === 'READY' ||
      deployment.state === 'ERROR' ||
      deployment.state === 'BUILDING'
    ) {
      let aborted = false;
      this.streamAbort = () => { aborted = true; };

      try {
        await streamBuildLogs(
          this.token,
          deployment.uid,
          deployment.url,
          this.teamId,
          (line) => {
            if (aborted || !this.panel) { return; }
            this.panel.webview.postMessage({ type: 'log', text: line.text, logType: line.logType });
          },
          () => {
            if (aborted || !this.panel) { return; }
            this.panel.webview.postMessage({ type: 'done' });
          },
          (err) => {
            if (aborted || !this.panel) { return; }
            this.panel.webview.postMessage({ type: 'error', text: err });
          }
        );
      } catch {
        // stream errors are already forwarded via onError callback
      }
    }
  }

  public dispose(): void {
    this.streamAbort?.();
    DeploymentPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private buildHtml(deployment: VercelDeployment): string {
    const env = deployment.target === 'production' ? 'Production' : 'Preview';
    const stateColor = getStateColor(deployment.state);
    const stateLabel = getStateLabel(deployment.state);

    const createdAt = new Date(deployment.createdAt).toLocaleString();
    const readyAt = deployment.ready
      ? new Date(deployment.ready).toLocaleString()
      : '—';

    let durationStr = '—';
    if (deployment.ready && deployment.createdAt) {
      const secs = Math.round((deployment.ready - deployment.createdAt) / 1000);
      durationStr = formatDuration(secs);
    } else if (deployment.buildingAt && deployment.createdAt) {
      const secs = Math.round((Date.now() - deployment.createdAt) / 1000);
      durationStr = `${formatDuration(secs)} (in progress)`;
    }

    const commitMsg = deployment.meta?.githubCommitMessage?.split('\n')[0] ?? '—';
    const commitSha = deployment.meta?.githubCommitSha
      ? deployment.meta.githubCommitSha.slice(0, 7)
      : '—';
    const branch = deployment.meta?.githubCommitRef ?? '—';
    const author = deployment.meta?.githubCommitAuthorName ?? '—';
    const deployUrl = `https://${deployment.url}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vercel Deployment</title>
  <style>
    :root { --radius: 6px; }
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0 24px 40px;
    }
    h1 { font-size: 1.4em; margin-bottom: 4px; }
    h2 { font-size: 1em; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 24px 0 10px; }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: .85em;
      font-weight: 600;
      background: ${stateColor.bg};
      color: ${stateColor.fg};
    }
    .grid {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 16px;
    }
    .label { color: var(--vscode-descriptionForeground); }
    .value { font-weight: 500; word-break: break-all; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .logs {
      background: var(--vscode-terminal-background, #1e1e1e);
      color: var(--vscode-terminal-foreground, #d4d4d4);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius);
      padding: 12px 16px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .85em;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-line { line-height: 1.5; }
    .log-error { color: #f48771; }
    .log-normal { color: var(--vscode-terminal-foreground, #d4d4d4); }
    .log-status { color: var(--vscode-descriptionForeground); font-style: italic; }
    .header { display: flex; align-items: center; gap: 12px; padding: 20px 0 12px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; }
    .open-btn {
      display: inline-block;
      margin-top: 4px;
      padding: 5px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: var(--radius);
      text-decoration: none;
      font-size: .9em;
    }
    .open-btn:hover { background: var(--vscode-button-hoverBackground); text-decoration: none; }
    @keyframes blink { 50% { opacity: 0; } }
    .cursor { display: inline-block; width: 7px; height: 1em; background: currentColor; vertical-align: text-bottom; animation: blink 1s step-end infinite; margin-left: 2px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(deployment.name)}</h1>
    <span class="badge">${stateLabel}</span>
    <span class="badge" style="background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)">${env}</span>
  </div>

  <h2>Deployment Info</h2>
  <div class="grid">
    <span class="label">URL</span>
    <span class="value"><a href="${deployUrl}" target="_blank">${escapeHtml(deployment.url)}</a></span>
    <span class="label">State</span>
    <span class="value">${stateLabel}</span>
    <span class="label">Environment</span>
    <span class="value">${env}</span>
    <span class="label">Created</span>
    <span class="value">${createdAt}</span>
    <span class="label">Completed</span>
    <span class="value">${readyAt}</span>
    <span class="label">Duration</span>
    <span class="value">${durationStr}</span>
  </div>

  <h2>Git Info</h2>
  <div class="grid">
    <span class="label">Branch</span>
    <span class="value">${escapeHtml(branch)}</span>
    <span class="label">Commit</span>
    <span class="value">${escapeHtml(commitSha)}</span>
    <span class="label">Message</span>
    <span class="value">${escapeHtml(commitMsg)}</span>
    <span class="label">Author</span>
    <span class="value">${escapeHtml(author)}</span>
  </div>

  <h2>Build Logs</h2>
  <div class="logs" id="logs">
    <span class="log-status" id="status">Loading logs…<span class="cursor"></span></span>
  </div>

  <br/>
  <a class="open-btn" href="${deployUrl}" target="_blank">Open Deployment ↗</a>

  <script>
    const logsEl = document.getElementById('logs');
    const statusEl = document.getElementById('status');
    let firstLine = true;

    function escHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'log') {
        if (firstLine) {
          // Remove the loading indicator on first real log line
          statusEl?.remove();
          firstLine = false;
        }
        const div = document.createElement('div');
        div.className = 'log-line ' + (
          msg.logType === 'stderr' || msg.logType === 'error' ? 'log-error' : 'log-normal'
        );
        div.textContent = msg.text;
        logsEl.appendChild(div);
        // Auto-scroll to bottom
        logsEl.scrollTop = logsEl.scrollHeight;
      } else if (msg.type === 'done') {
        statusEl?.remove();
        if (firstLine) {
          const span = document.createElement('span');
          span.className = 'log-status';
          span.textContent = 'No build output available.';
          logsEl.appendChild(span);
        }
      } else if (msg.type === 'error') {
        statusEl?.remove();
        const span = document.createElement('span');
        span.className = 'log-line log-error';
        span.textContent = 'Error fetching logs: ' + msg.text;
        logsEl.appendChild(span);
      }
    });
  </script>
</body>
</html>`;
  }
}

function getStateColor(state: string): { bg: string; fg: string } {
  switch (state) {
    case 'READY':      return { bg: '#16a34a', fg: '#fff' };
    case 'ERROR':      return { bg: '#dc2626', fg: '#fff' };
    case 'BUILDING':
    case 'INITIALIZING': return { bg: '#2563eb', fg: '#fff' };
    case 'QUEUED':     return { bg: '#6b7280', fg: '#fff' };
    case 'CANCELED':   return { bg: '#9ca3af', fg: '#fff' };
    default:           return { bg: '#6b7280', fg: '#fff' };
  }
}

function getStateLabel(state: string): string {
  const map: Record<string, string> = {
    READY: 'Ready', ERROR: 'Failed', BUILDING: 'Building',
    INITIALIZING: 'Initializing', QUEUED: 'Queued', CANCELED: 'Canceled',
  };
  return map[state] ?? state;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) { return `${seconds}s`; }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
