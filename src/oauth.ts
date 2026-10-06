// OAuth 2.0 refresh-token client shared by the Gmail and Graph adapters.
// Holds one refresh token, caches the access token, retries a 401 once.
export interface OAuthConfig {
  token_url: string;
  client_id: string;
  client_secret?: string | undefined;
  refresh_token: string;
  scope?: string | undefined;
}

export class OAuthClient {
  private access: { token: string; expires: number } | null = null;

  constructor(private cfg: OAuthConfig) {}

  async token(force = false): Promise<string> {
    if (!force && this.access && this.access.expires > Date.now() + 60_000) return this.access.token;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.cfg.refresh_token,
      client_id: this.cfg.client_id,
      ...(this.cfg.client_secret ? { client_secret: this.cfg.client_secret } : {}),
      ...(this.cfg.scope ? { scope: this.cfg.scope } : {}),
    });
    const r = await fetch(this.cfg.token_url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const e: any = new Error(`token refresh failed: ${r.status} ${j.error ?? ""} ${j.error_description ?? ""}`.trim());
      e.authenticationFailed = r.status === 400 || r.status === 401; // invalid_grant: the refresh token is dead
      throw e;
    }
    this.access = { token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.access.token;
  }

  /** Authenticated fetch. Refreshes and retries once on 401. Throws with authenticationFailed when auth is gone. */
  async fetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await this.token();
    const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    if (r.status === 401 && retry) {
      await this.token(true);
      return this.fetch(url, init, false);
    }
    if (r.status === 401) {
      const e: any = new Error("unauthorized after token refresh");
      e.authenticationFailed = true;
      throw e;
    }
    return r;
  }

  /** JSON helper: throws on non-2xx with the provider's error text. 404 is returned as null when `allow404`. */
  async json<T = any>(url: string, init: RequestInit = {}, allow404 = false): Promise<T | null> {
    const r = await this.fetch(url, init);
    if (r.status === 404 && allow404) return null;
    if (r.status === 204) return null;
    const text = await r.text();
    if (!r.ok) {
      const e: any = new Error(`${init.method ?? "GET"} ${url.replace(/\?.*/, "")} -> ${r.status} ${text.slice(0, 200)}`);
      e.status = r.status;
      e.rateLimited = r.status === 429 || (r.status === 403 && /rate|quota/i.test(text));
      throw e;
    }
    return text ? (JSON.parse(text) as T) : null;
  }
}
