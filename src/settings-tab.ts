import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import OneDriveSyncPlugin from "./main";

export class OneDriveSettingTab extends PluginSettingTab {
  plugin: OneDriveSyncPlugin;

  constructor(app: App, plugin: OneDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("onedrive-settings");

    // ── Connection ─────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "OneDrive Connection" });

    const isConnected = !!this.plugin.settings.accessToken;
    const statusEl = containerEl.createEl("p", {
      text: isConnected
        ? `✅ Connected (token expires ${new Date(this.plugin.settings.tokenExpiry).toLocaleString()})`
        : "❌ Not connected",
      cls: isConnected ? "onedrive-status-ok" : "onedrive-status-error",
    });

    new Setting(containerEl)
      .setName(isConnected ? "Disconnect from OneDrive" : "Connect to OneDrive")
      .setDesc(
        isConnected
          ? "Remove stored credentials and stop syncing."
          : "Sign in with your Microsoft account using the device code flow."
      )
      .addButton((btn) =>
        btn
          .setButtonText(isConnected ? "Disconnect" : "Connect")
          .setCta()
          .onClick(async () => {
            if (isConnected) {
              await this.plugin.disconnect();
            } else {
              await this.plugin.initiateAuth();
            }
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Azure App Client ID")
      .setDesc(
        'Register an app at portal.azure.com → Azure Active Directory → App registrations. Set platform to "Mobile and desktop", add redirect URI: https://login.microsoftonline.com/common/oauth2/nativeclient'
      )
      .addText((text) =>
        text
          .setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Folder ─────────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Sync Folder" });

    new Setting(containerEl)
      .setName("OneDrive folder path")
      .setDesc(
        "Remote folder in your OneDrive Personal where vault files will be stored. Must start with /."
      )
      .addText((text) =>
        text
          .setPlaceholder("/ObsidianSync")
          .setValue(this.plugin.settings.oneDriveFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.oneDriveFolderPath = value.startsWith("/")
              ? value
              : "/" + value;
            await this.plugin.saveSettings();
          })
      );

    // ── Sync Behavior ──────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Sync Behavior" });

    new Setting(containerEl)
      .setName("Sync on save")
      .setDesc("Upload files to OneDrive automatically when saved (debounced 3s).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
          this.plugin.settings.syncOnSave = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a full sync when Obsidian opens.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to automatically sync. Set to 0 to disable periodic sync.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 60, 5)
          .setValue(this.plugin.settings.syncIntervalMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalMinutes = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Conflict Resolution ────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Conflict Resolution" });

    new Setting(containerEl)
      .setName("When a conflict is detected")
      .setDesc(
        "How to handle files that have changed both locally and on OneDrive since the last sync."
      )
      .addDropdown((drop) =>
        drop
          .addOption("ask", "Ask me each time")
          .addOption("local-wins", "Always keep local version")
          .addOption("remote-wins", "Always use OneDrive version")
          .addOption("keep-both", "Keep both (create conflict copy)")
          .setValue(this.plugin.settings.conflictResolution)
          .onChange(async (value: any) => {
            this.plugin.settings.conflictResolution = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Exclusions ─────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Exclusions" });

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc(
        "Glob patterns to skip during sync, one per line. Example: .obsidian/workspace, *.tmp, private/**"
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(".obsidian/workspace\n*.tmp\n.trash/**")
          .setValue(this.plugin.settings.excludePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
      });

    new Setting(containerEl)
      .setName("Include hidden files")
      .setDesc("Sync files and folders starting with a dot (e.g. .obsidian config).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeHidden).onChange(async (value) => {
          this.plugin.settings.includeHidden = value;
          await this.plugin.saveSettings();
        })
      );

    // ── Manual Sync ────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Manual Actions" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(
        `Manually trigger a full sync. Last sync: ${
          this.plugin.settings.lastSyncTime
            ? new Date(this.plugin.settings.lastSyncTime).toLocaleString()
            : "Never"
        }`
      )
      .addButton((btn) =>
        btn
          .setButtonText("Sync Now")
          .setCta()
          .onClick(() => this.plugin.triggerSync())
      );

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc(
        "⚠️ Clears the local sync state database. Next sync will compare all files from scratch. Use if you suspect state corruption."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset State")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.syncState = {};
            this.plugin.settings.lastSyncTime = 0;
            await this.plugin.saveSettings();
            new Notice("OneDrive Sync: State reset. Next sync will do a full comparison.");
            this.display();
          })
      );
  }
}
