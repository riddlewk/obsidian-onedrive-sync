import { requestUrl } from "obsidian";
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

  async startDeviceCodeFlow(): Promise<DeviceCodeResponse> {
    const res = await requestUrl({
      url: `${AUTHORITY}/oauth2/v2.0/devicecode`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        scope: SCOPES,
      }).toString(),
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(res.json?.error_description || "Failed to start device code flow");
    }
    const data = res.json;
    return {
      userCode: data.user_code,
      deviceCode: data.device_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    };
  }

  async pollDeviceCode(deviceCode: string): Promise<{ accessToken: string; refreshToken: string; tokenExpiry: number } | null> {
    const res = await requestUrl({
      url: `${AUTHORITY}/oauth2/v2.0/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: this.settings.clientId,
        device_code: deviceCode,
      }).toString(),
      throw: false,
    });
    const data = res.json;
    if (data.error === "authorization_pending") throw new Error("authorization_pending");
    if (data.error) throw new Error(data.error_description || data.error);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiry: Date.now() + data.expires_in * 1000,
    };
  }

  async ensureValidToken(): Promise<void> {
    if (!this.settings.accessToken) throw new Error("Not authenticated.");
    if (Date.now() > this.settings.tokenExpiry - 5 * 60 * 1000) await this.refreshToken();
  }

  private async refreshToken(): Promise<void> {
    if (!this.settings.refreshToken) throw new Error("No refresh token. Please re-authenticate.");
    const res = await requestUrl({
      url: `${AUTHORITY}/oauth2/v2.0/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.settings.clientId,
        refresh_token: this.settings.refreshToken,
        scope: SCOPES,
      }).toString(),
      throw: false,
    });
    if (res.status !== 200) throw new Error("Token refresh failed. Please re-authenticate.");
    const data = res.json;
    this.settings.accessToken = data.access_token;
    if (data.refresh_token) this.settings.refreshToken = data.refresh_token;
    this.settings.tokenExpiry = Date.now() + data.expires_in * 1000;
  }

  private async graphRequest(path: string, options: any = {}, isRetry = false): Promise<any> {
    const isAbsolute = path.startsWith("http");
    const res = await requestUrl({
      url: isAbsolute ? path : `${GRAPH_BASE}${path}`,
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${this.settings.accessToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body,
      throw: false,
    });
    if (res.status === 401 && !isRetry) {
      await this.refreshToken();
      return this.graphRequest(path, options, true);
    }
    if (res.status === 204) return undefined;
    if (res.status >= 400) throw new Error(`Graph API error ${res.status}: ${res.json?.error?.message || res.status}`);
    return res.json;
  }

  async ensureFolder(folderPath: string): Promise<DriveItem> {
    const segments = folderPath.replace(/^\//, "").split("/").filter(Boolean);
    let current = "/me/drive/root";
    for (const segment of segments) {
      try {
        const item = await this.graphRequest(`${current}:/${encodeURIComponent(segment)}:`);
        current = `/me/drive/items/${item.id}`;
      } catch {
        const parent = current === "/me/drive/root" ? "/me/drive/root/children" : `${current}/children`;
        const created = await this.graphRequest(parent, {
          method: "POST",
          body: JSON.stringify({ name: segment, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
        });
        current = `/me/drive/items/${created.id}`;
      }
    }
    return this.graphRequest(current);
  }

  async listFolderDelta(folderPath: string, deltaLink?: string): Promise<{ items: DriveItem[]; nextDeltaLink: string }> {
    let url = deltaLink || `/me/drive/root:${folderPath}:/delta?$select=id,name,size,lastModifiedDateTime,eTag,file,folder,deleted,parentReference`;
    const items: DriveItem[] = [];
    let nextDeltaLink = "";
    while (url) {
      const data = await this.graphRequest(url);
      items.push(...(data.value || []));
      url = data["@odata.nextLink"] || "";
      nextDeltaLink = data["@odata.deltaLink"] || nextDeltaLink;
    }
    return { items, nextDeltaLink };
  }

  async downloadFile(itemId: string): Promise<ArrayBuffer> {
    const res = await requestUrl({
      url: `${GRAPH_BASE}/me/drive/items/${itemId}/content`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.settings.accessToken}` },
      throw: false,
    });
    if (res.status >= 400) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer;
  }

  async uploadFile(remotePath: string, content: ArrayBuffer): Promise<DriveItem> {
    if (content.byteLength <= 4 * 1024 * 1024) return this.simpleUpload(remotePath, content);
    return this.resumableUpload(remotePath, content);
  }

  private async simpleUpload(remotePath: string, content: ArrayBuffer): Promise<DriveItem> {
    const encoded = remotePath.split("/").map(encodeURIComponent).join("/");
    const res = await requestUrl({
      url: `${GRAPH_BASE}/me/drive/root:${encoded}:/content`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.settings.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: content,
      throw: false,
    });
    if (res.status >= 400) throw new Error(`Upload failed: ${res.status}`);
    return res.json;
  }

  private async resumableUpload(remotePath: string, content: ArrayBuffer): Promise<DriveItem> {
    const encoded = remotePath.split("/").map(encodeURIComponent).join("/");
    const sessionData = await this.graphRequest(`/me/drive/root:${encoded}:/createUploadSession`, {
      method: "POST",
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    });
    const uploadUrl = sessionData.uploadUrl;
    const chunkSize = 320 * 1024 * 10;
    let offset = 0;
    let lastResponse: DriveItem | null = null;
    while (offset < content.byteLength) {
      const end = Math.min(offset + chunkSize, content.byteLength);
      const chunk = content.slice(offset, end);
      const res = await requestUrl({
        url: uploadUrl,
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${offset}-${end - 1}/${content.byteLength}`,
        },
        body: chunk,
        throw: false,
      });
      if (res.status === 200 || res.status === 201) lastResponse = res.json;
      else if (res.status !== 202) throw new Error(`Upload chunk failed: ${res.status}`);
      offset = end;
    }
    return lastResponse!;
  }

  async deleteFile(itemId: string): Promise<void> {
    await this.graphRequest(`/me/drive/items/${itemId}`, { method: "DELETE" });
  }

  async moveFile(itemId: string, newParentId: string, newName: string): Promise<DriveItem> {
    return this.graphRequest(`/me/drive/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: newName, parentReference: { id: newParentId } }),
    });
  }

  async getItemByPath(remotePath: string): Promise<DriveItem | null> {
    const encoded = remotePath.split("/").map(encodeURIComponent).join("/");
    try {
      return await this.graphRequest(`/me/drive/root:${encoded}:`);
    } catch {
      return null;
    }
  }
}
