export class InputError extends Error {
  status = 400;

  constructor(message: string) {
    super(message);
  }
}

export function idempotencyLockKey(scope: string, requestKey: string): string {
  return JSON.stringify([scope, requestKey]);
}

const privateFinancialKeys = new Set([
  "costFen",
  "cost_fen",
  "lossFen",
  "loss_fen",
  "grossProfitFen",
  "gross_profit_fen",
  "grossMarginPercent",
  "gross_margin_percent"
]);

export function redactFinancialDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFinancialDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !privateFinancialKeys.has(key))
      .map(([key, nested]) => [key, redactFinancialDetails(nested)])
  );
}

export function normalizeCustomerPhone(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InputError("手机号格式不正确");
  const raw = value.trim();
  if (!raw || raw === "散客") return null;
  if (!/^\+?[0-9\s().-]+$/.test(raw)) throw new InputError("手机号格式不正确");

  let digits = raw.replace(/\D/g, "");
  if (!digits) throw new InputError("手机号格式不正确");
  if (digits.startsWith("0086")) {
    digits = digits.slice(4);
  } else if (digits.length === 13 && digits.startsWith("86")) {
    digits = digits.slice(2);
  }
  if (digits.length < 7 || digits.length > 15) throw new InputError("手机号格式不正确");
  return digits;
}

export function requirePositiveInteger(value: unknown, message: string, max = 2_147_483_647): number {
  const parsed = parseIntegerValue(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new InputError(message);
  return parsed;
}

export function requireNonNegativeInteger(value: unknown, message: string, max = 2_147_483_647): number {
  const parsed = parseIntegerValue(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new InputError(message);
  return parsed;
}

function parseIntegerValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value.trim())) return Number.NaN;
  return Number(value.trim());
}

export function dishSales(quantity: number, returned: number, gifted: number, priceFen: number) {
  const safeQuantity = Math.max(0, Math.trunc(quantity));
  const safeReturned = Math.min(safeQuantity, Math.max(0, Math.trunc(returned)));
  const safeGifted = Math.min(safeQuantity - safeReturned, Math.max(0, Math.trunc(gifted)));
  const soldQuantity = safeQuantity - safeReturned - safeGifted;
  return { soldQuantity, amountFen: soldQuantity * Math.max(0, Math.trunc(priceFen)) };
}

export function averageFen(revenueFen: number, orderCount: number): number {
  return orderCount > 0 ? Math.round(revenueFen / orderCount) : 0;
}

export function ratioPercent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 10_000) / 100 : 0;
}

export function fenAsYuan(value: number | string | null | undefined): string {
  const fen = Number(value || 0);
  return (Number.isFinite(fen) ? fen / 100 : 0).toFixed(2);
}

export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvDocument(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function publicErrorResponse(error: unknown): { status: number; message: string } {
  const errorRecord = typeof error === "object" && error !== null
    ? error as { status?: unknown; code?: unknown }
    : null;
  const declaredStatus = errorRecord
    ? Number(errorRecord.status)
    : NaN;
  const status = errorRecord?.code === "23505" || errorRecord?.code === "23503"
    ? 409
    : errorRecord?.code === "22003"
    ? 400
    : Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus < 600
      ? declaredStatus
      : 500;
  if (status >= 500) return { status, message: "服务器暂时无法处理请求，请稍后重试" };
  return {
    status,
    message: errorRecord?.code === "23505"
      ? "记录已存在，请刷新后重试"
      : errorRecord?.code === "23503"
        ? "记录仍被其他业务数据引用，不能删除"
        : errorRecord?.code === "22003"
          ? "金额或数量超过系统支持范围"
          : error instanceof Error ? error.message : "请求内容不正确"
  };
}
