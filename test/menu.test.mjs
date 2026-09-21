import assert from "node:assert/strict";
import test from "node:test";
import { OTHER_CATEGORY_DISHES } from "../server/dist/menu.js";

const dishesByName = new Map(OTHER_CATEGORY_DISHES.map(([name, priceFen, costFen]) => [name, [priceFen, costFen]]));

test("图片中的53道菜均有唯一菜单项并按金额入库为分", () => {
  assert.equal(OTHER_CATEGORY_DISHES.length, 53);
  assert.equal(dishesByName.size, 53);
  assert.deepEqual(dishesByName.get("蒜黄炒鸡蛋"), [2500, 1200]);
  assert.deepEqual(dishesByName.get("霸王鳖鸡"), [18800, 100]);
  assert.deepEqual(dishesByName.get("板栗烧土鸡"), [100, 100]);
  assert.deepEqual(dishesByName.get("红满地一品锅"), [100, 100]);
  assert.deepEqual(dishesByName.get("清蒸毛豆肉圆"), [2800, 1500]);
});
