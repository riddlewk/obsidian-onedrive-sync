# Obsidian OneDrive Sync Plugin

Two-way sync between your Obsidian vault and **Microsoft OneDrive Personal** using the Microsoft Graph API and MSAL device code flow (no redirect server needed).

-----

## Features

- 🔄 **Two-way sync** — changes flow both ways, local ↔ OneDrive
- 🔐 **MSAL Device Code Flow** — sign in via browser, no backend or redirect URI required
- 🔁 **Auto token refresh** — stays connected without re-authentication
- ⚡ **Delta sync** — only fetches what changed since the last sync (efficient)
- 📤 **Save-time upload** — debounced auto-upload on file save
- ⏱️ **Periodic sync** — configurable interval (default: every 15 min)
- ⚔️ **Conflict resolution** — ask, local-wins, remote-wins, or keep-both modes
- 🚫 **Glob exclusions** — skip files by pattern (`.trash/**`, `*.tmp`, etc.)
- 📦 **Large file support** — resumable upload sessions for files > 4 MB

-----

## Prerequisites

1. A **Microsoft account** with OneDrive Personal
1. An **Azure app registration** (free) — see below

-----

## Azure App Registration (one-time setup)

1. Go to [portal.azure.com](https://portal.azure.com) → **Azure Active Directory** → **App registrations** → **New registration**
1. Name it anything (e.g. “Obsidian OneDrive Sync”)
1. Under **Supported account types**, select: *Personal Microsoft accounts only*
1. Under **Redirect URI**, choose **Mobile and desktop applications**, enter:
   
   ```
   https://login.microsoftonline.com/common/oauth2/nativeclient
   ```
1. Click **Register**
1. Copy the **Application (client) ID** — you’ll paste this into the plugin settings

### API Permissions (should be auto-configured)

The plugin requests these delegated scopes during auth:

- `Files.ReadWrite` — read and write OneDrive files
- `offline_access` — allows token refresh without re-login

No admin consent required for personal accounts.

-----

## Installation

### Manual install (until released on community plugins)

```bash
cd /path/to/your/vault/.obsidian/plugins/
git clone https://github.com/yourname/obsidian-onedrive-sync
cd obsidian-onedrive-sync
npm install
npm run build
```

Then enable the plugin in Obsidian → Settings → Community Plugins.

### Development

```bash
npm run dev   # watch mode with sourcemaps
npm run build # production bundle
```

-----

## Configuration

Open **Settings → OneDrive Sync**:

|Setting            |Default                                    |Description                       |
|-------------------|-------------------------------------------|----------------------------------|
|Client ID          |—                                          |Your Azure app’s client ID        |
|OneDrive folder    |`/ObsidianSync`                            |Remote folder path in OneDrive    |
|Sync on save       |✅                                          |Upload on file save (debounced 3s)|
|Sync on startup    |✅                                          |Full sync when Obsidian opens     |
|Sync interval      |15 min                                     |Periodic background sync (0 = off)|
|Conflict resolution|Ask                                        |How to handle edit conflicts      |
|Exclude patterns   |`.obsidian/workspace`, `*.tmp`, `.trash/**`|Glob patterns to skip             |

-----

## How Sync Works

### Two-way delta sync

1. **Remote changes** are fetched using the [OneDrive delta API](https://learn.microsoft.com/en-us/graph/api/driveitem-delta) — only items changed since the last sync link are returned.
1. **Local changes** are tracked by comparing file modification times against the stored sync state.
1. Files are compared and sync decisions are made:

|Local state|Remote state|Action                |
|-----------|------------|----------------------|
|New        |—           |Upload                |
|Changed    |Unchanged   |Upload                |
|Unchanged  |Changed     |Download              |
|Changed    |Changed     |**Conflict** → resolve|
|Deleted    |Unchanged   |Delete remote         |
|Unchanged  |Deleted     |Delete local          |

### Sync state

The plugin stores a `syncState` record per file containing:

- `localMtime` — last known local modification time
- `remoteMtime` — last known remote modification time
- `remoteId` — OneDrive item ID (stable across renames on remote)
- `remoteEtag` — used for precise change detection
- `sha256` — content hash when available

### Token security

Tokens are stored in Obsidian’s plugin data (`.obsidian/plugins/onedrive-sync/data.json`). This file is local to your machine. The refresh token allows the plugin to silently renew the access token without re-authentication.

-----

## Commands

|Command                                  |Description      |
|-----------------------------------------|-----------------|
|`OneDrive Sync: Sync vault now`          |Manual full sync |
|`OneDrive Sync: Connect to OneDrive`     |Open auth modal  |
|`OneDrive Sync: Disconnect from OneDrive`|Clear credentials|

-----

## Troubleshooting

**“Not authenticated” error**
→ Go to Settings → OneDrive Sync → Connect

**Token refresh fails**
→ Disconnect and reconnect. This regenerates a fresh refresh token.

**Sync state seems wrong**
→ Settings → Reset State. The next sync will compare all files fresh (safe, non-destructive).

**Large vaults are slow on first sync**
→ The first sync uploads everything. Subsequent syncs use delta and are much faster.

**File appears as conflict immediately**
→ Usually means the file was edited on two devices between syncs. Use “Keep Both” to be safe, then manually merge.

-----

## Architecture

```
src/
  main.ts          # Plugin entry, lifecycle, commands, status bar
  onedrive-client.ts  # Graph API client: auth, upload, download, delta
  sync-engine.ts   # Two-way sync logic, conflict resolution, upload queue
  settings.ts      # Settings types and defaults
  settings-tab.ts  # Settings UI (PluginSettingTab)
styles.css         # Plugin styles
manifest.json      # Obsidian plugin manifest
```

-----

## License

MIT