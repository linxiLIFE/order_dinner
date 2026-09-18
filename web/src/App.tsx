import { useEffect, useMemo, useState } from "react";
import { api, businessDate, formatTime, getToken, money, requestKey, setToken, type User } from "./api.js";

type Page = "tables" | "customers" | "dishes" | "stats" | "settings";
type Table = {
  id: string;
  number: number;
  seats: number;
  status: string;
  order: { id: string; peopleCount: number; currentFen: number; openedAt: string; customer: { name: string; phone: string | null } } | null;
};
type Category = { id: string; name: string; sort_order?: number };
type Dish = {
  id: string;
  category_id: string | null;
  category_name: string | null;
  name: string;
  pinyin: string;
  unit: string;
  price_fen: number;
  cost_fen: number;
  image_url: string | null;
};
type OrderItem = {
  id: string;
  dishId: string | null;
  name: string;
  categoryName: string;
  unit: string;
  priceFen: number;
  quantity: number;
  giftedQuantity: number;
  returnedQuantity: number;
  returnedMadeQuantity: number;
  availableQuantity: number;
  note: string;
  batchNo: number;
  batchKind: string;
  createdAt: string;
};
type Order = {
  id: string;
  tableId: string | null;
  tableNumber: number | null;
  customer: { id: string | null; name: string; phone: string | null; points: number };
  peopleCount: number;
  status: string;
  orderVersion: number;
  openedAt: string;
  items: OrderItem[];
  totals: { grossFen: number; giftFen: number; returnFen: number; subtotalFen: number; costFen: number; lossFen: number };
};
type CartLine = { dish: Dish; quantity: number; note: string };
type Settings = Record<string, unknown>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

function centsFromYuan(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ token: string; user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setToken(result.token);
      onLogin(result.user);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">点</div>
        <h1>餐厅点单台</h1>
        <p className="muted">员工登录</p>
        <label>账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
        <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
        {message && <div className="message error">{message}</div>}
        <button className="primary wide" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
      </form>
    </main>
  );
}

function Header({ user, page, setPage, onLogout, selectedOrder }: {
  user: User;
  page: Page;
  setPage: (page: Page) => void;
  onLogout: () => void;
  selectedOrder: boolean;
}) {
  const links: Array<[Page, string]> = [["tables", "桌台"], ["customers", "顾客"], ["dishes", "菜品"]];
  if (user.role === "OWNER") links.push(["stats", "营业统计"], ["settings", "设置"]);
  return (
    <header className="topbar">
      <button className="wordmark" onClick={() => setPage("tables")}>餐厅点单台</button>
      <nav className="main-nav">
        {links.map(([key, label]) => <button key={key} className={page === key && !selectedOrder ? "nav-link active" : "nav-link"} onClick={() => setPage(key)}>{label}</button>)}
      </nav>
      <div className="user-area"><span>{user.name}</span><span className="role-tag">{user.role === "OWNER" ? "老板" : "收银员"}</span><button className="text-button" onClick={onLogout}>退出</button></div>
    </header>
  );
}

