export interface OneDriveSyncSettings {
  // Auth
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  clientId: string;

  // Sync config
  oneDriveFolderPath: string;   // e.g. "/ObsidianVault/MyVault"
  syncOnSave: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;  // 0 = disabled

  // Conflict resolution
  conflictResolution: "ask" | "local-wins" | "remote-wins" | "keep-both";

  // Filters
  excludePatterns: string[];    // glob patterns to skip
  includeHidden: boolean;

  // State
  lastSyncTime: number;         // ms epoch
  syncState: Record<string, FileState>; // path → state
}

export interface FileState {
  localMtime: number;     // ms
  remoteMtime: number;    // ms
  remoteId: string;       // OneDrive item ID
  remoteEtag: string;     // for change detection
  sha256: string;         // content hash
}

export const DEFAULT_SETTINGS: OneDriveSyncSettings = {
  accessToken: "",
  refreshToken: "",
  tokenExpiry: 0,
  clientId: "YOUR_CLIENT_ID", // Users register their own Azure app

  oneDriveFolderPath: "/ObsidianSync",
  syncOnSave: true,
  syncOnStartup: true,
  syncIntervalMinutes: 15,

  conflictResolution: "ask",

  excludePatterns: [".obsidian/workspace", ".obsidian/cache", ".trash/**", "*.tmp"],
  includeHidden: false,

  lastSyncTime: 0,
  syncState: {},
};
