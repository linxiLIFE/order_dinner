import type { DbClient } from "./db.js";

type DraftLine = {
  dishId: string; quantity: number; note: string; options: Array<{ groupId: string; optionIds: string[] }>;
  dish: Record<string, unknown>; expectedDishName: string; expectedPriceFen: number; expectedCostFen?: number; expectedUnit: string;
};

function invalid(): never {
  throw Object.assign(new Error("待打印菜品数据不正确，请刷新后重试"), { status: 400 });
}

function identity(line: DraftLine): string {
  const options = line.options.map((selection) => ({
    groupId: selection.groupId,
    optionIds: [...selection.optionIds].sort()
  })).sort((a, b) => a.groupId.localeCompare(b.groupId));
  return `${line.dishId}:${JSON.stringify(options)}:${line.note.trim()}`;
}

function parseLine(raw: unknown): DraftLine {
  if (!raw || typeof raw !== "object") invalid();
  const input = raw as Record<string, unknown>;
  if (typeof input.dishId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.dishId)
    || typeof input.note !== "string" || input.note.length > 500
    || !Array.isArray(input.options) || input.options.length > 30
    || !input.dish || typeof input.dish !== "object" || Array.isArray(input.dish)) invalid();
  const dish = input.dish as Record<string, unknown>;
  if (dish.id !== input.dishId || typeof dish.name !== "string" || dish.name.length > 200
    || !Number.isSafeInteger(dish.price_fen) || !Number.isSafeInteger(dish.cost_fen ?? 0)) invalid();
  const options = input.options.map((rawOption) => {
    if (!rawOption || typeof rawOption !== "object") invalid();
    const option = rawOption as Record<string, unknown>;
    if (typeof option.groupId !== "string" || !Array.isArray(option.optionIds)
      || option.optionIds.length > 50 || option.optionIds.some((id) => typeof id !== "string")) invalid();
    return { groupId: option.groupId, optionIds: option.optionIds as string[] };
  });
  const quantity = input.quantity === undefined ? 1 : input.quantity;
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100_000) invalid();
  return {
    dishId: input.dishId, quantity: quantity as number, note: input.note.trim(), options, dish,
    expectedDishName: dish.name as string, expectedPriceFen: dish.price_fen as number,
    ...(dish.cost_fen == null ? {} : { expectedCostFen: dish.cost_fen as number }),
    expectedUnit: String(dish.unit || "份")
  };
}

export function changeDraft(rawLines: unknown, payload: Record<string, unknown>): DraftLine[] {
  const lines = Array.isArray(rawLines) ? rawLines.map(parseLine) : [];
  const op = payload.op;
  if (op === "clear") return [];
  if (op === "import") {
    if (!Array.isArray(payload.lines) || payload.lines.length > 300) invalid();
    for (const raw of payload.lines) {
      const imported = parseLine(raw);
      const index = lines.findIndex((candidate) => identity(candidate) === identity(imported));
      if (index < 0) lines.push(imported);
      else {
        if (lines[index].quantity + imported.quantity > 100_000) invalid();
        lines[index] = { ...lines[index], quantity: lines[index].quantity + imported.quantity };
      }
    }
    if (lines.length > 300) invalid();
    return lines;
  }
  if (op !== "adjust" && op !== "move") invalid();
  const line = parseLine(payload.line);
  const key = identity(line);
  const index = lines.findIndex((candidate) => identity(candidate) === key);
  if (op === "adjust") {
    if (payload.delta !== 1 && payload.delta !== -1) invalid();
    if (index < 0 && payload.delta === -1) invalid();
    if (index < 0) lines.push(line);
    else {
      const quantity = lines[index].quantity + payload.delta;
      if (quantity > 100_000) invalid();
      if (quantity === 0) lines.splice(index, 1);
      else lines[index] = { ...lines[index], quantity };
    }
  } else {
    const replacement = parseLine(payload.replacement);
    if (index < 0 || !Number.isSafeInteger(payload.expectedQuantity)
      || lines[index].quantity !== payload.expectedQuantity) {
      throw Object.assign(new Error("菜品已被其他设备修改，请刷新后重试"), { status: 409 });
    }
    if (identity(replacement) === key) return lines;
    const quantity = lines[index].quantity;
    lines.splice(index, 1);
    const target = lines.findIndex((candidate) => identity(candidate) === identity(replacement));
    if (target < 0) lines.push({ ...replacement, quantity });
    else {
      if (lines[target].quantity + quantity > 100_000) invalid();
      lines[target] = { ...lines[target], quantity: lines[target].quantity + quantity };
    }
  }
  if (lines.length > 300 || lines.some((candidate) => !Number.isSafeInteger(candidate.quantity) || candidate.quantity < 1 || candidate.quantity > 100_000)) invalid();
  return lines;
}

export async function prepareDraftPayload(client: DbClient, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prepared = { ...payload };
  const prepareLine = async (raw: unknown): Promise<DraftLine> => {
    const line = parseLine(raw);
    const result = await client.query<{ name: string; unit: string; price_fen: number; cost_fen: number; on_sale: boolean }>(
      `SELECT name, unit, price_fen, cost_fen, on_sale FROM dishes WHERE id = $1 FOR SHARE`, [line.dishId]
    );
    const dish = result.rows[0];
    if (!dish) invalid();
    if (payload.op !== "adjust" || payload.delta !== -1) {
      if (!dish.on_sale || dish.name !== line.dish.name || dish.unit !== line.dish.unit
        || dish.price_fen !== line.dish.price_fen) {
        throw Object.assign(new Error("菜单已更新，请重新确认待打印菜品"), { status: 409 });
      }
    }
    return parseLine({ ...line, dish: {
      ...line.dish, cost_fen: dish.cost_fen,
      gross_margin_percent: dish.price_fen > 0
        ? Math.round((dish.price_fen - dish.cost_fen) / dish.price_fen * 10000) / 100 : 0
    } });
  };
  if (payload.op === "adjust" || payload.op === "move") {
    prepared.line = await prepareLine(payload.line);
    if (payload.op === "move") prepared.replacement = await prepareLine(payload.replacement);
  } else if (payload.op === "import") {
    if (!Array.isArray(payload.lines) || payload.lines.length > 300) invalid();
    prepared.lines = [];
    for (const line of payload.lines) (prepared.lines as DraftLine[]).push(await prepareLine(line));
  }
  return prepared;
}

export function publicDraftLines(rawLines: unknown, showCost: boolean): DraftLine[] {
  const lines = Array.isArray(rawLines) ? rawLines.map(parseLine) : [];
  if (showCost) return lines;
  return lines.map((line) => ({
    ...line,
    expectedCostFen: undefined,
    dish: { ...line.dish, cost_fen: null, gross_margin_percent: null }
  }));
}
