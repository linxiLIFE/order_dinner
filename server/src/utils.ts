import crypto from "node:crypto";
import type { Response } from "express";
import type { DbClient } from "./db.js";

export function cents(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

export function positiveInt(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function businessDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function publicError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "操作失败";
  const declaredStatus = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : NaN;
  const status = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus < 600
    ? declaredStatus
    : /不存在|已被|不足|必须|不能|不允许|不匹配|过期|重复/.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
}

export function randomKey(): string {
  return crypto.randomUUID();
}

export async function getSettings(client: DbClient): Promise<Record<string, unknown>> {
  const result = await client.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM store_settings"
  );
  return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
}

export function settingNumber(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(settings[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function settingBoolean(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}
