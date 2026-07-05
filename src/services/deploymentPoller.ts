import * as vscode from 'vscode';
import { getDeployment, getLatestDeployment } from '../api/vercelApi';
import { DeploymentState, VercelDeployment, VercelProject } from '../types';

// Poll every 5s while building, 10s when idle (fast enough to catch new deploys)
const ACTIVE_INTERVAL_MS = 5000;
const IDLE_INTERVAL_MS = 10000;

export type PollerEventType = 'update' | 'error' | 'completed' | 'failed';

export interface PollerEvent {
  type: PollerEventType;
  deployment?: VercelDeployment;
  error?: string;
}

export class DeploymentPoller {
  private timer: NodeJS.Timeout | undefined;
  private currentDeploymentId: string | undefined;
  private currentState: DeploymentState | undefined;
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
    // Poll immediately on start
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
    // Reset so next poll treats everything as new
    this.currentDeploymentId = undefined;
    this.currentState = undefined;
  }

  public dispose(): void {
    this.stop();
    this._onEvent.dispose();
  }

  private scheduleNext(): void {
    const interval = this.isActive ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    this.timer = setTimeout(() => this.poll(), interval);
  }

  private async poll(): Promise<void> {
    this.timer = undefined;

    try {
      // Step 1: quick list call to check latest uid + state cheaply
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

      const isNewDeployment = latest.uid !== this.currentDeploymentId;
      const stateChanged = latest.state !== this.currentState;
      const isFirstPoll = this.currentDeploymentId === undefined;

      // Nothing changed and already in terminal state → stay idle
      // (but always fetch on first poll so lastDeployment gets populated)
      if (!isFirstPoll && !isNewDeployment && !stateChanged && isTerminalState(latest.state)) {
        this.isActive = false;
        this.scheduleNext();
        return;
      }

      // First poll, new deployment, or state changed — fetch full details
      if (isFirstPoll || isNewDeployment || stateChanged) {
        this.currentDeploymentId = latest.uid;
        this.currentState = latest.state;
        this.isActive = !isTerminalState(latest.state);

        // Fetch full deployment for logs + complete metadata
        const deployment = await getDeployment(
          this.token,
          latest.uid,
          this.project.orgId || undefined
        );

        // Use the more accurate state from the detail endpoint
        this.currentState = deployment.state;
        this.isActive = !isTerminalState(deployment.state);

        if (deployment.state === 'READY') {
          this._onEvent.fire({ type: 'completed', deployment });
        } else if (isTerminalState(deployment.state)) {
          this._onEvent.fire({ type: 'failed', deployment });
        } else {
          // QUEUED, INITIALIZING, BUILDING — fire update for status bar
          this._onEvent.fire({ type: 'update', deployment });
        }
      } else {
        // Same deployment, non-terminal, no state change — still active, keep polling fast
        this.isActive = true;
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
