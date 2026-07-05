import * as https from 'https';
import { BuildLog, VercelDeployment } from '../types';

const BASE_URL = 'api.vercel.com';

function httpsGet(path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.end();
  });
}

/**
 * Fetch the latest deployment for a given project.
 * @param token Vercel API token
 * @param projectId Vercel project ID
 * @param teamId Vercel org/team ID (optional)
 */
export async function getLatestDeployment(
  token: string,
  projectId: string,
  teamId?: string
): Promise<VercelDeployment | null> {
  const query = teamId ? `?projectId=${projectId}&teamId=${teamId}&limit=1` : `?projectId=${projectId}&limit=1`;
  const result = (await httpsGet(`/v6/deployments${query}`, token)) as {
    deployments?: VercelDeployment[];
    error?: { message: string };
  };

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.deployments?.[0] ?? null;
}

/**
 * Fetch a specific deployment by its ID.
 */
export async function getDeployment(
  token: string,
  deploymentId: string,
  teamId?: string
): Promise<VercelDeployment> {
  const query = teamId ? `?teamId=${teamId}` : '';
  const result = (await httpsGet(`/v13/deployments/${deploymentId}${query}`, token)) as
    | VercelDeployment
    | { error: { message: string } };

  if ('error' in result) {
    throw new Error((result as { error: { message: string } }).error.message);
  }

  return result as VercelDeployment;
}

/**
 * Fetch build logs for a deployment.
 */
export async function getBuildLogs(
  token: string,
  deploymentId: string,
  teamId?: string
): Promise<BuildLog[]> {
  const query = teamId ? `?teamId=${teamId}&direction=forward` : '?direction=forward';
  const result = (await httpsGet(`/v2/deployments/${deploymentId}/events${query}`, token)) as
    | BuildLog[]
    | { error: { message: string } };

  if (!Array.isArray(result)) {
    if ('error' in result) {
      throw new Error((result as { error: { message: string } }).error.message);
    }
    return [];
  }

  return result;
}

/**
 * Validate the API token by fetching the current user.
 */
export async function validateToken(token: string): Promise<string> {
  const result = (await httpsGet('/v2/user', token)) as {
    user?: { name?: string; username?: string };
    error?: { message: string };
  };

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.user?.name ?? result.user?.username ?? 'Unknown';
}

export interface VercelProjectInfo {
  id: string;
  name: string;
  accountId: string;
}

/**
 * List all projects accessible by the token.
 */
export async function listProjects(
  token: string,
  teamId?: string
): Promise<VercelProjectInfo[]> {
  const query = teamId ? `?teamId=${teamId}&limit=100` : '?limit=100';
  const result = (await httpsGet(`/v9/projects${query}`, token)) as {
    projects?: VercelProjectInfo[];
    error?: { message: string };
  };

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.projects ?? [];
}

/**
 * Find a project by name (case-insensitive).
 */
export async function findProjectByName(
  token: string,
  name: string,
  teamId?: string
): Promise<VercelProjectInfo[]> {
  const all = await listProjects(token, teamId);
  return all.filter(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );
}
