import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDatabaseUrl = process.env.ORDER_DINNER_TEST_DATABASE_URL || "";

function safeTestDatabaseUrl(value) {
  const parsed = new URL(value);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(parsed.hostname) || !/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error("集成测试只允许使用本机且数据库名包含 test 的 ORDER_DINNER_TEST_DATABASE_URL");
  }
  return parsed;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配本地测试端口");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(baseUrl, child, getOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`测试服务提前退出：${getOutput()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The app may still be applying its isolated test-schema migrations.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务启动超时：${getOutput()}`);
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timeout;
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); })
  ]);
  clearTimeout(timeout);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
  }
}

test("PostgreSQL 集成回归：并发开台、幂等加菜、撤销重结、打印与生产菜单", {
  skip: !testDatabaseUrl && "设置本机 ORDER_DINNER_TEST_DATABASE_URL 后运行隔离数据库集成测试"
}, async (t) => {
  const adminUrl = safeTestDatabaseUrl(testDatabaseUrl);
  const schema = `codex_test_${randomUUID().replaceAll("-", "")}`;
  const quotedSchema = `"${schema}"`;
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 2 });
  let appPool;
  let child;
  let migrationPool;
  let schemaCreated = false;
  let childOutput = "";

  t.after(async () => {
    await stopProcess(child);
    if (appPool) await appPool.end();
    if (migrationPool) await migrationPool.end();
    if (schemaCreated) await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await adminPool.end();
  });

  await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
  schemaCreated = true;
  const appUrl = new URL(adminUrl);
  appUrl.searchParams.set("options", `-c search_path=${schema},public`);
  appPool = new Pool({ connectionString: appUrl.toString(), max: 3 });

  const port = await reservePort();
  const ownerUsername = `codex_owner_${randomBytes(5).toString("hex")}`;
  const ownerPassword = randomBytes(18).toString("hex");
  const jwtSecret = randomBytes(48).toString("hex");
  const entry = path.join(projectRoot, "server", "dist", "index.js");
  child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "",
      DATABASE_URL: appUrl.toString(),
      JWT_SECRET: jwtSecret,
      BOOTSTRAP_ADMIN_USERNAME: ownerUsername,
      BOOTSTRAP_ADMIN_PASSWORD: ownerPassword,
      SEED_DEMO_DATA: "false",
      NODE_ENV: "test",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-12_000); });
  child.stderr.on("data", (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-12_000); });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, () => childOutput);

  async function request(urlPath, { token, body, headers = {}, method } = {}) {
    const requestHeaders = new Headers(headers);
    if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
    if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  const login = await request("/api/auth/login", { body: { username: ownerUsername, password: ownerPassword } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const ownerToken = login.body.token;

  const aiCreate = await request("/api/business-ai/chats", {token: ownerToken, body:{from:"2026-01-01",to:"2026-01-07"}});
  assert.equal(aiCreate.status,200,JSON.stringify(aiCreate.body));
  const aiDetail = await request(`/api/business-ai/chats/${aiCreate.body.id}`,{token:ownerToken});
  assert.equal(aiDetail.status,200);
  assert.equal(aiDetail.body.chat.context.previous.range.to,"2025-12-31");
  const aiMemory = await request("/api/business-ai/memory/profile",{token:ownerToken,method:"PUT",body:{text:"测试商圈，周末营业"}});
  assert.equal(aiMemory.status,200);
  const savedMemory = await request("/api/business-ai/memory",{token:ownerToken});
  assert.ok(savedMemory.body.memories.some(m=>m.key==="profile" && m.content==="测试商圈，周末营业"));
  assert.equal((await request("/api/business-ai/chats",{token:ownerToken,body:{from:"2026-02-30",to:"2026-03-01"}})).status,400);
  assert.equal((await request("/api/business-ai/chats",{token:ownerToken,body:{from:"2026-03-02",to:"2026-03-01"}})).status,400);
  assert.equal((await request("/api/business-ai/chats")).status,401);
  assert.equal((await request(`/api/business-ai/chats/${aiCreate.body.id}/messages`,{token:ownerToken,body:{requestId:randomUUID(),text:"测试",images:[]}})).status,503);

  // Exercise the real router and PostgreSQL persistence with a deterministic streaming provider.
  process.env.DATABASE_URL=appUrl.toString();
  process.env.JWT_SECRET=jwtSecret;
  process.env.DEEPSEEK_API_KEY="test-only-not-a-real-key";
  const [{default:express},{businessAiRouter,runAiMigrations},aiDb]=await Promise.all([import("express"),import("../server/dist/business-ai.js"),import("../server/dist/db.js")]);
  migrationPool=aiDb.pool;
  let providerBody, providerMode="complete";
  const fakeProvider=async (_url,init)=>{
    providerBody=JSON.parse(init.body);
    const chunks=[{choices:[{delta:{reasoning_content:"思考"}}]},{choices:[{delta:{content:"## 经营分析\n\n营业额 ¥10"}}]},{choices:[{delta:{content:"0，优先改善复购。"}}]},{choices:[{delta:{},finish_reason:"stop"}],usage:{total_tokens:42}}];
    const encoded=new TextEncoder().encode(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join("")+(providerMode==="complete"?"data: [DONE]\n\n":""));
    let i=0;
    return new Response(new ReadableStream({pull(c){if(i>=encoded.length)return c.close();c.enqueue(encoded.slice(i,i+7));i+=7;}}),{status:200});
  };
  const mockApp=express();mockApp.use("/api/business-ai",businessAiRouter(async (_client,from,to)=>({range:{from,to},summary:{revenueFen:10000}}),fakeProvider));
  const mockServer=mockApp.listen(0,"127.0.0.1");
  await new Promise(resolve=>mockServer.once("listening",resolve));
  const mockBase=`http://127.0.0.1:${mockServer.address().port}/api/business-ai`;
  async function mockRequest(url,body,method){const r=await fetch(mockBase+url,{method:method || (body?"POST":"GET"),headers:{Authorization:`Bearer ${ownerToken}`,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});return r;}
  try{
    const created=await (await mockRequest("/chats",{from:"2026-01-01",to:"2026-01-07"})).json();
    const requestId=randomUUID();
    const image="data:image/png;base64,iVBORw0KGgo=";
    const streamResponse=await mockRequest(`/chats/${created.id}/messages`,{requestId,text:"分析图片",images:[image]});
    assert.equal(streamResponse.status,200);
    const streamText=await streamResponse.text();
    assert.match(streamText,/event: thinking/);assert.match(streamText,/event: delta/);assert.match(streamText,/event: done/);
    assert.equal(providerBody.model,"deepseek-flash");assert.equal(providerBody.reasoning_effort,"medium");assert.equal(providerBody.max_tokens,393216);
    assert.equal(providerBody.messages.at(-1).content[1].image_url.url,image);
    const detail=await (await mockRequest(`/chats/${created.id}`)).json();
    assert.deepEqual(detail.messages.map(m=>m.role),['user','assistant']);
    assert.deepEqual(detail.messages.map(m=>Number(m.position)),[1,2]);
    const automaticMemory=await (await mockRequest('/memory')).json();
    assert.ok(automaticMemory.memories.some(m=>m.key===`automatic:${created.id}` && m.content.content.includes('¥100')));
    assert.equal(detail.messages.length,2);assert.equal(detail.messages[1].status,"complete");assert.equal(detail.messages[1].content,"## 经营分析\n\n营业额 ¥100，优先改善复购。");
    assert.equal(detail.messages[1].usage.total_tokens,42);
    assert.equal((await mockRequest(`/chats/${created.id}/messages`,{requestId,text:"分析图片",images:[image]})).status,409);
    assert.equal((await mockRequest("/memory/insight",{messageId:detail.messages[1].id})).status,200);
    const second=await mockRequest(`/chats/${created.id}/messages`,{requestId:randomUUID(),text:"第三条是第二轮问题",images:[]});
    assert.match(await second.text(),/event: done/);
    await appPool.query(`UPDATE business_ai_messages SET created_at='2026-01-01T00:00:00Z' WHERE chat_id=$1`,[created.id]);
    const multi=await (await mockRequest(`/chats/${created.id}`)).json();
    assert.deepEqual(multi.messages.map(m=>m.role),['user','assistant','user','assistant']);
    assert.deepEqual(multi.messages.map(m=>Number(m.position)),[1,2,3,4]);
    assert.equal(providerBody.messages[2].role,'user');assert.equal(providerBody.messages[3].role,'assistant');

    providerMode="interrupted";
    const interrupted=await mockRequest(`/chats/${created.id}/messages`,{requestId:randomUUID(),text:"继续",images:[]});
    assert.match(await interrupted.text(),/event: error/);
    const saved=await (await mockRequest(`/chats/${created.id}`)).json();
    assert.equal(saved.messages.at(-1).status,"interrupted");assert.ok(saved.messages.at(-1).content.includes("¥100"));assert.equal(saved.chat.running_until,null);
    assert.deepEqual(saved.messages.map(m=>m.role),['user','assistant','user','assistant','user','assistant']);
    assert.equal((await mockRequest(`/chats/${created.id}`,undefined,'DELETE')).status,200);
    assert.equal((await mockRequest(`/chats/${created.id}`)).status,404);
    assert.ok(!(await (await mockRequest('/chats')).json()).chats.some(c=>c.id===created.id));
    assert.ok((await (await mockRequest('/chats?trash=true')).json()).chats.some(c=>c.id===created.id));
    assert.ok(!(await (await mockRequest('/memory')).json()).memories.some(m=>m.key===`automatic:${created.id}`));
    assert.equal((await mockRequest(`/chats/${created.id}/restore`,{})).status,200);
    const restored=await (await mockRequest(`/chats/${created.id}`)).json();
    assert.deepEqual(restored.messages.map(m=>m.id),saved.messages.map(m=>m.id));
    assert.ok((await (await mockRequest('/memory')).json()).memories.some(m=>m.key===`automatic:${created.id}`));
    const legacy=await (await mockRequest('/chats',{from:'2026-01-01',to:'2026-01-07'})).json();
    await appPool.query(`INSERT INTO business_ai_messages(id,chat_id,role,content,status,created_at) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff',$1,'user','旧提问','complete','2026-01-01'),('00000000-0000-4000-8000-000000000001',$1,'assistant','旧回答','complete','2026-01-01')`,[legacy.id]);
    await runAiMigrations();
    const fixed=await (await mockRequest(`/chats/${legacy.id}`)).json();
    assert.deepEqual(fixed.messages.map(m=>m.role),['user','assistant']);

  } finally {await new Promise(resolve=>mockServer.close(resolve));process.env.DEEPSEEK_API_KEY="";}

  const ticketResult = await request("/api/auth/event-ticket", { token: ownerToken, body: {} });
  assert.equal(ticketResult.status, 200, JSON.stringify(ticketResult.body));
  const eventController = new AbortController();
  const eventResponse = await fetch(`${baseUrl}/api/events?ticket=${encodeURIComponent(ticketResult.body.ticket)}`, {
    signal: eventController.signal
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get("content-type") || "", /text\/event-stream/);
  const eventReader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  const connectedChunk = await withTimeout(eventReader.read(), 2_000, "SSE 连接没有及时建立");
  assert.match(decoder.decode(connectedChunk.value), /connected/);
  const reusedTicket = await fetch(`${baseUrl}/api/events?ticket=${encodeURIComponent(ticketResult.body.ticket)}`);
  assert.equal(reusedTicket.status, 401, "SSE ticket 必须一次性使用");
  await reusedTicket.arrayBuffer();

  const printerId = `codex-test-printer-${randomBytes(4).toString("hex")}`;
  const printerRegistration = await request("/api/print-devices/register", {
    token: ownerToken,
    body: { deviceId: printerId, name: "集成测试打印机" }
  });
  assert.equal(printerRegistration.status, 200, JSON.stringify(printerRegistration.body));
  const printerToken = printerRegistration.body.printerToken;

  const tableNumber = 9_800 + Math.floor(Math.random() * 100);
  const tableResult = await request("/api/tables", {
    token: ownerToken,
    body: { number: tableNumber, name: `${tableNumber}号测试桌`, seats: 4 }
  });
  assert.equal(tableResult.status, 201, JSON.stringify(tableResult.body));
  const tableId = tableResult.body.tableId;
  let eventText = "";
  const eventDeadline = Date.now() + 2_000;
  while (Date.now() < eventDeadline && !eventText.includes('"type":"table.updated"')) {
    const eventChunk = await withTimeout(eventReader.read(), 2_000, "桌台更新没有通过 SSE 通知");
    eventText += decoder.decode(eventChunk.value);
  }
  assert.match(eventText, /"type":"table\.updated"/);
  eventController.abort();
  await eventReader.cancel().catch(() => undefined);

  const categoriesResult = await request("/api/categories", { token: ownerToken });
  const categoryIds = categoriesResult.body.categories.map((category) => category.id).reverse();
  if (categoryIds.length > 1) {
    const reorder = await request("/api/categories/order", { token: ownerToken, method: "PUT", body: { ids: categoryIds } });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
    assert.deepEqual(reorder.body.categories.map((category) => category.id), categoryIds);
  }

  const disabledTableNumber = tableNumber + 100;
  const disabledTableCreate = await request("/api/tables", {
    token: ownerToken,
    body: { number: disabledTableNumber, name: `${disabledTableNumber}号停用测试桌`, seats: 2 }
  });
  assert.equal(disabledTableCreate.status, 201, JSON.stringify(disabledTableCreate.body));
  const disabledTableId = disabledTableCreate.body.tableId;
  const disabledTable = await request(`/api/tables/${disabledTableId}`, {
    token: ownerToken,
    method: "PATCH",
    body: { status: "DISABLED" }
  });
  assert.equal(disabledTable.status, 200, JSON.stringify(disabledTable.body));
  const tablesWhileDisabled = await request("/api/tables", { token: ownerToken });
  assert.equal(tablesWhileDisabled.body.tables.find((table) => table.id === disabledTableId).status, "DISABLED");
  const restoredTable = await request(`/api/tables/${disabledTableId}`, {
    token: ownerToken,
    method: "PATCH",
    body: { status: "AVAILABLE" }
  });
  assert.equal(restoredTable.status, 200, JSON.stringify(restoredTable.body));

  const openAttempts = await Promise.all([
    request(`/api/tables/${tableId}/open`, { token: ownerToken, body: { people: 2, idempotencyKey: randomUUID() } }),
    request(`/api/tables/${tableId}/open`, { token: ownerToken, body: { people: 2, idempotencyKey: randomUUID() } })
  ]);
  assert.deepEqual(openAttempts.map((item) => item.status).sort(), [201, 409]);
  const originalOrderId = openAttempts.find((item) => item.status === 201).body.order.id;

  const menu = await request("/api/dishes", { token: ownerToken });
  assert.equal(menu.status, 200, JSON.stringify(menu.body));
  const seededDish = menu.body.dishes[0];
  assert.ok(seededDish?.id, "生产菜单应至少包含一道可售菜品");

  const addKey = randomUUID();
  const addPayload = { items: [{ dishId: seededDish.id, quantity: 2 }] };
  const repeatedAdds = await Promise.all([
    request(`/api/orders/${originalOrderId}/items`, { token: ownerToken, body: { ...addPayload, idempotencyKey: addKey } }),
    request(`/api/orders/${originalOrderId}/items`, { token: ownerToken, body: { ...addPayload, idempotencyKey: addKey } })
  ]);
  assert.deepEqual(repeatedAdds.map((item) => item.status), [201, 201]);
  const changedPayload = await request(`/api/orders/${originalOrderId}/items`, {
    token: ownerToken,
    body: { items: [{ dishId: seededDish.id, quantity: 3 }], idempotencyKey: addKey }
  });
  assert.equal(changedPayload.status, 409);

  const itemCounts = await appPool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM order_batches WHERE order_id = $1) AS batch_count,
       (SELECT COUNT(*)::int FROM order_items WHERE order_id = $1) AS item_count,
       (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items WHERE order_id = $1) AS quantity,
       (SELECT COUNT(*)::int FROM print_jobs WHERE order_id = $1 AND kind = 'KITCHEN') AS print_job_count`,
    [originalOrderId]
  );
  assert.deepEqual(itemCounts.rows[0], { batch_count: 1, item_count: 1, quantity: 2, print_job_count: 2 });

  const transferKey = randomUUID();
  const transferPayload = { targetTableId: disabledTableId, copies: 2, idempotencyKey: transferKey };
  const transferred = await request(`/api/orders/${originalOrderId}/transfer`, {
    token: ownerToken, body: transferPayload
  });
  assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
  assert.equal(transferred.body.order.tableId, disabledTableId);
  assert.equal(transferred.body.order.items.length, 1, "换桌后保留已点菜品");
  const repeatedTransfer = await request(`/api/orders/${originalOrderId}/transfer`, {
    token: ownerToken, body: transferPayload
  });
  assert.equal(repeatedTransfer.status, 200, JSON.stringify(repeatedTransfer.body));
  const transferTables = await request("/api/tables", { token: ownerToken });
  assert.equal(transferTables.body.tables.find((table) => table.id === tableId).status, "AVAILABLE");
  assert.equal(transferTables.body.tables.find((table) => table.id === disabledTableId).status, "OCCUPIED");
  const transferredJobs = await appPool.query(
    `SELECT COUNT(*)::int AS count FROM print_jobs WHERE order_id = $1 AND kind = 'KITCHEN'`, [originalOrderId]
  );
  assert.equal(transferredJobs.rows[0].count, 4, "重试换桌不能重复生成备菜单");
  const transferredBack = await request(`/api/orders/${originalOrderId}/transfer`, {
    token: ownerToken,
    body: { targetTableId: tableId, copies: 2, idempotencyKey: randomUUID() }
  });
  assert.equal(transferredBack.status, 200, JSON.stringify(transferredBack.body));

  const printerHeaders = { "x-printer-device-id": printerId, "x-printer-token": printerToken };
  const claim = await request("/api/print-jobs/claim", {
    headers: printerHeaders,
    body: { sessionStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() }
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.ok(claim.body.job?.id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ack = await request(`/api/print-jobs/${claim.body.job.id}/ack`, {
      headers: printerHeaders,
      body: { status: "SENT" }
    });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.job.status, "SENT");
  }

  for (let batch = 2; batch <= 3; batch += 1) {
    const added = await request(`/api/orders/${originalOrderId}/items`, {
      token: ownerToken,
      body: { items: [{ dishId: seededDish.id, quantity: 1 }], idempotencyKey: randomUUID() }
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }
  const checkedOut = await request(`/api/orders/${originalOrderId}/checkout`, {
    token: ownerToken,
    body: { paymentMethod: "现金", idempotencyKey: randomUUID() }
  });
  assert.equal(checkedOut.status, 200, JSON.stringify(checkedOut.body));

  const businessDate = await appPool.query(`SELECT business_date::text AS business_date FROM orders WHERE id = $1`, [originalOrderId]);
  const csvResponse = await fetch(`${baseUrl}/api/stats/export.csv?from=${businessDate.rows[0].business_date}&to=${businessDate.rows[0].business_date}`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const csvBytes = new Uint8Array(await csvResponse.arrayBuffer());
  const csv = new TextDecoder().decode(csvBytes);
  assert.equal(csvResponse.status, 200, csv);
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "CSV 应使用 UTF-8 BOM 兼容 Excel 中文");
  assert.match(csv, /"营业额"/);
  assert.match(csv, /"每桌平均消费"/);
  assert.match(csv, /"新客"/);
  assert.match(csv, /"散客订单占比"/);
  assert.match(csv, /"菜品销量"/);

  const currentOrder = await request(`/api/tables/${tableId}/open`, {
    token: ownerToken,
    body: { people: 2, idempotencyKey: randomUUID() }
  });
  assert.equal(currentOrder.status, 201, JSON.stringify(currentOrder.body));
  const currentOrderId = currentOrder.body.order.id;
  const reopened = await request(`/api/orders/${originalOrderId}/reopen`, {
    token: ownerToken,
    body: { idempotencyKey: randomUUID() }
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  const reopenedOrderId = reopened.body.order.id;
  assert.equal(reopened.body.order.tableId, null);
  assert.equal(reopened.body.order.tableNumber, tableNumber);

  const tableState = await appPool.query(
    `SELECT t.status, o.id AS open_order_id, reopened.table_id AS reopened_table_id,
            reopened.order_version
     FROM restaurant_tables t
     LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'OPEN'
     JOIN orders reopened ON reopened.id = $2
     WHERE t.id = $1`,
    [tableId, reopenedOrderId]
  );
  assert.deepEqual(tableState.rows[0], {
    status: "OCCUPIED",
    open_order_id: currentOrderId,
    reopened_table_id: null,
    order_version: 3
  });
  const fourthBatch = await request(`/api/orders/${reopenedOrderId}/items`, {
    token: ownerToken,
    body: { items: [{ dishId: seededDish.id, quantity: 1 }], idempotencyKey: randomUUID() }
  });
  assert.equal(fourthBatch.status, 201, JSON.stringify(fourthBatch.body));
  const batchNumbers = await appPool.query(
    `SELECT array_agg(batch_no ORDER BY batch_no) AS numbers FROM order_batches WHERE order_id = $1`,
    [reopenedOrderId]
  );
  assert.deepEqual(batchNumbers.rows[0].numbers, [1, 2, 3, 4]);

  const allJobs = await request("/api/print-jobs?status=ALL", { token: ownerToken });
  assert.equal(allJobs.status, 200, JSON.stringify(allJobs.body));

  const staleJob = await appPool.query(
    `INSERT INTO print_jobs (kind, payload, status, device_id, claimed_at)
     VALUES ('KITCHEN', '{}'::jsonb, 'CLAIMED', $1, now() - interval '6 minutes') RETURNING id`,
    [printerId]
  );
  const staleJobId = staleJob.rows[0].id;
  const deadline = Date.now() + 5_000;
  let staleStatus = "CLAIMED";
  while (Date.now() < deadline && staleStatus === "CLAIMED") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await appPool.query(`SELECT status FROM print_jobs WHERE id = $1`, [staleJobId]);
    staleStatus = status.rows[0]?.status;
  }
  assert.equal(staleStatus, "NEEDS_CHECK", "后台清理应自动将过期领取标记为待核对");

  const cashierPassword = randomBytes(12).toString("hex");
  const cashierUsername = `codex_cashier_${randomBytes(4).toString("hex")}`;
  const cashierCreateForLogin = await request("/api/employees", {
    token: ownerToken,
    body: { username: cashierUsername, name: "权限测试收银员", password: cashierPassword }
  });
  assert.equal(cashierCreateForLogin.status, 201, JSON.stringify(cashierCreateForLogin.body));
  const cashierLogin = await request("/api/auth/login", {
    body: { username: cashierUsername, password: cashierPassword }
  });
  assert.equal(cashierLogin.status, 200, JSON.stringify(cashierLogin.body));
  const cashierMenu = await request("/api/dishes", { token: cashierLogin.body.token });
  assert.equal(cashierMenu.status, 200);
  assert.equal(Object.hasOwn(cashierMenu.body.dishes[0], "cost_fen"), false);
  const draftTable = await request("/api/tables", {
    token: ownerToken,
    body: { number: tableNumber + 1, name: "多人草稿测试桌", seats: 4 }
  });
  assert.equal(draftTable.status, 201, JSON.stringify(draftTable.body));
  const draftOrder = await request(`/api/tables/${draftTable.body.tableId}/open`, {
    token: ownerToken, body: { people: 2, idempotencyKey: randomUUID() }
  });
  assert.equal(draftOrder.status, 201, JSON.stringify(draftOrder.body));
  const draftOrderId = draftOrder.body.order.id;
  const ownerDish = menu.body.dishes.find((item) => item.id === seededDish.id);
  const cashierDish = cashierMenu.body.dishes.find((item) => item.id === seededDish.id);
  const ownerDraftKey = randomUUID();
  const draftLine = (dish) => ({ dishId: dish.id, quantity: 1, note: "", options: [], dish });
  const draftAdds = await Promise.all([
    request(`/api/orders/${draftOrderId}/draft`, { token: ownerToken,
      body: { op: "adjust", delta: 1, line: draftLine(ownerDish), idempotencyKey: ownerDraftKey } }),
    request(`/api/orders/${draftOrderId}/draft`, { token: cashierLogin.body.token,
      body: { op: "adjust", delta: 1, line: draftLine(cashierDish), idempotencyKey: randomUUID() } })
  ]);
  assert.deepEqual(draftAdds.map((item) => item.status), [200, 200], JSON.stringify(draftAdds));
  const repeatedDraftAdd = await request(`/api/orders/${draftOrderId}/draft`, { token: ownerToken,
    body: { op: "adjust", delta: 1, line: draftLine(ownerDish), idempotencyKey: ownerDraftKey } });
  assert.equal(repeatedDraftAdd.status, 200);
  const sharedDraft = await request(`/api/orders/${draftOrderId}`, { token: cashierLogin.body.token });
  assert.equal(sharedDraft.body.order.draftLines[0].quantity, 2);
  assert.equal(sharedDraft.body.order.items.length, 0);
  assert.equal(sharedDraft.body.order.draftLines[0].dish.cost_fen, null);
  const draftDb = await appPool.query(`SELECT jsonb_array_length(draft_lines)::int AS drafts FROM orders WHERE id = $1`, [draftOrderId]);
  assert.equal(draftDb.rows[0].drafts, 1);
  const submitDraftKey = randomUUID();
  const savedWithoutPrint = await request(`/api/orders/${draftOrderId}/items`, { token: ownerToken,
    body: { useDraft: true, copies: 0, idempotencyKey: submitDraftKey } });
  assert.equal(savedWithoutPrint.status, 201, JSON.stringify(savedWithoutPrint.body));
  assert.equal(savedWithoutPrint.body.order.items[0].quantity, 2);
  const repeatedDraftSubmit = await request(`/api/orders/${draftOrderId}/items`, { token: ownerToken,
    body: { useDraft: true, copies: 0, idempotencyKey: submitDraftKey } });
  assert.equal(repeatedDraftSubmit.status, 201);
  const savedDraftCounts = await appPool.query(
    `SELECT (SELECT COUNT(*)::int FROM print_jobs WHERE order_id = $1) AS prints,
            (SELECT COUNT(*)::int FROM order_items WHERE order_id = $1) AS items,
            (SELECT jsonb_array_length(draft_lines)::int FROM orders WHERE id = $1) AS drafts`, [draftOrderId]
  );
  assert.deepEqual(savedDraftCounts.rows[0], { prints: 0, items: 1, drafts: 0 });
  const banquetTable = await request("/api/tables", {
    token: ownerToken, body: { number: tableNumber + 2, name: "预点菜草稿测试桌", seats: 6 }
  });
  assert.equal(banquetTable.status, 201, JSON.stringify(banquetTable.body));
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const endsAt = new Date(Date.now() + 93_600_000).toISOString();
  const reservationCreated = await request("/api/banquets/reservations", { token: ownerToken,
    body: { tableId: banquetTable.body.tableId, startsAt, endsAt, peopleCount: 6,
      customerName: "预点草稿测试", idempotencyKey: randomUUID() } });
  assert.equal(reservationCreated.status, 201, JSON.stringify(reservationCreated.body));
  const reservationId = reservationCreated.body.reservation.id;
  const preorderDraftAdds = await Promise.all([
    request(`/api/banquets/reservations/${reservationId}/draft`, { token: ownerToken,
      body: { op: "adjust", delta: 1, line: draftLine(ownerDish), idempotencyKey: randomUUID() } }),
    request(`/api/banquets/reservations/${reservationId}/draft`, { token: cashierLogin.body.token,
      body: { op: "adjust", delta: 1, line: draftLine(cashierDish), idempotencyKey: randomUUID() } })
  ]);
  assert.deepEqual(preorderDraftAdds.map((item) => item.status), [200, 200], JSON.stringify(preorderDraftAdds));
  const sharedPreorder = await request(`/api/banquets/reservations/${reservationId}`, { token: cashierLogin.body.token });
  assert.equal(sharedPreorder.body.reservation.draft_lines[0].quantity, 2);
  assert.equal(sharedPreorder.body.reservation.preorder.length, 0);
  const printZero = await request(`/api/banquets/reservations/${reservationId}/preorder/print`, { token: ownerToken,
    body: { copies: 0, idempotencyKey: randomUUID() } });
  assert.equal(printZero.status, 201, JSON.stringify(printZero.body));
  const confirmedPreorder = await request(`/api/banquets/reservations/${reservationId}`, { token: ownerToken });
  assert.equal(confirmedPreorder.body.reservation.preorder[0].quantity, 2);
  assert.equal(confirmedPreorder.body.reservation.draft_lines.length, 0);
  const preorderPrintCount = await appPool.query(`SELECT COUNT(*)::int AS count FROM print_jobs WHERE payload->>'reservationId' = $1`, [reservationId]);
  assert.equal(preorderPrintCount.rows[0].count, 0);
  const laterDraft = await request(`/api/banquets/reservations/${reservationId}/draft`, { token: ownerToken,
    body: { op: "adjust", delta: 1, line: draftLine(ownerDish), idempotencyKey: randomUUID() } });
  assert.equal(laterDraft.status, 200);
  const converted = await request(`/api/banquets/reservations/${reservationId}/convert`, { token: ownerToken,
    body: { idempotencyKey: randomUUID() } });
  assert.equal(converted.status, 201, JSON.stringify(converted.body));
  const convertedOrder = await request(`/api/orders/${converted.body.orderId}`, { token: ownerToken });
  assert.equal(convertedOrder.body.order.items[0].quantity, 2);
  assert.equal(convertedOrder.body.order.draftLines[0].quantity, 1);
  const cashierOrder = await request(`/api/orders/${currentOrderId}`, { token: cashierLogin.body.token });
  assert.equal(cashierOrder.status, 200);
  assert.equal(Object.hasOwn(cashierOrder.body.order, "grossProfitFen"), false);
  assert.equal(Object.hasOwn(cashierOrder.body.order.totals, "costFen"), false);

  assert.equal((await request("/api/business-ai/chats", {token:cashierLogin.body.token})).status,403);

  const changedCashierPassword = `${cashierPassword}new`;
  const badPasswordChange = await request("/api/auth/change-password", {
    body: { username: cashierUsername, oldPassword: "wrong", newPassword: changedCashierPassword }
  });
  assert.equal(badPasswordChange.status, 401);
  const changedPassword = await request("/api/auth/change-password", {
    body: { username: cashierUsername, oldPassword: cashierPassword, newPassword: changedCashierPassword }
  });
  assert.equal(changedPassword.status, 200, JSON.stringify(changedPassword.body));
  const staleCashierToken = await request("/api/auth/me", { token: cashierLogin.body.token });
  assert.equal(staleCashierToken.status, 401);
  const oldPasswordLogin = await request("/api/auth/login", {
    body: { username: cashierUsername, password: cashierPassword }
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await request("/api/auth/login", {
    body: { username: cashierUsername, password: changedCashierPassword }
  });
  assert.equal(newPasswordLogin.status, 200);

  const menuCount = await appPool.query(
    `SELECT COUNT(*)::int AS count FROM dishes d JOIN categories c ON c.id = d.category_id WHERE c.name = '其他'`
  );
  assert.equal(menuCount.rows[0].count, 53);
  const seededPrice = await appPool.query(`SELECT id, price_fen FROM dishes WHERE id = $1`, [seededDish.id]);
  const modifiedPrice = Number(seededPrice.rows[0].price_fen) + 123;
  await appPool.query(`UPDATE dishes SET price_fen = $1 WHERE id = $2`, [modifiedPrice, seededDish.id]);
  process.env.DATABASE_URL = appUrl.toString();
  process.env.BOOTSTRAP_ADMIN_USERNAME = ownerUsername;
  process.env.BOOTSTRAP_ADMIN_PASSWORD = ownerPassword;
  const [{ migrateAndSeed }, dbModule] = await Promise.all([
    import("../server/dist/migrate.js"),
    import("../server/dist/db.js")
  ]);
  migrationPool = dbModule.pool;
  await migrateAndSeed();
  const preservedPrice = await appPool.query(`SELECT price_fen FROM dishes WHERE id = $1`, [seededDish.id]);
  assert.equal(Number(preservedPrice.rows[0].price_fen), modifiedPrice, "重新执行启动迁移不能覆盖已修改的菜价");
});
