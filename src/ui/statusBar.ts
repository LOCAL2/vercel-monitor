import * as vscode from 'vscode';
import { DeploymentState, VercelDeployment } from '../types';

const STATE_ICONS: Record<DeploymentState, string> = {
  QUEUED: '$(clock)',
  INITIALIZING: '$(sync~spin)',
  BUILDING: '$(loading~spin)',
  READY: '$(cloud)',
  ERROR: '$(error)',
  CANCELED: '$(circle-slash)',
};

const STATE_LABELS: Record<DeploymentState, string> = {
  QUEUED: 'Queued',
  INITIALIZING: 'Initializing',
  BUILDING: 'Building',
  READY: 'Ready',
  ERROR: 'Failed',
  CANCELED: 'Canceled',
};

export class VercelStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'vercel-monitor.openPanel';
    this.showIdle();
    this.item.show();
  }

  public showIdle(): void {
    this.item.text = '$(cloud) Vercel';
    this.item.tooltip = 'Vercel Monitor — Click to open dashboard';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
  }

  public showNotConfigured(): void {
    this.item.text = '$(cloud) Vercel: Not configured';
    this.item.tooltip = 'Click to configure Vercel Monitor';
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  public update(deployment: VercelDeployment): void {
    const icon = STATE_ICONS[deployment.state] ?? '$(cloud)';
    const label = STATE_LABELS[deployment.state] ?? deployment.state;
    const env = deployment.target === 'production' ? 'Production' : 'Preview';

    const branch = deployment.meta?.githubCommitRef;
    const duration =
      deployment.ready && deployment.createdAt
        ? formatDuration(Math.round((deployment.ready - deployment.createdAt) / 1000))
        : undefined;

    // e.g. "$(check) Vercel: Ready · main · 1m 23s"
    const parts = [`${icon} Vercel: ${label}`];
    if (branch) { parts.push(branch); }
    if (duration && isTerminalState(deployment.state)) { parts.push(duration); }

    this.item.text = parts.join(' · ');
    this.item.tooltip = buildTooltip(deployment, env);

    if (deployment.state === 'READY') {
      this.item.color = new vscode.ThemeColor('testing.iconPassed');
      this.item.backgroundColor = undefined;
    } else if (deployment.state === 'ERROR') {
      this.item.color = undefined;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (deployment.state === 'BUILDING' || deployment.state === 'INITIALIZING') {
      this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
    }
  }

  public showError(message: string): void {
    this.item.text = '$(error) Vercel: Error';
    this.item.tooltip = `Vercel Monitor error: ${message}`;
    this.item.color = undefined;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  public dispose(): void {
    this.item.dispose();
  }
}

function buildTooltip(deployment: VercelDeployment, env: string): string {
  const lines: string[] = [
    `Project: ${deployment.name}`,
    `Environment: ${env}`,
    `State: ${STATE_LABELS[deployment.state] ?? deployment.state}`,
  ];

  if (deployment.meta?.githubCommitRef) {
    lines.push(`Branch: ${deployment.meta.githubCommitRef}`);
  }
  if (deployment.meta?.githubCommitMessage) {
    const msg = deployment.meta.githubCommitMessage.split('\n')[0];
    lines.push(`Commit: ${msg.length > 60 ? msg.slice(0, 60) + '…' : msg}`);
  }
  if (deployment.meta?.githubCommitAuthorName) {
    lines.push(`Author: ${deployment.meta.githubCommitAuthorName}`);
  }

  if (deployment.ready && deployment.createdAt) {
    const durationSec = Math.round((deployment.ready - deployment.createdAt) / 1000);
    lines.push(`Duration: ${formatDuration(durationSec)}`);
  }

  lines.push('', 'Click to open deployment panel');
  return lines.join('\n');
}

function isTerminalState(state: DeploymentState): boolean {
  return state === 'READY' || state === 'ERROR' || state === 'CANCELED';
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
