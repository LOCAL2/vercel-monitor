import * as https from 'https';
import { DeploymentState, VercelDeployment } from '../types';

const BASE_URL = 'api.vercel.com';

// Raw shape from Vercel API — state field name differs by endpoint
interface RawDeployment {
  uid: string;
  name: string;
  url: string;
  state?: string;         // from /v6/deployments list
  readyState?: string;    // from /v13/deployments/:id
  target: 'production' | 'staging' | null;
  meta?: {
    githubCommitSha?: string;
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitAuthorName?: string;
  };
  createdAt: number;
  buildingAt?: number;
  ready?: number;
}

const VALID_STATES: DeploymentState[] = [
  'QUEUED', 'BUILDING', 'READY', 'ERROR', 'CANCELED', 'INITIALIZING',
];

function normalizeDeployment(raw: RawDeployment): VercelDeployment {
  // /v13 uses readyState, /v6 uses state — normalise to uppercase
  const rawState = (raw.readyState ?? raw.state ?? '').toUpperCase();
  const state: DeploymentState = (VALID_STATES.includes(rawState as DeploymentState)
    ? rawState
    : 'QUEUED') as DeploymentState;

  return {
    uid: raw.uid,
    name: raw.name,
    url: raw.url,
    state,
    target: raw.target,
    meta: raw.meta ?? {},
    createdAt: raw.createdAt,
    buildingAt: raw.buildingAt,
    ready: raw.ready,
  };
}

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
 */
export async function getLatestDeployment(
  token: string,
  projectId: string,
  teamId?: string
): Promise<VercelDeployment | null> {
  const params = new URLSearchParams({
    projectId,
    limit: '1',
    sort: 'created',
    order: 'desc',
  });
  if (teamId) { params.set('teamId', teamId); }

  const result = (await httpsGet(`/v6/deployments?${params.toString()}`, token)) as {
    deployments?: RawDeployment[];
    error?: { message: string };
  };

  if (result.error) {
    throw new Error(result.error.message);
  }

  const raw = result.deployments?.[0];
  return raw ? normalizeDeployment(raw) : null;
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
    | RawDeployment
    | { error: { message: string } };

  if ('error' in result && (result as { error: { message: string } }).error) {
    throw new Error((result as { error: { message: string } }).error.message);
  }

  return normalizeDeployment(result as RawDeployment);
}

/**
 * Stream build logs for a deployment, calling onLine for each log line as it arrives.
 * Uses /v3 NDJSON streaming endpoint.
 */
export function streamBuildLogs(
  token: string,
  deploymentId: string,
  deploymentUrl: string,
  teamId: string | undefined,
  onLine: (line: { text: string; logType: string }) => void,
  onDone: () => void,
  onError: (message: string) => void
): Promise<void> {
  // Try uid first, fall back to hostname url on 404
  return streamById(token, deploymentId, teamId, onLine, onDone, (err) => {
    if (err.includes('404') || err.includes('not_found')) {
      streamById(token, deploymentUrl, teamId, onLine, onDone, onError).catch(() => undefined);
    } else {
      onError(err);
    }
  });
}

function streamById(
  token: string,
  idOrUrl: string,
  teamId: string | undefined,
  onLine: (line: { text: string; logType: string }) => void,
  onDone: () => void,
  onError: (message: string) => void
): Promise<void> {
  const params = new URLSearchParams({ direction: 'forward', builds: '1' });
  if (teamId) { params.set('teamId', teamId); }

  return new Promise((resolve) => {
    const options = {
      hostname: BASE_URL,
      path: `/v3/deployments/${encodeURIComponent(idOrUrl)}/events?${params.toString()}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          onError(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
          resolve();
        });
        return;
      }

      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // Process all complete newline-delimited JSON lines
        const lines = buffer.split('\n');
        // Keep last partial line in buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }
          try {
            const event = JSON.parse(trimmed) as {
              type?: string;
              created?: number;
              payload?: { text?: string; type?: string };
              text?: string;
            };

            if (!event || event.type === 'delimiter') { continue; }

            const text = event.payload?.text ?? event.text ?? '';
            if (!text.trim()) { continue; }

            const logType = event.payload?.type ?? event.type ?? 'stdout';
            onLine({ text, logType });
          } catch {
            // skip malformed line
          }
        }
      });

      res.on('end', () => {
        // Flush any remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer) as {
              type?: string;
              payload?: { text?: string; type?: string };
              text?: string;
            };
            const text = event.payload?.text ?? event.text ?? '';
            if (text.trim()) {
              onLine({ text, logType: event.payload?.type ?? event.type ?? 'stdout' });
            }
          } catch { /* ignore */ }
        }
        onDone();
        resolve();
      });

      res.on('error', (err) => {
        onError(err.message);
        resolve();
      });
    });

    req.on('error', (err) => {
      onError(err.message);
      resolve();
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error('Build log request timed out'));
    });

    req.end();
  });
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
