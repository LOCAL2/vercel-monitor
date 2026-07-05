import * as vscode from 'vscode';
import { DeploymentPoller } from './services/deploymentPoller';
import { detectVercelProject, watchProjectFile } from './services/projectDetector';
import { VercelStatusBar } from './ui/statusBar';
import { DeploymentPanel } from './ui/deploymentPanel';
import { findProjectByName, listProjects, validateToken } from './api/vercelApi';
import { VercelProject } from './types';

const TOKEN_SECRET_KEY = 'vercel-monitor.token';
const PROJECT_STATE_KEY = 'vercel-monitor.project';

let poller: DeploymentPoller | undefined;
let statusBar: VercelStatusBar | undefined;
let currentProject: VercelProject | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = new VercelStatusBar();
  context.subscriptions.push(statusBar);

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('vercel-monitor.configure', async () => {
      await runSetupWizard(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vercel-monitor.openPanel', async () => {
      const token = await getToken(context);
      if (!token || !currentProject) {
        const action = await vscode.window.showWarningMessage(
          'Vercel Monitor is not configured.',
          'Configure Now'
        );
        if (action === 'Configure Now') {
          await runSetupWizard(context);
        }
        return;
      }
      DeploymentPanel.createOrShow(context.extensionUri, token, currentProject.orgId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vercel-monitor.refresh', async () => {
      if (poller) {
        poller.stop();
        poller.start();
        vscode.window.setStatusBarMessage('$(sync~spin) Vercel Monitor: Refreshing…', 3000);
      } else {
        await initPoller(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vercel-monitor.selectProject', async () => {
      const token = await getToken(context);
      if (!token) {
        vscode.window.showWarningMessage('Vercel Monitor: Set an API token first.');
        return;
      }
      context.globalState.update(PROJECT_STATE_KEY, undefined);
      currentProject = undefined;
      poller?.stop();
      poller = undefined;
      await initPoller(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vercel-monitor.clearToken', async () => {
      await context.secrets.delete(TOKEN_SECRET_KEY);
      context.globalState.update(PROJECT_STATE_KEY, undefined);
      statusBar?.showNotConfigured();
      poller?.stop();
      poller = undefined;
      currentProject = undefined;
      vscode.window.showInformationMessage('Vercel token cleared.');
    })
  );

  // ── File watcher for .vercel/project.json ────────────────────────────────

  const watcher = watchProjectFile(async () => {
    await initPoller(context);
  });
  context.subscriptions.push(watcher);

  // ── Initial startup ───────────────────────────────────────────────────────

  await initPoller(context);
}

export function deactivate(): void {
  poller?.dispose();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(TOKEN_SECRET_KEY);
  if (stored) {
    return stored;
  }
  const envToken = process.env['VERCEL_TOKEN'];
  if (envToken) {
    return envToken;
  }
  return undefined;
}

async function initPoller(context: vscode.ExtensionContext): Promise<void> {
  const token = await getToken(context);

  if (!token) {
    statusBar?.showNotConfigured();
    const action = await vscode.window.showInformationMessage(
      'Vercel Monitor: No API token configured.',
      'Set Token'
    );
    if (action === 'Set Token') {
      await runSetupWizard(context);
    }
    return;
  }

  // 1. ลองอ่านจาก .vercel/project.json ก่อน
  let project = await detectVercelProject();

  // 2. ถ้าไม่มีไฟล์ config ให้ดึงจาก globalState (เคยเลือกไว้แล้ว)
  if (!project?.projectId) {
    const saved = context.globalState.get<VercelProject>(PROJECT_STATE_KEY);
    if (saved?.projectId) {
      project = saved;
    }
  }

  // 3. ถ้ายังไม่มี ให้ค้นหาจากชื่อ workspace แล้วให้เลือก
  if (!project?.projectId) {
    const resolved = await resolveProjectFromWorkspace(token, context);
    if (!resolved) {
      statusBar?.showNotConfigured();
      return;
    }
    project = resolved;
  }

  currentProject = project;

  if (poller) {
    poller.updateCredentials(token, project);
    return;
  }

  poller = new DeploymentPoller(token, project);

  poller.onEvent(async (event) => {
    switch (event.type) {
      case 'update':
        if (event.deployment) {
          statusBar?.update(event.deployment);
          if (DeploymentPanel.currentPanel) {
            await DeploymentPanel.currentPanel.update(event.deployment);
          }
        }
        break;

      case 'completed':
        if (event.deployment) {
          statusBar?.update(event.deployment);

          const env = event.deployment.target === 'production' ? 'Production' : 'Preview';
          const commitMsg = event.deployment.meta?.githubCommitMessage?.split('\n')[0] ?? '';
          const durationStr = getDurationStr(event.deployment);
          const msg = `✅ Vercel Deploy Ready — ${event.deployment.name} (${env})${commitMsg ? ': ' + commitMsg : ''}${durationStr ? ' · ' + durationStr : ''}`;

          const action = await vscode.window.showInformationMessage(
            msg,
            'Open Dashboard',
            'Open Deployment'
          );

          if (action === 'Open Dashboard') {
            await openPanel(context);
          } else if (action === 'Open Deployment') {
            vscode.env.openExternal(vscode.Uri.parse(`https://${event.deployment.url}`));
          }
        }
        break;

      case 'failed':
        if (event.deployment) {
          statusBar?.update(event.deployment);

          const action = await vscode.window.showErrorMessage(
            `❌ Vercel Deploy Failed — ${event.deployment.name}`,
            'View Build Logs'
          );

          if (action === 'View Build Logs') {
            await openPanel(context);
          }
        }
        break;

      case 'error':
        statusBar?.showError(event.error ?? 'Unknown error');
        break;
    }
  });

  poller.start();
  statusBar?.showIdle();
}

/**
 * ค้นหา Vercel project จากชื่อ workspace folder
 * ถ้าเจอหลายตัวหรือไม่เจอเลย ให้ผู้ใช้เลือกจาก Quick Pick
 */
async function resolveProjectFromWorkspace(
  token: string,
  context: vscode.ExtensionContext
): Promise<VercelProject | undefined> {
  const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Vercel Monitor: Looking up project…',
      cancellable: false,
    },
    async () => {
      try {
        // ลองหาชื่อตรงกับ workspace ก่อน
        let candidates = workspaceName
          ? await findProjectByName(token, workspaceName)
          : [];

        // ถ้าไม่เจอชื่อตรง ดึง list ทั้งหมดมาให้เลือก
        if (candidates.length === 0) {
          const all = await listProjects(token);

          if (all.length === 0) {
            vscode.window.showWarningMessage(
              'Vercel Monitor: No projects found in your Vercel account.'
            );
            return undefined;
          }

          // ถ้ามีแค่ project เดียวใช้เลย
          if (all.length === 1) {
            candidates = all;
          } else {
            const picked = await vscode.window.showQuickPick(
              all.map((p) => ({
                label: p.name,
                description: p.id,
                project: p,
              })),
              {
                title: 'Vercel Monitor: Select your Vercel project',
                placeHolder: workspaceName
                  ? `No project named "${workspaceName}" found — pick one manually`
                  : 'Pick a Vercel project to monitor',
                ignoreFocusOut: true,
              }
            );

            if (!picked) {
              return undefined;
            }
            candidates = [picked.project];
          }
        }

        // ถ้าชื่อตรงแต่มีหลายตัว ให้เลือก
        if (candidates.length > 1) {
          const picked = await vscode.window.showQuickPick(
            candidates.map((p) => ({
              label: p.name,
              description: p.id,
              project: p,
            })),
            {
              title: 'Vercel Monitor: Multiple projects match — pick one',
              ignoreFocusOut: true,
            }
          );
          if (!picked) {
            return undefined;
          }
          candidates = [picked.project];
        }

        const chosen = candidates[0];
        const result: VercelProject = {
          projectId: chosen.id,
          orgId: chosen.accountId,
          projectName: chosen.name,
        };

        // บันทึกไว้ใน globalState ไม่ต้องเลือกซ้ำครั้งหน้า
        context.globalState.update(PROJECT_STATE_KEY, result);
        vscode.window.showInformationMessage(
          `Vercel Monitor: Linked to project "${chosen.name}"`
        );

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Vercel Monitor: Failed to fetch projects — ${message}`
        );
        return undefined;
      }
    }
  );
}

async function openPanel(context: vscode.ExtensionContext): Promise<void> {
  const token = await getToken(context);
  if (!token || !currentProject) {
    return;
  }
  DeploymentPanel.createOrShow(context.extensionUri, token, currentProject.orgId);
}

async function runSetupWizard(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: 'Vercel Monitor Setup',
    prompt: 'Enter your Vercel API token',
    placeHolder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return 'Token cannot be empty';
      }
      return null;
    },
  });

  if (!token) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Vercel Monitor: Validating token…',
      cancellable: false,
    },
    async () => {
      try {
        const username = await validateToken(token.trim());
        await context.secrets.store(TOKEN_SECRET_KEY, token.trim());
        // Clear any previously saved project so it re-resolves
        context.globalState.update(PROJECT_STATE_KEY, undefined);
        currentProject = undefined;
        poller?.stop();
        poller = undefined;
        vscode.window.showInformationMessage(
          `✅ Vercel Monitor: Authenticated as ${username}. Linking project…`
        );
        await initPoller(context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Vercel Monitor: Invalid token — ${message}`);
      }
    }
  );
}

function getDurationStr(deployment: { createdAt: number; ready?: number }): string {
  if (!deployment.ready) {
    return '';
  }
  const secs = Math.round((deployment.ready - deployment.createdAt) / 1000);
  if (secs < 60) {
    return `${secs}s`;
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}
