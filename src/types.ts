export type DeploymentState =
  | 'QUEUED'
  | 'BUILDING'
  | 'READY'
  | 'ERROR'
  | 'CANCELED'
  | 'INITIALIZING';

export interface VercelProject {
  projectId: string;
  orgId: string;
  projectName?: string;
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: DeploymentState;
  target: 'production' | 'staging' | null;
  meta: {
    githubCommitSha?: string;
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitAuthorName?: string;
  };
  createdAt: number;
  buildingAt?: number;
  ready?: number;
}

export interface BuildLog {
  text: string;
  type: 'command' | 'stdout' | 'stderr' | 'exit' | 'error' | 'warn' | 'info' | 'delimiter';
  created: number;
}
