import assert from "node:assert/strict";
import test from "node:test";
import {
  dishSales,
  idempotencyLockKey,
  normalizeCustomerPhone,
  publicErrorResponse,
  redactFinancialDetails,
  requireNonNegativeInteger,
  requirePositiveInteger
} from "../server/dist/domain.js";

test("幂等并发锁键可作为 PostgreSQL 文本参数，且不同作用域不混淆", () => {
  const first = idempotencyLockKey("ab", "c");
  assert.equal(first, '["ab","c"]');
  assert.equal(first.includes("\u0000"), false);
  assert.notEqual(first, idempotencyLockKey("a", "bc"));
});

test("收银员重放旧幂等响应时也会递归隐藏历史成本和毛利字段", () => {
  const legacyResponse = {
    order: { totals: { subtotalFen: 1000, costFen: 500, lossFen: 20 }, grossProfitFen: 480, grossMarginPercent: 48 },
    nested: [{ cost_fen: 500, gross_margin_percent: 48, safe: true }]
  };
  assert.deepEqual(redactFinancialDetails(legacyResponse), {
    order: { totals: { subtotalFen: 1000 }, },
    nested: [{ safe: true }]
  });
});

test("手机号先做国家区号与分隔符归一化，并拒绝只有标点的输入", () => {
  assert.equal(normalizeCustomerPhone("+86 138-1234-5678"), "13812345678");
  assert.equal(normalizeCustomerPhone("86 138 1234 5678"), "13812345678");
  assert.equal(normalizeCustomerPhone("0086 (138) 1234 5678"), "13812345678");
  assert.equal(normalizeCustomerPhone("00 (86) 138 1234 5678"), "13812345678");
  assert.equal(normalizeCustomerPhone("861234567"), "861234567");
  assert.equal(normalizeCustomerPhone("13812345678"), "13812345678");
  assert.equal(normalizeCustomerPhone(undefined), null);
  assert.equal(normalizeCustomerPhone(null), null);
  assert.equal(normalizeCustomerPhone("散客"), null);
  assert.throws(() => normalizeCustomerPhone("--- ()"), /手机号格式不正确/);
});

test("数量校验不把小数、零、负数或超限值静默替换成默认值", () => {
  assert.equal(requirePositiveInteger("4", "invalid", 10), 4);
  for (const value of [0, -1, 1.2, "2abc", "", null, false, [], {}, 11, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requirePositiveInteger(value, "invalid", 10), /invalid/);
  }
});

test("金额和顺序字段只接受范围内的非负整数", () => {
  assert.equal(requireNonNegativeInteger("0", "invalid"), 0);
  assert.equal(requireNonNegativeInteger(1200, "invalid"), 1200);
  for (const value of [-1, 1.2, "not-a-number", "", null, false, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requireNonNegativeInteger(value, "invalid"), /invalid/);
  }
});

test("销量金额按退菜和赠送后的实际付费数量计算", () => {
  assert.deepEqual(dishSales(5, 1, 2, 2500), { soldQuantity: 2, amountFen: 5000 });
  assert.deepEqual(dishSales(3, 4, 2, 100), { soldQuantity: 0, amountFen: 0 });
});

test("500 错误不向客户端泄漏内部信息，冲突错误可读且有明确状态", () => {
  assert.deepEqual(publicErrorResponse(new Error("database password leaked")), {
    status: 500,
    message: "服务器暂时无法处理请求，请稍后重试"
  });
  assert.deepEqual(publicErrorResponse({ code: "23505", detail: "secret constraint" }), {
    status: 409,
    message: "记录已存在，请刷新后重试"
  });
});
