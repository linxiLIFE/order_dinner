import assert from "node:assert/strict";
import test from "node:test";
import { assertBanquetTotal, banquetPrintNotice, banquetQuantity, banquetTableCount } from "../server/dist/banquet-quantities.js";

test("宴席按一桌配菜，正式订单份数和金额按桌数展开", () => {
  const menu = [{ quantity: 2, priceFen: 12800 }, { quantity: 1, priceFen: 5800 }];
  assertBanquetTotal(menu, 8);
  assert.equal(banquetQuantity(2, 8), 16);
  assert.equal(menu.reduce((total, item) => total + banquetQuantity(item.quantity, 8) * item.priceFen, 0), 251200);
  assert.equal(banquetQuantity(2, 1), 2);
  assert.equal(banquetQuantity(2, 3), 6);
});

test("桌数、展开后数量及所有菜品总额都不能超出系统范围", () => {
  for (const invalid of [0, -1, 1.5, 1001, null, "", NaN]) assert.throws(() => banquetTableCount(invalid));
  assert.equal(banquetTableCount(1000), 1000);
  assert.throws(() => banquetQuantity(101, 1000));
  assertBanquetTotal([{ quantity: 1, priceFen: 2147483647 }], 1);
  assert.throws(() => assertBanquetTotal([{ quantity: 1, priceFen: 2147483647 }], 2));
  assert.throws(() => assertBanquetTotal([{ quantity: 1, priceFen: 1200000000 }, { quantity: 1, priceFen: 1200000000 }], 1));
});

test("打印桌数并区分预点菜每桌用量和正式订单合计用量", () => {
  assert.deepEqual(banquetPrintNotice(8, true), { title: "宴席共 8 桌", quantities: "以下菜量为每桌用量" });
  assert.deepEqual(banquetPrintNotice(8, false), { title: "宴席共 8 桌", quantities: "以下菜量为全部桌合计" });
  assert.equal(banquetPrintNotice(undefined, false), null);
  assert.equal(banquetPrintNotice(null, false), null);
});