function TablesPage({ tables, refresh, openOrder, setMessage }: {
  tables: Table[];
  refresh: () => Promise<void>;
  openOrder: (orderId: string) => void;
  setMessage: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function openTable(table: Table) {
    const phone = window.prompt("顾客手机号（留空表示散客）", "") || "";
    const name = phone ? (window.prompt("顾客称呼（可留空）", "") || "") : "";
    const people = Number(window.prompt("用餐人数", "2") || "2");
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/tables/${table.id}/open`, {
        method: "POST",
        body: JSON.stringify({ phone, customerName: name, people, idempotencyKey: requestKey(`open-${table.id}`) })
      });
      openOrder(result.order.id);
      await refresh();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-section">
      <div className="section-heading"><div><h2>桌台</h2><p className="muted">选择空桌开台，或继续处理进行中的账单</p></div><button className="secondary" onClick={refresh} disabled={busy}>刷新</button></div>
      <div className="table-grid">
        {tables.map((table) => {
          const occupied = Boolean(table.order);
          return <button key={table.id} className={`table-card ${occupied ? "occupied" : "available"}`} onClick={() => occupied ? openOrder(table.order!.id) : openTable(table)} disabled={busy || table.status === "DISABLED"}>
            <div className="table-number">{table.number}<small>号桌</small></div>
            <div className="table-state">{table.status === "DISABLED" ? "停用" : occupied ? "用餐中" : "空桌"}</div>
            <div className="table-detail">{occupied ? `${table.order!.customer.name} · ${table.order!.peopleCount} 人` : `${table.seats} 人桌`}</div>
            {occupied && <div className="table-total">{money(table.order!.currentFen)}</div>}
          </button>;
        })}
      </div>
    </section>
  );
}

function OrderPage({ orderId, user, refreshTables, setMessage, goBack }: {
  orderId: string;
  user: User;
  refreshTables: () => Promise<void>;
  setMessage: (message: string) => void;
  goBack: () => void;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [orderResult, categoryResult, dishResult] = await Promise.all([
        api<{ order: Order }>(`/api/orders/${orderId}`),
        api<{ categories: Category[] }>("/api/categories"),
        api<{ dishes: Dish[] }>("/api/dishes")
      ]);
      setOrder(orderResult.order);
      setCategories(categoryResult.categories);
      setDishes(dishResult.dishes);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  useEffect(() => { void load(); }, [orderId]);

  const visibleDishes = useMemo(() => dishes.filter((dish) => {
    const categoryMatch = !categoryId || dish.category_id === categoryId;
    const keyword = search.trim().toLowerCase();
    return categoryMatch && (!keyword || dish.name.toLowerCase().includes(keyword) || dish.pinyin.toLowerCase().includes(keyword));
  }), [dishes, categoryId, search]);

  function addDish(dish: Dish) {
    setCart((current) => ({ ...current, [dish.id]: { dish, quantity: (current[dish.id]?.quantity || 0) + 1, note: current[dish.id]?.note || "" } }));
  }

  function changeCart(dishId: string, delta: number) {
    setCart((current) => {
      const line = current[dishId];
      if (!line) return current;
      const quantity = line.quantity + delta;
      if (quantity <= 0) {
        const next = { ...current };
        delete next[dishId];
        return next;
      }
      return { ...current, [dishId]: { ...line, quantity } };
    });
  }

  function editNote(dishId: string) {
    const line = cart[dishId];
    if (!line) return;
    const note = window.prompt("口味备注", line.note) ?? line.note;
    setCart((current) => ({ ...current, [dishId]: { ...line, note } }));
  }

  async function submitItems() {
    const items = Object.values(cart).map((line) => ({ dishId: line.dish.id, quantity: line.quantity, note: line.note }));
    if (!items.length) return setMessage("请先选择菜品");
    localStorage.setItem(`order-draft-${orderId}`, JSON.stringify(items));
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${orderId}/items`, { method: "POST", body: JSON.stringify({ items, idempotencyKey: requestKey(`items-${orderId}`) }) });
      setOrder(result.order);
      setCart({});
      localStorage.removeItem(`order-draft-${orderId}`);
      setMessage("已提交，已生成两份备菜单打印任务");
      await refreshTables();
    } catch (error) {
      setMessage(`${errorText(error)}；本机草稿已保留`);
    } finally {
      setBusy(false);
    }
  }

  async function itemAction(item: OrderItem, action: "gift" | "return") {
    const quantity = Number(window.prompt(action === "gift" ? "赠送数量" : "退菜数量", "1") || "0");
    if (!quantity) return;
    const reason = window.prompt(action === "gift" ? "赠送原因（可留空）" : "退菜原因（可留空）", "") || "";
    let made = false;
    if (action === "return") made = window.confirm("这道菜已经制作了吗？\n确定表示已制作，取消表示未制作");
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${orderId}/items/${item.id}/${action}`, { method: "POST", body: JSON.stringify({ quantity, reason, made }) });
      setOrder(result.order);
      setMessage(action === "gift" ? "已记录赠送" : "已记录退菜，并生成两份退菜单打印任务");
      await refreshTables();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    if (!window.confirm("撤销本次结账并重新开账？原账单、积分冲销和新账单都会保留。")) return;
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${orderId}/reopen`, { method: "POST", body: JSON.stringify({}) });
      setOrder(result.order);
      setMessage("已撤销结账并生成新账单，未重复打印厨房菜单");
      await refreshTables();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (!order) return <section className="page-section"><div className="loading">正在读取账单…</div></section>;
  const cartTotal = Object.values(cart).reduce((sum, line) => sum + line.dish.price_fen * line.quantity, 0);
  const open = order.status === "OPEN";
  return <section className="page-section order-page">
    <div className="section-heading order-heading"><div><button className="back-button" onClick={goBack}>‹ 桌台</button><h2>{order.tableNumber ? `${order.tableNumber}号桌` : "账单"} <span className={`status-pill ${open ? "green" : "gray"}`}>{open ? "进行中" : order.status === "SETTLED" ? "已结账" : "已撤销"}</span></h2><p className="muted">{order.customer.name} · {order.peopleCount} 人 · 开台 {formatTime(order.openedAt)}</p></div><div className="heading-actions">{order.status === "SETTLED" && user.role === "OWNER" && <button className="secondary" onClick={reopen} disabled={busy}>撤销重结</button>}{open && <button className="primary" onClick={() => setCheckoutOpen(true)} disabled={busy || !order.items.length}>结账 {money(order.totals.subtotalFen)}</button>}</div></div>
    <div className="order-layout">
      <div className="catalog-panel">
        <div className="search-row"><input placeholder="搜索菜名、拼音或首字母" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="secondary" onClick={() => setSearch("")}>清空</button></div>
        <div className="category-row"><button className={!categoryId ? "category-chip selected" : "category-chip"} onClick={() => setCategoryId("")}>全部</button>{categories.map((category) => <button className={categoryId === category.id ? "category-chip selected" : "category-chip"} key={category.id} onClick={() => setCategoryId(category.id)}>{category.name}</button>)}</div>
        <div className="dish-grid">{visibleDishes.map((dish) => <button className="dish-card" key={dish.id} onClick={() => addDish(dish)} disabled={!open || busy}><span className="dish-name">{dish.name}</span><span className="dish-meta">{dish.unit} · {money(dish.price_fen)}</span></button>)}</div>
        {!visibleDishes.length && <div className="empty">暂无匹配菜品，请在“菜品”中配置。</div>}
      </div>
      <aside className="current-order">
        <div className="order-card-heading"><h3>当前订单</h3><span>{order.items.length} 项</span></div>
        <div className="order-lines">{order.items.map((item) => <div className="order-line" key={item.id}><div className="line-main"><strong>{item.name}</strong><span>{money(item.priceFen)} × {item.quantity}</span>{item.note && <small>备注：{item.note}</small>}{(item.giftedQuantity > 0 || item.returnedQuantity > 0) && <small className="line-flags">{item.giftedQuantity ? `赠${item.giftedQuantity}` : ""}{item.returnedQuantity ? ` 退${item.returnedQuantity}` : ""}</small>}</div>{open && <div className="line-actions"><button onClick={() => itemAction(item, "gift")} disabled={!item.availableQuantity}>赠送</button><button onClick={() => itemAction(item, "return")} disabled={item.returnedQuantity >= item.quantity}>退菜</button></div>}</div>)}</div>
        {Object.keys(cart).length > 0 && <div className="cart-box"><div className="order-card-heading"><h3>待提交</h3><span>{money(cartTotal)}</span></div>{Object.values(cart).map((line) => <div className="cart-line" key={line.dish.id}><div><strong>{line.dish.name}</strong><small>{line.note || "点击备注口味"}</small></div><button onClick={() => editNote(line.dish.id)}>备注</button><div className="quantity"><button onClick={() => changeCart(line.dish.id, -1)}>−</button><span>{line.quantity}</span><button onClick={() => changeCart(line.dish.id, 1)}>＋</button></div></div>)}<button className="primary wide" onClick={submitItems} disabled={busy}>提交并打印两份</button></div>}
        <div className="order-total"><span>当前应收</span><strong>{money(order.totals.subtotalFen)}</strong><small>原价 {money(order.totals.grossFen)} · 赠送 {money(order.totals.giftFen)} · 退菜 {money(order.totals.returnFen)}</small></div>
      </aside>
    </div>
    {checkoutOpen && <CheckoutPanel order={order} onClose={() => setCheckoutOpen(false)} onDone={async (nextOrder, message) => { setOrder(nextOrder); setCheckoutOpen(false); setMessage(message); await refreshTables(); }} />}
  </section>;
}

