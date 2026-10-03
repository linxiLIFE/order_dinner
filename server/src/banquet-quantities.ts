import { requirePositiveInteger } from "./domain.js";

export function banquetTableCount(value: unknown): number {
  return requirePositiveInteger(value, "宴席桌数必须是1到1000之间的整数", 1000);
}

export function banquetQuantity(perTable: unknown, tableCount: number): number {
  const quantity = requirePositiveInteger(perTable, "每桌菜品数量必须是正整数", 100_000) * banquetTableCount(tableCount);
  return requirePositiveInteger(quantity, "宴席菜品总份数超过100000，请调整桌数或每桌数量", 100_000);
}

export function assertBanquetTotal(items: Array<{ quantity?: unknown; priceFen?: unknown }>, tableCount: number): void {
  let total = 0;
  for (const item of items) {
    const line = banquetQuantity(item.quantity, tableCount) * Number(item.priceFen);
    total += line;
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(total) || total > 2_147_483_647) {
      const error = new Error("宴席总金额超过系统支持范围，请调整桌数、菜量或菜价") as Error & { status: number };
      error.status = 400;
      throw error;
    }
  }
}

export function banquetPrintNotice(tableCount: unknown, perTable: boolean): { title: string; quantities: string } | null {
  if (tableCount === null || tableCount === undefined) return null;
  const count = banquetTableCount(tableCount);
  return { title: `宴席共 ${count} 桌`, quantities: perTable ? "以下菜量为每桌用量" : "以下菜量为全部桌合计" };
}
