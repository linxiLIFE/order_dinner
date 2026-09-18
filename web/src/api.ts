export type User = { id: string; username: string; name: string; role: "OWNER" | "CASHIER" };

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
  if (!response.ok) throw new Error(body.error || "请求失败，请稍后再试");
  return body as T;
}

export function requestKey(scope: string): string {
  const key = `${scope}-${crypto.randomUUID()}`;
  return key;
}

export function money(fen: number | string | null | undefined): string {
  return `¥${(Number(fen || 0) / 100).toFixed(2)}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function businessDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