function CheckoutPanel({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (order: Order, message: string) => Promise<void> }) {
  const [discount, setDiscount] = useState("0");
  const [points, setPoints] = useState("0");
  const [received, setReceived] = useState((order.totals.subtotalFen / 100).toFixed(2));
  const [payment, setPayment] = useState("现金");
  const [busy, setBusy] = useState(false);
  const manualFen = centsFromYuan(discount);
  const pointsDiscountGuess = Math.floor(Number(points || 0) / 10) * 100;
  const dueFen = Math.max(0, order.totals.subtotalFen - manualFen - pointsDiscountGuess);

  useEffect(() => { setReceived((dueFen / 100).toFixed(2)); }, [dueFen]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ order: Order; settlement: { receivedFen: number; pointsBalance: number } }>(`/api/orders/${order.id}/checkout`, {
        method: "POST",
        body: JSON.stringify({ manualDiscountFen: manualFen, pointsToRedeem: Number(points || 0), receivedFen: centsFromYuan(received), paymentMethod: payment, idempotencyKey: requestKey(`checkout-${order.id}`) })
      });
      await onDone(result.order, `结账完成，打印任务已生成，积分余额 ${result.settlement.pointsBalance} 分`);
    } catch (error) {
      window.alert(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop"><form className="modal checkout-modal" onSubmit={submit}><div className="modal-heading"><div><h2>确认结账</h2><p className="muted">{order.tableNumber}号桌 · {order.customer.name}</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div><div className="checkout-summary"><div><span>菜品原价</span><strong>{money(order.totals.grossFen)}</strong></div><div><span>赠送</span><strong>-{money(order.totals.giftFen)}</strong></div><div><span>退菜</span><strong>-{money(order.totals.returnFen)}</strong></div><div className="emphasis"><span>结账前应收</span><strong>{money(order.totals.subtotalFen)}</strong></div></div><div className="form-grid"><label>人工减免（元）<input type="number" min="0" step="0.01" value={discount} onChange={(event) => setDiscount(event.target.value)} /></label><label>积分抵扣（分）<input type="number" min="0" step="10" value={points} onChange={(event) => setPoints(event.target.value)} /><small>按每 10 分抵 1 元计算</small></label><label>收款方式<select value={payment} onChange={(event) => setPayment(event.target.value)}><option>现金</option><option>微信</option><option>支付宝</option><option>银行卡</option><option>其他</option></select></label><label>实收金额（元）<input type="number" min="0" step="0.01" value={received} onChange={(event) => setReceived(event.target.value)} /></label></div><div className="payable-banner"><span>本次应收</span><strong>{money(dueFen)}</strong></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>返回修改</button><button className="primary" disabled={busy}>{busy ? "结账中…" : "确认收款并打印小票"}</button></div></form></div>;
}

function CustomersPage({ setMessage }: { setMessage: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<Array<Record<string, unknown>>>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  async function search() {
    if (!query.trim()) return setCustomers([]);
    try {
      const result = await api<{ customers: Array<Record<string, unknown>> }>(`/api/customers/search?q=${encodeURIComponent(query)}`);
      setCustomers(result.customers);
    } catch (error) { setMessage(errorText(error)); }
  }
  async function detail(id: string) {
    try {
      const result = await api<{ customer: Record<string, unknown> }>(`/api/customers/${id}`);
      setSelected(result.customer);
    } catch (error) { setMessage(errorText(error)); }
  }
  return <section className="page-section"><div className="section-heading"><div><h2>顾客</h2><p className="muted">按手机号或称呼查询积分和用餐记录</p></div></div><div className="search-row large"><input placeholder="输入手机号或称呼" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /><button className="primary" onClick={search}>查询</button></div><div className="content-card"><table><thead><tr><th>称呼</th><th>手机号</th><th>积分</th><th>结账次数</th><th>最近用餐</th><th></th></tr></thead><tbody>{customers.map((customer) => <tr key={String(customer.id)}><td>{String(customer.name || "未命名")}</td><td>{String(customer.phone || "")}</td><td>{String(customer.points_balance || 0)}</td><td>{String(customer.order_count || 0)}</td><td>{formatTime(String(customer.last_visit || ""))}</td><td><button className="text-button" onClick={() => detail(String(customer.id))}>查看</button></td></tr>)}</tbody></table>{!customers.length && <div className="empty">输入条件后查询</div>}</div>{selected && <div className="modal-backdrop"><div className="modal detail-modal"><div className="modal-heading"><h2>{String(selected.name || "顾客")}</h2><button className="close-button" onClick={() => setSelected(null)}>×</button></div><p>手机号：{String(selected.phone || "未记录")}　当前积分：<strong>{String(selected.points_balance || 0)}</strong></p><h3>积分流水</h3><div className="mini-list">{(selected.ledger as Array<Record<string, unknown>> || []).map((row) => <div key={String(row.id)}><span>{String(row.note || row.kind)}</span><strong className={Number(row.delta) >= 0 ? "positive" : "negative"}>{Number(row.delta) >= 0 ? "+" : ""}{String(row.delta)}</strong><small>{formatTime(String(row.created_at))}</small></div>)}</div><h3>最近用餐</h3><div className="mini-list">{(selected.visits as Array<Record<string, unknown>> || []).map((row) => <div key={String(row.id)}><span>{String(row.business_date)}</span><strong>{money(Number(row.received_fen))}</strong><small>{String(row.payment_method)}</small></div>)}</div></div></div>}</section>;
}

function DishesPage({ categories, user, setMessage, reloadCategories }: { categories: Category[]; user: User; setMessage: (message: string) => void; reloadCategories: () => Promise<void> }) {
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState({ name: "", pinyin: "", categoryId: categories[0]?.id || "", price: "", cost: "", unit: "份" });
  async function load() { try { const result = await api<{ dishes: Dish[] }>(`/api/dishes?q=${encodeURIComponent(query)}`); setDishes(result.dishes); } catch (error) { setMessage(errorText(error)); } }
  useEffect(() => { void load(); }, [query]);
  useEffect(() => { if (!form.categoryId && categories[0]) setForm((current) => ({ ...current, categoryId: categories[0].id })); }, [categories]);
  async function addDish(event: React.FormEvent) { event.preventDefault(); try { await api("/api/dishes", { method: "POST", body: JSON.stringify({ name: form.name, pinyin: form.pinyin, categoryId: form.categoryId || null, priceFen: centsFromYuan(form.price), costFen: centsFromYuan(form.cost), unit: form.unit }) }); setForm({ ...form, name: "", pinyin: "", price: "", cost: "" }); await load(); setMessage("菜品已保存"); } catch (error) { setMessage(errorText(error)); } }
  async function archive(id: string) { if (!window.confirm("停售并归档这道菜？历史账单不会受影响。")) return; try { await api(`/api/dishes/${id}`, { method: "DELETE" }); await load(); setMessage("菜品已归档"); } catch (error) { setMessage(errorText(error)); } }
  async function addCategory() { const name = window.prompt("分类名称", ""); if (!name) return; try { await api("/api/categories", { method: "POST", body: JSON.stringify({ name }) }); await reloadCategories(); setMessage("分类已保存"); } catch (error) { setMessage(errorText(error)); } }
  return <section className="page-section"><div className="section-heading"><div><h2>菜品</h2><p className="muted">售价、成本和分类只影响新订单，历史账单使用快照</p></div>{user.role === "OWNER" && <button className="secondary" onClick={addCategory}>新增分类</button>}</div>{user.role === "OWNER" && <form className="content-card dish-form" onSubmit={addDish}><h3>新增菜品</h3><div className="form-grid five"><label>菜名<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>拼音/首字母<input value={form.pinyin} onChange={(event) => setForm({ ...form, pinyin: event.target.value })} placeholder="可选" /></label><label>分类<select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>售价（元）<input required type="number" min="0" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></label><label>成本（元）<input type="number" min="0" step="0.01" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} /></label></div><button className="primary">保存菜品</button></form>}<div className="search-row large"><input placeholder="搜索菜品" value={query} onChange={(event) => setQuery(event.target.value)} /><button className="secondary" onClick={() => setQuery("")}>清空</button></div><div className="content-card"><table><thead><tr><th>菜品</th><th>分类</th><th>售价</th><th>成本</th><th>单位</th>{user.role === "OWNER" && <th></th>}</tr></thead><tbody>{dishes.map((dish) => <tr key={dish.id}><td>{dish.name}</td><td>{dish.category_name || "未分类"}</td><td>{money(dish.price_fen)}</td><td>{user.role === "OWNER" ? money(dish.cost_fen) : "—"}</td><td>{dish.unit}</td>{user.role === "OWNER" && <td><button className="text-button danger-text" onClick={() => archive(dish.id)}>归档</button></td>}</tr>)}</tbody></table>{!dishes.length && <div className="empty">还没有在售菜品</div>}</div></section>;
}

function StatsPage({ setMessage }: { setMessage: (message: string) => void }) {
  const today = businessDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<{ summary: Record<string, number>; sales: Array<Record<string, unknown>> } | null>(null);
  async function load() { try { setData(await api(`/api/stats?from=${from}&to=${to}`)); } catch (error) { setMessage(errorText(error)); } }
  useEffect(() => { void load(); }, []);
  const s = data?.summary;
  return <section className="page-section"><div className="section-heading"><div><h2>营业统计</h2><p className="muted">按北京时间营业日统计有效结账数据</p></div><button className="secondary" onClick={() => { window.location.href = `/api/stats/export.csv?from=${from}&to=${to}`; }}>导出表格</button></div><div className="filter-bar"><label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><button className="primary" onClick={load}>查询</button></div>{s && <><div className="metric-grid"><Metric label="营业额" value={money(s.revenueFen)} /><Metric label="订单数" value={`${s.orderCount} 单`} /><Metric label="用餐人数" value={`${s.peopleCount} 人`} /><Metric label="人均消费" value={money(s.averagePersonFen)} /><Metric label="毛利润" value={money(s.grossProfitFen)} /><Metric label="毛利率" value={`${s.grossMarginPercent}%`} /><Metric label="优惠金额" value={money(s.discountFen)} /><Metric label="退菜损耗" value={money(s.lossFen)} /></div><div className="content-card"><h3>菜品销量</h3><table><thead><tr><th>菜品</th><th>售出</th><th>赠送</th><th>退菜</th><th>销售金额</th></tr></thead><tbody>{data.sales.map((row) => <tr key={String(row.dish_name)}><td>{String(row.dish_name)}</td><td>{String(row.sold_quantity)}</td><td>{String(row.gifted_quantity)}</td><td>{String(row.returned_quantity)}</td><td>{money(Number(row.amount_fen))}</td></tr>)}</tbody></table></div></>}</section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>; }

function SettingsPage({ setMessage }: { setMessage: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings>({});
  const [tables, setTables] = useState<Table[]>([]);
  const [loaded, setLoaded] = useState(false);
  async function load() { try { const [settingResult, tableResult] = await Promise.all([api<{ settings: Settings }>("/api/settings"), api<{ tables: Table[] }>("/api/tables")]); setSettings(settingResult.settings); setTables(tableResult.tables); setLoaded(true); } catch (error) { setMessage(errorText(error)); } }
  useEffect(() => { void load(); }, []);
  function value(key: string, fallback = "") { return String(settings[key] ?? fallback); }
  async function save(event: React.FormEvent) { event.preventDefault(); try { await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) }); setMessage("设置已保存"); } catch (error) { setMessage(errorText(error)); } }
  async function saveTable(table: Table, values: { number: number; seats: number }) { try { await api(`/api/tables/${table.id}`, { method: "PATCH", body: JSON.stringify(values) }); setMessage(`${table.number}号桌已保存`); } catch (error) { setMessage(errorText(error)); } }
  if (!loaded) return <section className="page-section"><div className="loading">正在读取设置…</div></section>;
  return <section className="page-section"><div className="section-heading"><div><h2>设置</h2><p className="muted">店铺、积分规则、打印设备和桌台配置</p></div></div><form className="settings-layout" onSubmit={save}><div className="content-card"><h3>店铺与小票</h3><div className="form-grid"><label>店名<input value={value("store_name")} onChange={(event) => setSettings({ ...settings, store_name: event.target.value })} /></label><label>小票尾注<input value={value("receipt_footer")} onChange={(event) => setSettings({ ...settings, receipt_footer: event.target.value })} /></label><label>打印设备编号<input value={value("printer_device_id")} onChange={(event) => setSettings({ ...settings, printer_device_id: event.target.value })} placeholder="由安卓打印服务填写" /></label><label>打印设备名称<input value={value("printer_device_name")} onChange={(event) => setSettings({ ...settings, printer_device_name: event.target.value })} /></label></div></div><div className="content-card"><h3>积分规则</h3><label className="toggle-row"><input type="checkbox" checked={Boolean(settings.points_enabled)} onChange={(event) => setSettings({ ...settings, points_enabled: event.target.checked })} />启用积分</label><div className="form-grid three"><label>每多少分获得 1 分<small>按实收金额计算，填写分</small><input type="number" min="1" value={value("points_earn_fen", "100")} onChange={(event) => setSettings({ ...settings, points_earn_fen: Number(event.target.value) })} /></label><label>多少积分抵 1 元<input type="number" min="1" value={value("points_redeem_points", "10")} onChange={(event) => setSettings({ ...settings, points_redeem_points: Number(event.target.value) })} /></label><label>每个抵扣单位金额（分）<input type="number" min="1" value={value("points_redeem_fen", "100")} onChange={(event) => setSettings({ ...settings, points_redeem_fen: Number(event.target.value) })} /></label></div></div><div className="content-card"><h3>桌台</h3><div className="table-settings">{tables.map((table) => <TableSetting key={table.id} table={table} onSave={saveTable} />)}</div></div><button className="primary" type="submit">保存全部设置</button></form></section>;
}

