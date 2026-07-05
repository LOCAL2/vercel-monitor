import * as vscode from 'vscode';
import { getDeployment, getLatestDeployment } from '../api/vercelApi';
import { DeploymentState, VercelDeployment, VercelProject } from '../types';

const POLL_INTERVAL_MS = 5000; // 5 seconds while active
const IDLE_INTERVAL_MS = 30000; // 30 seconds when idle

export type PollerEventType = 'update' | 'error' | 'completed' | 'failed';

export interface PollerEvent {
  type: PollerEventType;
  deployment?: VercelDeployment;
  error?: string;
}

export class DeploymentPoller {
  private timer: NodeJS.Timeout | undefined;
  private currentDeploymentId: string | undefined;
  private isActive = false;
  private token: string;
  private project: VercelProject;

  private readonly _onEvent = new vscode.EventEmitter<PollerEvent>();
  public readonly onEvent = this._onEvent.event;

  constructor(token: string, project: VercelProject) {
    this.token = token;
    this.project = project;
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.poll();
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.isActive = false;
  }

  public updateCredentials(token: string, project: VercelProject): void {
    this.token = token;
    this.project = project;
    this.currentDeploymentId = undefined;
  }

  public dispose(): void {
    this.stop();
    this._onEvent.dispose();
  }

  private scheduleNext(): void {
    const interval = this.isActive ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS;
    this.timer = setTimeout(() => this.poll(), interval);
  }

  private async poll(): Promise<void> {
    this.timer = undefined;

    try {
      const latest = await getLatestDeployment(
        this.token,
        this.project.projectId,
        this.project.orgId || undefined
      );

      if (!latest) {
        this.isActive = false;
        this.scheduleNext();
        return;
      }

      // If same deployment and it's already in a terminal state, go idle
      if (
        latest.uid === this.currentDeploymentId &&
        isTerminalState(latest.state)
      ) {
        this.isActive = false;
        this.scheduleNext();
        return;
      }

      // New deployment detected or state changed
      const isNewDeployment = latest.uid !== this.currentDeploymentId;
      this.currentDeploymentId = latest.uid;

      // Fetch full details
      const deployment = await getDeployment(
        this.token,
        latest.uid,
        this.project.orgId || undefined
      );

      this.isActive = !isTerminalState(deployment.state);

      if (isTerminalState(deployment.state)) {
        const eventType = deployment.state === 'READY' ? 'completed' : 'failed';
        this._onEvent.fire({ type: eventType, deployment });
      } else if (isNewDeployment) {
        this._onEvent.fire({ type: 'update', deployment });
      } else {
        this._onEvent.fire({ type: 'update', deployment });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._onEvent.fire({ type: 'error', error: message });
    }

    this.scheduleNext();
  }
}

function isTerminalState(state: DeploymentState): boolean {
  return state === 'READY' || state === 'ERROR' || state === 'CANCELED';
}
