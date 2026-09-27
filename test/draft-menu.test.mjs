import assert from "node:assert/strict";
import test from "node:test";
import { sameOptionGroups } from "../web/src/draftMenu.ts";

test("备注选项写入 jsonb 后字段顺序变化不会误报菜单更新", () => {
  const menu = [{ id: "g1", name: "口味", required: true, allowMultiple: false,
    options: [{ id: "o1", label: "微辣" }, { id: "o2", label: "中辣" }] }];
  const saved = [{ options: [{ label: "中辣", id: "o2" }, { label: "微辣", id: "o1" }],
    allowMultiple: false, required: true, name: "口味", id: "g1" }];
  assert.equal(sameOptionGroups(menu, saved), true);
  assert.equal(sameOptionGroups(menu, [{ ...saved[0], options: [{ id: "o1", label: "不辣" }] }]), false);
});
