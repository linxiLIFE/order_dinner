import assert from 'node:assert/strict';
import test from 'node:test';
process.env.JWT_SECRET='business-ai-unit-test-secret-32-characters';
const {comparisonRanges}=await import('../server/dist/business-ai.js');
test('营业分析比较周期等长且跨月连续',()=>{
  assert.deepEqual(comparisonRanges('2026-03-01','2026-03-07'),{previous:{from:'2026-02-22',to:'2026-02-28'},year:{from:'2025-03-01',to:'2025-03-07'}});
  assert.deepEqual(comparisonRanges('2026-01-01','2026-01-01').previous,{from:'2025-12-31',to:'2025-12-31'});
});
test('闰日同比回落到二月最后一天',()=>{
  assert.deepEqual(comparisonRanges('2024-02-29','2024-03-02').year,{from:'2023-02-28',to:'2023-03-02'});
});
