import { OneDriveSyncSettings } from "./settings";

const AUTHORITY = "https://login.microsoftonline.com/consumers";
const SCOPES = ["Files.ReadWrite", "offline_access"].join(" ");
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface DriveItem {
  id: string;
  name: string;
  size: number;
  lastModifiedDateTime: string;
  eTag: string;
  file?: { mimeType: string; hashes?: { sha256Hash?: string } };
  folder?: { childCount: number };
  deleted?: {};
  parentReference?: { path: string };
}

export interface DeviceCodeResponse {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export class OneDriveClient {
  private settings: OneDriveSyncSettings;

  constructor(settings: OneDriveSyncSettings) {
    this.settings = settings;
  }

  updateSettings(settings: OneDriveSyncSettings) {
    this.settings = settings;
  }

  // ─── Auth: Device Code Flow ──────────────────────────────────────────────────

  async startDeviceCodeFlow(): Promise<DeviceCodeResponse> {
    const res = await fetch(`${AUTHORITY}/oauth2/v2.0/devicecode`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        scope: SCOPES,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error_description || "Failed to start device code flow");
    }

    const data = await res.json();
    return {
      userCode: data.user_code,
      deviceCode: data.device_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    };
  }

  async pollDeviceCode(
    deviceCode: string
  ): Promise<{ accessToken: string; refreshToken: string; tokenExpiry: number } | null> {
    const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: this.settings.clientId,
        device_code: deviceCode,
      }),
    });

    const data = await res.json();

    if (data.error === "authorization_pending") {
      throw new Error("authorization_pending");
    }

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiry: Date.now() + data.expires_in * 1000,
    };
  }

  // ─── Token Management ────────────────────────────────────────────────────────

  async ensureValidToken(): Promise<void> {
    if (!this.settings.accessToken) {
      throw new Error("Not authenticated. Please connect to OneDrive.");
    }

    // Refresh if within 5 minutes of expiry
    if (Date.now() > this.settings.tokenExpiry - 5 * 60 * 1000) {
      await this.refreshToken();
    }
  }

  private async refreshToken(): Promise<void> {
    if (!this.settings.refreshToken) {
      throw new Error("No refresh token. Please re-authenticate.");
    }

    const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.settings.clientId,
        refresh_token: this.settings.refreshToken,
        scope: SCOPES,
      }),
    });

    if (!res.ok) {
      throw new Error("Token refresh failed. Please re-authenticate.");
    }

    const data = await res.json();
    this.settings.accessToken = data.access_token;
    if (data.refresh_token) {
      this.settings.refreshToken = data.refresh_token;
    }
    this.settings.tokenExpiry = Date.now() + data.expires_in * 1000;
  }

  // ─── Graph API helpers ───────────────────────────────────────────────────────

  private async graphFetch(
    path: string,
    options: RequestInit = {},
    isRetry = false
  ): Promise<Response> {
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.settings.accessToken}`,
        ...(options.headers || {}),
      },
    });

    if (res.status === 401 && !isRetry) {
      await this.refreshToken();
      return this.graphFetch(path, options, true);
    }

    return res;
  }

  private async graphJSON<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await this.graphFetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        `Graph API error ${res.status}: ${err?.error?.message || res.statusText}`
      );
    }

    if (res.status === 204) return undefined as unknown as T;
    return res.json();
  }

  // ─── Folder Operations ───────────────────────────────────────────────────────

  /** Ensure a folder path exists on OneDrive, creating missing segments. */
  async ensureFolder(folderPath: string): Promise<DriveItem> {
    const segments = folderPath.replace(/^\//, "").split("/").filter(Boolean);
    let current = "/me/drive/root";

    for (const segment of segments) {
      const encodedPath = `${current}:/${encodeURIComponent(segment)}:`;
      try {
        const item = await this.graphJSON<DriveItem>(encodedPath);
        current = `/me/drive/items/${item.id}`;
      } catch {
        // Create the folder
        const parent =
          current === "/me/drive/root"
            ? "/me/drive/root/children"
            : `${current}/children`;
        const created = await this.graphJSON<DriveItem>(parent, {
          method: "POST",
          body: JSON.stringify({ name: segment, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
        });
        current = `/me/drive/items/${created.id}`;
      }
    }

    return this.graphJSON<DriveItem>(current);
  }

  // ─── File Operations ─────────────────────────────────────────────────────────

  /** List all items (recursively) in a remote folder using delta. */
  async listFolderDelta(
    folderPath: string,
    deltaLink?: string
  ): Promise<{ items: DriveItem[]; nextDeltaLink: string }> {
    const startUrl = deltaLink
      ? deltaLink
      : `/me/drive/root:${folderPath}:/delta?$select=id,name,size,lastModifiedDateTime,eTag,file,folder,deleted,parentReference`;

    let url = startUrl;
    const items: DriveItem[] = [];
    let nextDeltaLink = "";

    while (url) {
      const isAbsolute = url.startsWith("http");
      const res = isAbsolute
        ? await fetch(url, { headers: { Authorization: `Bearer ${this.settings.accessToken}` } })
        : await this.graphFetch(url);

      if (!res.ok) {
        throw new Error(`Delta listing failed: ${res.statusText}`);
      }

      const data = await res.json();
      items.push(...(data.value || []));
      url = data["@odata.nextLink"] || "";
      nextDeltaLink = data["@odata.deltaLink"] || nextDeltaLink;
    }

    return { items, nextDeltaLink };
  }

  /** Download a file's content as ArrayBuffer. */
  async downloadFile(itemId: string): Promise<ArrayBuffer> {
    const res = await this.graphFetch(`/me/drive/items/${itemId}/content`);
    if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
    return res.arrayBuffer();
  }

  /** Upload a file using simple upload (≤4 MB) or resumable session (>4 MB). */
  async uploadFile(remotePath: string, content: ArrayBuffer): Promise<DriveItem> {
    const MB4 = 4 * 1024 * 1024;

    if (content.byteLength <= MB4) {
      return this.simpleUpload(remotePath, content);
    } else {
      return this.resumableUpload(remotePath, content);
    }
  }

  private async simpleUpload(remotePath: string, content: ArrayBuffer): Promise<DriveItem> {
    const encoded = remotePath.split("/").map(encodeURIComponent).join("/");
    return this.graphJSON<DriveItem>(
      `/me/drive/root:${encoded}:/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: content,
      }
    );
  }

  private async resumableUpload(remotePath: string, content: ArrayBuffer): Promise<DriveItem> {
    const encoded = remotePath.split("/").map(encodeURIComponent).join("/");

    // Create upload session
    const sessionRes = await this.graphJSON<{ uploadUrl: string }>(
      `/me/drive/root:${encoded}:/createUploadSession`,
      {
        method: "POST",
        body: JSON.stringify({
          item: { "@microsoft.graph.conflictBehavior": "replace" },
        }),
      }
    );

    const uploadUrl = sessionRes.uploadUrl;
    const chunkSize = 320 * 1024 * 10; // 3.2 MB chunks (must be multiple of 320 KiB)
    let offset = 0;
    let lastResponse: DriveItem | null = null;

    while (offset < content.byteLength) {
      const end = Math.min(offset + chunkSize, content.byteLength);
      const chunk = content.slice(offset, end);

      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${offset}-${end - 1}/${content.byteLength}`,
        },
        body: chunk,
      });

      if (res.status === 200 || res.status === 201) {
        lastResponse = await res.json();
      } else if (res.status !== 202) {
        throw new Error(`Resumable upload chunk failed: ${res.statusText}`);
      }

      offset = end;
    }

    return lastResponse!;
  }

  /** Delete a file by item ID. */
  async deleteFile(itemId: string): Promise<void> {
    await this.graphJSON<void>(`/me/drive/items/${itemId}`, { method: "DELETE" });
  }

  /** Move/rename a file. */
  async moveFile(itemId: string, newParentId: string, newName: string): Promise<DriveItem> {
    return this.graphJSON<DriveItem>(`/me/drive/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: newName,
        parentReference: { id: newParentId },
      }),
    });
  }

  /** Get metadata for a single item by remote path. */
  async getItemByPath(remotePath: string): Promise<DriveItem | null> {
    const encoded = remotePath.split("/").map(encodeURIComponent).join("/");
    try {
      return await this.graphJSON<DriveItem>(`/me/drive/root:${encoded}:`);
    } catch {
      return null;
    }
  }
}
