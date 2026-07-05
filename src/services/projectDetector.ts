import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { VercelProject } from '../types';

/**
 * Attempt to detect Vercel project configuration from the workspace.
 * Checks .vercel/project.json first, then vercel.json as fallback.
 */
export async function detectVercelProject(): Promise<VercelProject | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return null;
  }

  for (const folder of workspaceFolders) {
    const projectJsonPath = path.join(folder.uri.fsPath, '.vercel', 'project.json');

    if (fs.existsSync(projectJsonPath)) {
      try {
        const content = fs.readFileSync(projectJsonPath, 'utf-8');
        const data = JSON.parse(content) as {
          projectId?: string;
          orgId?: string;
        };

        if (data.projectId && data.orgId) {
          return {
            projectId: data.projectId,
            orgId: data.orgId,
          };
        }
      } catch {
        // ignore parse errors and try next
      }
    }

    // Fallback: check vercel.json for project name hint
    const vercelJsonPath = path.join(folder.uri.fsPath, 'vercel.json');
    if (fs.existsSync(vercelJsonPath)) {
      try {
        const content = fs.readFileSync(vercelJsonPath, 'utf-8');
        const data = JSON.parse(content) as { name?: string };
        if (data.name) {
          return {
            projectId: '',
            orgId: '',
            projectName: data.name,
          };
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}

/**
 * Watch for changes to .vercel/project.json and re-detect on change.
 */
export function watchProjectFile(
  onChanged: () => void
): vscode.FileSystemWatcher {
  const pattern = new vscode.RelativePattern(
    vscode.workspace.workspaceFolders?.[0] ?? '',
    '.vercel/project.json'
  );
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidChange(onChanged);
  watcher.onDidCreate(onChanged);
  watcher.onDidDelete(onChanged);
  return watcher;
}
