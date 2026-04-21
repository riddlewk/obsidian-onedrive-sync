import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import { OneDriveClient, DriveItem } from "./onedrive-client";
import { OneDriveSyncSettings, FileState } from "./settings";
import { minimatch } from "minimatch";

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  errors: string[];
}

interface QueuedOp {
  type: "upload" | "delete" | "rename";
  path: string;
  newPath?: string;
  debounceTimer?: number;
}

export class SyncEngine {
  isSyncing = false;

  private app: App;
  private client: OneDriveClient;
  private settings: OneDriveSyncSettings;
  private queue: Map<string, QueuedOp> = new Map();
  private deltaLink: string = "";

  constructor(app: App, client: OneDriveClient, settings: OneDriveSyncSettings) {
    this.app = app;
    this.client = client;
    this.settings = settings;
  }

  updateSettings(settings: OneDriveSyncSettings) {
    this.settings = settings;
  }

  // ─── Queue (debounced save-time uploads) ─────────────────────────────────────

  queueFileUpload(path: string, debounceMs = 3000) {
    if (this.shouldExclude(path)) return;

    const existing = this.queue.get(path);
    if (existing?.debounceTimer) {
      window.clearTimeout(existing.debounceTimer);
    }

    const timer = window.setTimeout(() => {
      this.queue.delete(path);
      this.uploadSingleFile(path).catch(console.error);
    }, debounceMs);

    this.queue.set(path, { type: "upload", path, debounceTimer: timer });
  }

  queueFileDelete(path: string) {
    const existing = this.queue.get(path);
    if (existing?.debounceTimer) window.clearTimeout(existing.debounceTimer);
    this.queue.set(path, { type: "delete", path });
    this.deleteSingleFile(path).catch(console.error);
  }

  queueFileRename(oldPath: string, newPath: string) {
    this.queue.set(oldPath, { type: "rename", path: oldPath, newPath });
    this.renameSingleFile(oldPath, newPath).catch(console.error);
  }

  // ─── Full Two-Way Sync ────────────────────────────────────────────────────────

  async runFullSync(): Promise<SyncResult> {
    if (this.isSyncing) throw new Error("Already syncing");
    this.isSyncing = true;

    const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: [] };

    try {
      await this.client.ensureFolder(this.settings.oneDriveFolderPath);

      // 1. Get remote changes via delta
      const { items: remoteItems, nextDeltaLink } = await this.client.listFolderDelta(
        this.settings.oneDriveFolderPath,
        this.deltaLink || undefined
      );
      this.deltaLink = nextDeltaLink;

      // 2. Build remote state map
      const remoteMap = new Map<string, DriveItem>();
      for (const item of remoteItems) {
        if (!item.folder && item.parentReference) {
          const relativePath = this.remoteItemToLocalPath(item);
          if (relativePath) remoteMap.set(relativePath, item);
        }
      }

      // 3. Get all local files
      const localFiles = this.app.vault.getFiles();

      // 4. Determine what to upload (local → remote)
      for (const file of localFiles) {
        if (this.shouldExclude(file.path)) continue;

        const knownState = this.settings.syncState[file.path];
        const remoteItem = remoteMap.get(file.path);

        const localMtime = file.stat.mtime;
        const localChanged = !knownState || localMtime > knownState.localMtime;
        const remoteChanged =
          remoteItem && knownState && remoteItem.eTag !== knownState.remoteEtag;

        if (localChanged && remoteChanged) {
          // Conflict!
          const resolution = await this.resolveConflict(file, remoteItem!);
          if (resolution === "local") {
            await this.uploadFile(file, result);
          } else if (resolution === "remote") {
            await this.downloadFile(file.path, remoteItem!, result);
          } else if (resolution === "both") {
            await this.keepBothFiles(file, remoteItem!, result);
          }
          result.conflicts++;
        } else if (localChanged) {
          await this.uploadFile(file, result);
        } else if (remoteChanged && remoteItem) {
          await this.downloadFile(file.path, remoteItem, result);
        } else if (!knownState && !remoteItem) {
          // New local file not yet on remote
          await this.uploadFile(file, result);
        }

        // Remove from remoteMap so we know what's only on remote
        remoteMap.delete(file.path);
      }

      // 5. Remaining remoteMap entries = files only on remote → download
      for (const [localPath, remoteItem] of remoteMap) {
        if (this.shouldExclude(localPath)) continue;

        if (remoteItem.deleted) {
          // Remote deleted a file we have locally
          const knownState = this.settings.syncState[localPath];
          if (knownState) {
            const localFile = this.app.vault.getAbstractFileByPath(localPath);
            if (localFile instanceof TFile) {
              await this.app.vault.delete(localFile);
              delete this.settings.syncState[localPath];
              result.deleted++;
            }
          }
        } else {
          // New remote file → download
          await this.downloadFile(localPath, remoteItem, result);
        }
      }

      // 6. Check for local files deleted since last sync
      for (const [localPath, state] of Object.entries(this.settings.syncState)) {
        const localFile = this.app.vault.getAbstractFileByPath(localPath);
        if (!localFile && state.remoteId) {
          // Locally deleted → delete remote
          try {
            await this.client.deleteFile(state.remoteId);
            delete this.settings.syncState[localPath];
            result.deleted++;
          } catch (err) {
            result.errors.push(`Failed to delete remote ${localPath}: ${err.message}`);
          }
        }
      }

      this.settings.lastSyncTime = Date.now();
      await this.saveState();
    } finally {
      this.isSyncing = false;
    }