function TableSetting({ table, onSave }: { table: Table; onSave: (table: Table, values: { number: number; seats: number }) => Promise<void> }) {
  const [number, setNumber] = useState(table.number);
  const [seats, setSeats] = useState(table.seats);
  return <div className="table-setting"><label>桌号<input type="number" min="1" value={number} onChange={(event) => setNumber(Number(event.target.value))} /></label><label>座位<input type="number" min="1" value={seats} onChange={(event) => setSeats(Number(event.target.value))} /></label><span className={table.order ? "occupied-dot" : "available-dot"}>{table.order ? "使用中" : "空闲"}</span><button className="secondary" type="button" disabled={Boolean(table.order)} onClick={() => onSave(table, { number, seats })}>保存</button></div>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>("tables");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [tables, setTables] = useState<Table[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(Boolean(getToken()));

  async function refreshTables() { const result = await api<{ tables: Table[] }>("/api/tables"); setTables(result.tables); }
  async function refreshCategories() { const result = await api<{ categories: Category[] }>("/api/categories"); setCategories(result.categories); }
  async function loadHome() { try { await Promise.all([refreshTables(), refreshCategories()]); } catch (error) { setMessage(errorText(error)); } }

  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    api<{ user: User }>("/api/auth/me").then((result) => setUser(result.user)).catch(() => setToken("")).finally(() => setChecking(false));
    const handler = () => { setUser(null); setChecking(false); };
    window.addEventListener("点单台登录失效", handler);
    return () => window.removeEventListener("点单台登录失效", handler);
  }, []);
  useEffect(() => { if (user) void loadHome(); }, [user]);
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(""), 5000); return () => window.clearTimeout(timer); }, [message]);

  if (checking) return <main className="login-shell"><div className="loading">正在检查登录状态…</div></main>;
  if (!user) return <Login onLogin={setUser} />;

  function logout() { setToken(""); setUser(null); setSelectedOrderId(""); }
  const content = selectedOrderId
    ? <OrderPage orderId={selectedOrderId} user={user} refreshTables={refreshTables} setMessage={setMessage} goBack={() => setSelectedOrderId("")} />
    : page === "tables" ? <TablesPage tables={tables} refresh={refreshTables} openOrder={setSelectedOrderId} setMessage={setMessage} />
      : page === "customers" ? <CustomersPage setMessage={setMessage} />
        : page === "dishes" ? <DishesPage categories={categories} user={user} setMessage={setMessage} reloadCategories={refreshCategories} />
          : page === "stats" ? <StatsPage setMessage={setMessage} />
            : <SettingsPage setMessage={setMessage} />;
  return <div className="app-shell"><Header user={user} page={page} setPage={(next) => { setSelectedOrderId(""); setPage(next); }} onLogout={logout} selectedOrder={Boolean(selectedOrderId)} />{message && <div className="toast">{message}<button onClick={() => setMessage("")}>×</button></div>}<main>{content}</main></div>;
}
