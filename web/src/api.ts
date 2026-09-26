export type User = { id: string; username: string; name: string; role: "OWNER" | "CASHIER" };

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export type PendingIdempotentRequest = {
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

const tokenKey = "order-dinner-token";
let authToken = localStorage.getItem(tokenKey) || "";

export function getToken(): string {
  return authToken;
}

export function setToken(token: string): void {
  authToken = token;
  if (token) localStorage.setItem(tokenKey, token);
  else localStorage.removeItem(tokenKey);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    setToken("");
    window.dispatchEvent(new Event("点单台登录失效"));
  }
  if (!response.ok) throw new ApiError(body.error || "请求失败，请稍后再试", response.status);
  return body as T;
}

function currentEmployeeId(): string {
  try {
    const payload = authToken.split(".")[1];
    if (!payload) return "anonymous";
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { id?: unknown };
    return typeof decoded.id === "string" && decoded.id ? decoded.id : "anonymous";
  } catch {
    return "anonymous";
  }
}

function requestStorageKey(scope: string): string {
  return `order-dinner-pending-request:${encodeURIComponent(currentEmployeeId())}:${encodeURIComponent(scope)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function getPendingIdempotentRequest(scope: string): PendingIdempotentRequest | null {
  const serialized = localStorage.getItem(requestStorageKey(scope));
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as PendingIdempotentRequest;
    if (typeof value.idempotencyKey !== "string" || !value.idempotencyKey || !value.payload || typeof value.payload !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

export function prepareIdempotentRequest(scope: string, payload: Record<string, unknown>): PendingIdempotentRequest {
  const previous = getPendingIdempotentRequest(scope);
  if (previous) {
    if (canonicalJson(previous.payload) !== canonicalJson(payload)) {
      throw new ApiError("上一笔操作结果尚未确认，当前内容与上次不同；请先核对业务状态后再继续", 409);
    }
    return previous;
  }
  const request = { idempotencyKey: crypto.randomUUID(), payload };
  try {
    localStorage.setItem(requestStorageKey(scope), JSON.stringify(request));
  } catch {
    throw new Error("无法保存本次请求编号，请检查本机存储空间后重试");
  }
  return request;
}

export function clearIdempotentRequest(scope: string, idempotencyKey?: string): void {
  const storageKey = requestStorageKey(scope);
  const pending = getPendingIdempotentRequest(scope);
  if (!idempotencyKey || pending?.idempotencyKey === idempotencyKey) localStorage.removeItem(storageKey);
}

export async function idempotentApi<T>(path: string, scope: string, payload: Record<string, unknown>): Promise<T> {
  const request = prepareIdempotentRequest(scope, payload);
  try {
    const result = await api<T>(path, {
      method: "POST",
      body: JSON.stringify({ ...request.payload, idempotencyKey: request.idempotencyKey })
    });
    clearIdempotentRequest(scope, request.idempotencyKey);
    return result;
  } catch (error) {
    const crossAccountConflict = error instanceof ApiError && error.status === 409
      && error.message.includes("请求编号已被其他账号使用");
    if (crossAccountConflict) {
      clearIdempotentRequest(scope, request.idempotencyKey);
      window.dispatchEvent(new CustomEvent("点单台幂等请求冲突", { detail: { scope } }));
      throw new ApiError("该请求属于其他员工，请确认当前订单状态", 409);
    } else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429
      && !error.message.includes("上次请求尚未确认且内容已变化")) {
      clearIdempotentRequest(scope, request.idempotencyKey);
    }
    throw error;
  }
}

export function money(fen: number | string | null | undefined): string {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(parsed);
}

export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const response = await fetch(path, { headers });
  if (response.status === 401) {
    setToken("");
    window.dispatchEvent(new Event("点单台登录失效"));
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || "导出失败，请稍后再试", response.status);
  }
  const filenameStar = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filenameQuoted = response.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/i)?.[1];
  const filename = filenameStar ? decodeURIComponent(filenameStar) : filenameQuoted || fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function businessDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
