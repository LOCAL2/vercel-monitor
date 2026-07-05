# Vercel Monitor

Track your Vercel deployment status in real-time directly inside VS Code — no more switching tabs after every push.

## Features

- **Status Bar** — live deployment state (Queued → Building → Ready / Failed) with color coding
- **Notifications** — instant alerts when deployments succeed or fail
- **Deployment Panel** — Webview showing full details: project name, environment, branch, commit, duration, and build logs
- **Build Logs** — fetched automatically from the Vercel API and displayed inside VS Code
- **Auto-detection** — reads `.vercel/project.json` created by `vercel link` with no manual configuration
- **Secure token storage** — API token stored in VS Code Secret Storage, never in source code
- **Auto-polling** — checks every 5 seconds while a build is active, slows to 30 seconds when idle

## Setup

### 1. Link your project to Vercel

Run this once in your workspace root:

```sh
vercel link
```

This creates `.vercel/project.json` with your `projectId` and `orgId`. The extension reads this automatically.

### 2. Set your Vercel API token

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
Vercel Monitor: Configure API Token
```

Get your token from [vercel.com/account/tokens](https://vercel.com/account/tokens). The token is saved securely via VS Code's built-in Secret Storage.

Alternatively, set the `VERCEL_TOKEN` environment variable before launching VS Code.

### 3. Push your code

After a `git push`, the status bar updates automatically as Vercel builds and deploys.

## Commands

| Command | Description |
|---|---|
| `Vercel Monitor: Configure API Token` | Set or update your Vercel API token |
| `Vercel Monitor: Open Deployment Panel` | Open the Webview with deployment details |
| `Vercel Monitor: Refresh Deployment Status` | Force an immediate status check |
| `Vercel Monitor: Clear Saved Token` | Remove the stored API token |

## Status Bar

Click the Vercel status bar item (bottom-left) at any time to open the Deployment Panel.

| Icon | Meaning |
|---|---|
| `$(loading~spin) Building` | Build in progress |
| `$(check) Ready` | Deployment successful |
| `$(error) Failed` | Build or deployment error |
| `$(clock) Queued` | Waiting to start |
| `$(cloud) Vercel` | Idle / no active deployment |

## Settings

| Setting | Default | Description |
|---|---|---|
| `vercel-monitor.showNotifications` | `true` | Show notifications on deploy complete/fail |

## Requirements

- VS Code 1.125+
- A Vercel account with a linked project (`vercel link`)
- A Vercel API token

## Security

- API tokens are stored exclusively in VS Code Secret Storage (encrypted on disk)
- No token is ever written to workspace files or source code
- All API calls go directly to `api.vercel.com` over HTTPS
