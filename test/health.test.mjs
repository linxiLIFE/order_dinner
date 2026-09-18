import test from "node:test";
import assert from "node:assert/strict";

test("部署健康检查地址已固定", () => {
  assert.equal(
    process.env.ORDER_DINNER_HEALTH_URL || "https://dinner.20-48-27-179.sslip.io:1314/healthz",
    "https://dinner.20-48-27-179.sslip.io:1314/healthz"
  );
});
