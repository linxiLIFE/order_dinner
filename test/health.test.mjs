import test from "node:test";
import assert from "node:assert/strict";

test("部署健康检查地址已固定", () => {
  assert.equal(
    process.env.ORDER_DINNER_HEALTH_URL || "https://43.142.138.108:1316/healthz",
    "https://43.142.138.108:1316/healthz"
  );
});
