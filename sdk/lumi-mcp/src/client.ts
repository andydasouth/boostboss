/**
 * Internal HTTP client. Sends MCP JSON-RPC 2.0 requests to the Boost Boss
 * MCP endpoint. Never throws on the bid path; resolves to a typed result.
 */
import { ERROR_CODES, codeForStatus, type ErrorCode } from "./errors.js";

export interface ClientResult<T> {
  ok: true;
  value: T;
}
export interface ClientError {
  ok: false;
  code: ErrorCode;
  message: string;
  status?: number;
}
export type ClientResponse<T> = ClientResult<T> | ClientError;

let _idCounter = 0;
function nextId(): number {
  _idCounter = (_idCounter + 1) & 0x7fffffff;
  return _idCounter;
}

export interface ClientOptions {
  apiBase: string;
  apiKey: string;
  timeoutMs: number;
  source: string;            // X-Lumi-Source header value
  debug: boolean;
}

export class Client {
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  /**
   * Call an MCP tool by name with structured arguments.
   * Wraps the JSON-RPC envelope; returns the unwrapped tool result on success.
   */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<ClientResponse<T>> {
    const url = this.opts.apiBase.replace(/\/$/, "") + "/api/mcp";
    const body = {
      jsonrpc: "2.0",
      id: nextId(),
      method: "tools/call",
      params: { name, arguments: args },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.opts.apiKey}`,
          "X-Lumi-Source": this.opts.source,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = e as { name?: string; message?: string };
      const code: ErrorCode = err.name === "AbortError"
        ? ERROR_CODES.TIMEOUT
        : ERROR_CODES.NETWORK;
      const message = err.message || (code === ERROR_CODES.TIMEOUT ? "request timed out" : "network error");
      this.debug(`callTool ${name} → ${code}: ${message}`);
      return { ok: false, code, message };
    }
    clearTimeout(timer);

    if (!res.ok) {
      const code = codeForStatus(res.status);
      const message = await res.text().catch(() => "").then((t) => t.slice(0, 200) || `HTTP ${res.status}`);
      this.debug(`callTool ${name} → ${code} (HTTP ${res.status}): ${message}`);
      return { ok: false, code, message, status: res.status };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (_e) {
      return { ok: false, code: ERROR_CODES.BAD_RESPONSE, message: "invalid JSON in response" };
    }

    // JSON-RPC envelope: { jsonrpc, id, result } or { jsonrpc, id, error }
    const env = json as { result?: unknown; error?: { code?: number; message?: string } };
    if (env && typeof env === "object" && env.error) {
      return {
        ok: false,
        code: ERROR_CODES.BAD_RESPONSE,
        message: env.error.message || "RPC error",
      };
    }

    return { ok: true, value: env.result as T };
  }

  private debug(msg: string): void {
    if (!this.opts.debug) return;
    // eslint-disable-next-line no-console
    console.error(`[lumi-mcp] ${msg}`);
  }
}
