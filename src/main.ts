import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  Modal,
  ButtonComponent,
  normalizePath,
} from "obsidian";
import { OneDriveClient } from "./onedrive-client";
import { SyncEngine } from "./sync-engine";
import { OneDriveSyncSettings, DEFAULT_SETTINGS } from "./settings";
import { OneDriveSettingTab } from "./settings-tab";

export default class OneDriveSyncPlugin extends Plugin {
  settings: OneDriveSyncSettings;
  oneDriveClient: OneDriveClient;
  syncEngine: SyncEngine;
  statusBarItem: HTMLElement;
  syncIntervalId: number | null = null;

  async onload() {
    await this.loadSettings();

    this.oneDriveClient = new OneDriveClient(this.settings);
    this.syncEngine = new SyncEngine(this.app, this.oneDriveClient, this.settings);

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar("idle");

    // Commands
    this.addCommand({
      id: "sync-now",
      name: "Sync vault with OneDrive now",
      callback: () => this.triggerSync(),
    });

    this.addCommand({
      id: "connect-onedrive",
      name: "Connect to OneDrive",
      callback: () => this.initiateAuth(),
    });

    this.addCommand({
      id: "disconnect-onedrive",
      name: "Disconnect from OneDrive",
      callback: () => this.disconnect(),
    });

    // Settings tab
    this.addSettingTab(new OneDriveSettingTab(this.app, this));

    // Auto-sync on file changes
    if (this.settings.syncOnSave) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile) {
            this.syncEngine.queueFileUpload(file.path);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile) {
            this.syncEngine.queueFileUpload(file.path);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          this.syncEngine.queueFileDelete(file.path);
        })
      );

      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.syncEngine.queueFileRename(oldPath, file.path);
        })
      );
    }

    // Periodic sync
    if (this.settings.syncIntervalMinutes > 0 && this.settings.accessToken) {
      this.startPeriodicSync();
    }

    // Initial sync on startup
    if (this.settings.syncOnStartup && this.settings.accessToken) {
      setTimeout(() => this.triggerSync(), 3000);
    }
  }

  onunload() {
    this.stopPeriodicSync();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.oneDriveClient.updateSettings(this.settings);
    this.syncEngine.updateSettings(this.settings);

    this.stopPeriodicSync();
    if (this.settings.syncIntervalMinutes > 0 && this.settings.accessToken) {
      this.startPeriodicSync();
    }
  }

  startPeriodicSync() {
    const ms = this.settings.syncIntervalMinutes * 60 * 1000;
    this.syncIntervalId = window.setInterval(() => this.triggerSync(), ms);
  }

  stopPeriodicSync() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  async triggerSync() {
    if (!this.settings.accessToken) {
      new Notice("OneDrive Sync: Not connected. Please authenticate first.");
      return;
    }

    if (this.syncEngine.isSyncing) {
      new Notice("OneDrive Sync: Sync already in progress.");
      return;
    }

    this.updateStatusBar("syncing");
    new Notice("OneDrive Sync: Starting sync...");

    try {
      // Refresh token if needed
      await this.oneDriveClient.ensureValidToken();
      const result = await this.syncEngine.runFullSync();
      this.updateStatusBar("idle");
      new Notice(
        `OneDrive Sync: Done! ↑${result.uploaded} ↓${result.downloaded} ✕${result.conflicts} conflicts`
      );
    } catch (err) {
      console.error("OneDrive Sync error:", err);
      this.updateStatusBar("error");
      new Notice(`OneDrive Sync: Error — ${err.message}`);
    }
  }

  async initiateAuth() {
    const modal = new AuthModal(this.app, this.oneDriveClient, async (tokens) => {
      this.settings.accessToken = tokens.accessToken;
      this.settings.refreshToken = tokens.refreshToken;
      this.settings.tokenExpiry = tokens.tokenExpiry;
      await this.saveSettings();
      new Notice("OneDrive Sync: Connected successfully!");
      if (this.settings.syncOnStartup) {
        setTimeout(() => this.triggerSync(), 1000);
      }
    });
    modal.open();
  }

  async disconnect() {
    this.settings.accessToken = "";
    this.settings.refreshToken = "";
    this.settings.tokenExpiry = 0;
    await this.saveSettings();
    this.stopPeriodicSync();
    new Notice("OneDrive Sync: Disconnected.");
  }

  updateStatusBar(state: "idle" | "syncing" | "error") {
    const icons = { idle: "☁️", syncing: "🔄", error: "⚠️" };
    const labels = { idle: "OneDrive", syncing: "Syncing…", error: "Sync Error" };
    this.statusBarItem.setText(`${icons[state]} ${labels[state]}`);
    this.statusBarItem.title =
      state === "idle"
        ? `Last sync: ${this.settings.lastSyncTime ? new Date(this.settings.lastSyncTime).toLocaleString() : "Never"}`
        : state === "syncing"
        ? "Sync in progress…"
        : "Click for details";
  }
}

