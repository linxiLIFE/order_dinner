import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { changeDraft, prepareDraftPayload, publicDraftLines } from "../server/dist/draft.js";

const dishId = randomUUID();
const dish = { id: dishId, name: "测试菜", unit: "份", price_fen: 1800, cost_fen: null, option_groups: [] };
const line = { dishId, quantity: 1, note: "", options: [], dish };
const db = { query: async () => ({ rows: [{ name: dish.name, unit: dish.unit, price_fen: 1800, cost_fen: 700, on_sale: true }] }) };

test("两个员工依次加同一道菜会累加，改备注不会丢失其他修改", async () => {
  const first = await prepareDraftPayload(db, { op: "adjust", delta: 1, line });
  let lines = changeDraft([], first);
  lines = changeDraft(lines, first);
  assert.equal(lines[0].quantity, 2);
  const publicLines = publicDraftLines(lines, false);
  assert.equal(publicLines[0].dish.cost_fen, null);
  assert.equal(publicDraftLines(lines, true)[0].dish.cost_fen, 700);
  lines = changeDraft(lines, { op: "move", line, expectedQuantity: 2, replacement: { ...line, note: "少盐" } });
  assert.equal(lines[0].note, "少盐");
  assert.equal(lines[0].quantity, 2);
  assert.throws(() => changeDraft(lines, { op: "move", line: { ...line, note: "少盐" }, expectedQuantity: 1,
    replacement: { ...line, note: "多辣" } }), /其他设备修改/);
});

test("旧版草稿合并与菜单变更校验", async () => {
  const current = changeDraft([], { op: "adjust", delta: 1, line });
  const merged = changeDraft(current, { op: "import", lines: [{ ...line, quantity: 3 }] });
  assert.equal(merged[0].quantity, 4);
  await assert.rejects(() => prepareDraftPayload(db, { op: "adjust", delta: 1,
    line: { ...line, dish: { ...dish, price_fen: 1900 } } }), /菜单已更新/);
});