    return result;
  }

  // ─── Single-file operations ───────────────────────────────────────────────────

  private async uploadSingleFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: [] };
    await this.uploadFile(file, result);
    await this.saveState();
    if (result.errors.length) console.error("Upload errors:", result.errors);
  }

  private async deleteSingleFile(path: string) {
    const state = this.settings.syncState[path];
    if (!state?.remoteId) return;
    try {
      await this.client.ensureValidToken();
      await this.client.deleteFile(state.remoteId);
      delete this.settings.syncState[path];
      await this.saveState();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }

  private async renameSingleFile(oldPath: string, newPath: string) {
    const state = this.settings.syncState[oldPath];
    if (!state?.remoteId) return;
    try {
      await this.client.ensureValidToken();
      const newName = newPath.split("/").pop()!;
      await this.client.moveFile(state.remoteId, "", newName);
      this.settings.syncState[newPath] = { ...state };
      delete this.settings.syncState[oldPath];
      await this.saveState();
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }

  // ─── Upload / Download helpers ────────────────────────────────────────────────

  private async uploadFile(file: TFile, result: SyncResult) {
    try {
      const content = await this.app.vault.readBinary(file);
      const remotePath = `${this.settings.oneDriveFolderPath}/${file.path}`;
      const item = await this.client.uploadFile(remotePath, content);

      this.settings.syncState[file.path] = {
        localMtime: file.stat.mtime,
        remoteMtime: new Date(item.lastModifiedDateTime).getTime(),
        remoteId: item.id,
        remoteEtag: item.eTag,
        sha256: item.file?.hashes?.sha256Hash || "",
      };

      result.uploaded++;
    } catch (err) {
      result.errors.push(`Upload failed for ${file.path}: ${err.message}`);
    }
  }

  private async downloadFile(localPath: string, remoteItem: DriveItem, result: SyncResult) {
    try {
      const content = await this.client.downloadFile(remoteItem.id);
      const normalized = normalizePath(localPath);

      // Ensure parent folders exist
      const parts = normalized.split("/");
      parts.pop();
      let folderPath = "";
      for (const part of parts) {
        folderPath = folderPath ? `${folderPath}/${part}` : part;
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
          await this.app.vault.createFolder(folderPath);
        }
      }

      const existing = this.app.vault.getAbstractFileByPath(normalized);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, content);
      } else {
        await this.app.vault.createBinary(normalized, content);
      }

      const writtenFile = this.app.vault.getAbstractFileByPath(normalized) as TFile;
      this.settings.syncState[localPath] = {
        localMtime: writtenFile?.stat.mtime || Date.now(),
        remoteMtime: new Date(remoteItem.lastModifiedDateTime).getTime(),
        remoteId: remoteItem.id,
        remoteEtag: remoteItem.eTag,
        sha256: remoteItem.file?.hashes?.sha256Hash || "",
      };

      result.downloaded++;
    } catch (err) {
      result.errors.push(`Download failed for ${localPath}: ${err.message}`);
    }
  }

  private async keepBothFiles(file: TFile, remoteItem: DriveItem, result: SyncResult) {
    // Download remote as a conflicted copy
    const ext = file.extension;
    const base = file.basename;
    const conflictPath = normalizePath(
      `${file.parent?.path || ""}/${base} (OneDrive conflict ${Date.now()}).${ext}`
    );
    await this.downloadFile(conflictPath, remoteItem, result);
    // Keep local version as canonical
    await this.uploadFile(file, result);
  }

  // ─── Conflict resolution ──────────────────────────────────────────────────────

  private resolveConflict(file: TFile, remoteItem: DriveItem): Promise<"local" | "remote" | "both"> {
    const resolution = this.settings.conflictResolution;
    if (resolution === "local-wins") return Promise.resolve("local");
    if (resolution === "remote-wins") return Promise.resolve("remote");
    if (resolution === "keep-both") return Promise.resolve("both");

    // "ask" — show modal
    return new Promise((resolve) => {
      const modal = new ConflictModal(this.app, file, remoteItem, resolve);
      modal.open();
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private shouldExclude(path: string): boolean {
    for (const pattern of this.settings.excludePatterns) {
      if (minimatch(path, pattern)) return true;
    }
    if (!this.settings.includeHidden && path.startsWith(".")) return true;
    return false;
  }

  private remoteItemToLocalPath(item: DriveItem): string | null {
    if (!item.parentReference?.path) return null;
    // OneDrive paths look like: /drive/root:/ObsidianSync/notes/file.md
    const rootMarker = this.settings.oneDriveFolderPath;
    const fullPath = decodeURIComponent(item.parentReference.path);
    const markerIndex = fullPath.indexOf(rootMarker);
    if (markerIndex === -1) return null;
    const relativeFolderPath = fullPath.slice(markerIndex + rootMarker.length).replace(/^\//, "");
    return relativeFolderPath ? `${relativeFolderPath}/${item.name}` : item.name;
  }

  private async saveState() {
    // Persist via plugin's saveData (accessed through the settings object)
    // The plugin calls saveSettings after sync which persists this.
    // For real-time persistence on queue ops, emit a custom event.
    window.dispatchEvent(new CustomEvent("onedrive-sync-save-state"));
  }
}

// ─── Conflict Modal ───────────────────────────────────────────────────────────

class ConflictModal extends Modal {
  private file: TFile;
  private remoteItem: DriveItem;
  private resolve: (choice: "local" | "remote" | "both") => void;

  constructor(
    app: App,
    file: TFile,
    remoteItem: DriveItem,
    resolve: (choice: "local" | "remote" | "both") => void
  ) {
    super(app);
    this.file = file;
    this.remoteItem = remoteItem;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("onedrive-conflict-modal");
    contentEl.createEl("h2", { text: "⚠️ Sync Conflict" });
    contentEl.createEl("p", {
      text: `Both the local and OneDrive versions of "${this.file.name}" have changed since the last sync.`,
    });

    const table = contentEl.createEl("table");
    const header = table.createEl("tr");
    header.createEl("th", { text: "Version" });
    header.createEl("th", { text: "Modified" });
    header.createEl("th", { text: "Size" });

    const localRow = table.createEl("tr");
    localRow.createEl("td", { text: "📱 Local" });
    localRow.createEl("td", { text: new Date(this.file.stat.mtime).toLocaleString() });
    localRow.createEl("td", { text: this.formatSize(this.file.stat.size) });

    const remoteRow = table.createEl("tr");
    remoteRow.createEl("td", { text: "☁️ OneDrive" });
    remoteRow.createEl("td", {
      text: new Date(this.remoteItem.lastModifiedDateTime).toLocaleString(),
    });
    remoteRow.createEl("td", { text: this.formatSize(this.remoteItem.size) });

    const btnContainer = contentEl.createEl("div", { cls: "onedrive-conflict-buttons" });

    const makeBtn = (label: string, choice: "local" | "remote" | "both", cta = false) => {
      const btn = btnContainer.createEl("button", { text: label });
      if (cta) btn.addClass("mod-cta");
      btn.addEventListener("click", () => {
        this.resolve(choice);
        this.close();
      });
    };

    makeBtn("Keep Local Version", "local", true);
    makeBtn("Use OneDrive Version", "remote");
    makeBtn("Keep Both (create conflict copy)", "both");
  }

  onClose() {
    this.contentEl.empty();
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