// ─── Auth Modal ────────────────────────────────────────────────────────────────

class AuthModal extends Modal {
  private client: OneDriveClient;
  private onSuccess: (tokens: { accessToken: string; refreshToken: string; tokenExpiry: number }) => void;
  private pollInterval: number | null = null;

  constructor(app: App, client: OneDriveClient, onSuccess: (tokens: any) => void) {
    super(app);
    this.client = client;
    this.onSuccess = onSuccess;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Connect to OneDrive" });
    contentEl.createEl("p", {
      text: "Sign in with your Microsoft account to authorize Obsidian to sync with OneDrive.",
    });

    const statusEl = contentEl.createEl("p", {
      text: "Click the button below to open the Microsoft sign-in page.",
      cls: "onedrive-auth-status",
    });

    const btn = new ButtonComponent(contentEl)
      .setButtonText("Open Microsoft Sign-In")
      .setCta()
      .onClick(async () => {
        btn.setDisabled(true);
        statusEl.setText("Starting device code flow…");

        try {
          const { userCode, deviceCode, verificationUri, expiresIn } =
            await this.client.startDeviceCodeFlow();

          contentEl.empty();
          contentEl.createEl("h2", { text: "Authorize OneDrive Access" });
          contentEl.createEl("p", {
            text: "1. Open the link below (it should open automatically)",
          });

          const linkEl = contentEl.createEl("a", {
            text: verificationUri,
            href: verificationUri,
          });
          linkEl.setAttr("target", "_blank");

          contentEl.createEl("p", { text: "2. Enter this code when prompted:" });
          const codeEl = contentEl.createEl("div", {
            text: userCode,
            cls: "onedrive-device-code",
          });

          const copyBtn = new ButtonComponent(contentEl)
            .setButtonText("Copy Code")
            .onClick(() => {
              navigator.clipboard.writeText(userCode);
              new Notice("Code copied!");
            });

          contentEl.createEl("p", {
            text: `Code expires in ${Math.floor(expiresIn / 60)} minutes. Waiting for authorization…`,
            cls: "onedrive-auth-waiting",
          });

          // Open browser
          window.open(verificationUri, "_blank");

          // Poll for token
          this.pollInterval = window.setInterval(async () => {
            try {
              const tokens = await this.client.pollDeviceCode(deviceCode);
              if (tokens) {
                if (this.pollInterval) {
                  window.clearInterval(this.pollInterval);
                  this.pollInterval = null;
                }
                this.onSuccess(tokens);
                this.close();
              }
            } catch (err) {
              if (err.message !== "authorization_pending") {
                window.clearInterval(this.pollInterval!);
                this.pollInterval = null;
                new Notice(`Auth failed: ${err.message}`);
                this.close();
              }
            }
          }, 5000);
        } catch (err) {
          statusEl.setText(`Error: ${err.message} | stack: ${err.stack}`);
          btn.setDisabled(false);
        }
      });
  }

  onClose() {
    if (this.pollInterval) {
      window.clearInterval(this.pollInterval);
    }
    this.contentEl.empty();
  }
}
