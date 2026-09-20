import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { api, businessDate, formatTime, getToken, money, requestKey, setToken, type User } from "./api.js";

type Page = "tables" | "orders" | "customers" | "dishes" | "stats" | "print" | "settings";
type Table = {
  id: string;
  number: number;
  name: string;
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
  gross_margin_percent: number;
  option_groups: DishOptionGroup[];
};
type DishOption = { id: string; label: string };
type DishOptionGroup = { id: string; name: string; required: boolean; allowMultiple: boolean; options: DishOption[] };
type DishOptionSelection = { groupId: string; optionIds: string[] };
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
  tableName: string | null;
  customer: { id: string | null; name: string; phone: string | null; points: number };
  peopleCount: number;
  status: string;
  orderVersion: number;
  openedAt: string;
  settledAt: string | null;
  endedAt: string | null;
  endReason: string;
  orderNote: string;
  items: OrderItem[];
  totals: { grossFen: number; giftFen: number; returnFen: number; subtotalFen: number; costFen: number; lossFen: number };
  revenueFen: number | null;
  grossProfitFen: number | null;
  grossMarginPercent: number | null;
  settlements: Array<{
    id: string;
    version: number;
    gross_fen: number;
    gift_fen: number;
    return_fen: number;
    manual_discount_fen: number;
    points_discount_fen: number;
    received_fen: number;
    payment_method: string;
    earned_points: number;
    redeemed_points: number;
    reason: string;
    status: string;
    settled_at: string;
    operator_name: string | null;
  }>;
};
type Settings = Record<string, unknown>;
type OrderSearchRow = {
  id: string;
  table_id: string | null;
  table_number: number | null;
  table_name: string | null;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  people_count: number;
  status: string;
  business_date: string;
  opened_at: string;
  settled_at: string | null;
  ended_at: string | null;
  end_reason: string;
  amount_fen: number;
  payment_method: string | null;
  item_count: number;
  revenue_fen: number | null;
  cost_fen: number;
  gross_profit_fen: number | null;
  gross_margin_percent: number | null;
};
type Employee = { id: string; username: string; name: string; role: "OWNER" | "CASHIER"; active: boolean; created_at: string };
type CartLine = { key: string; dish: Dish; quantity: number; customNote: string; selections: DishOptionSelection[] };
type PrintJob = {
  id: string;
  order_id: string | null;
  batch_id: string | null;
  kind: "KITCHEN" | "RETURN" | "RECEIPT";
  copy_no: number;
  payload: Record<string, unknown>;
  status: string;
  device_id: string | null;
  attempts: number;
  last_error: string | null;
  manual_requested_at: string | null;
  claimed_at: string | null;
  sent_at: string | null;
  created_at: string;
};
type PairedPrinter = { id: string; name: string };
type PrinterHostState = { enabled: boolean; connected: boolean; deviceId: string; deviceName: string; message: string };
interface PrinterHostPlugin {
  listPaired(): Promise<{ devices: PairedPrinter[] }>;
  configure(options: { deviceId: string; deviceName: string; printerToken: string; serverUrl: string }): Promise<PrinterHostState>;
  stop(): Promise<PrinterHostState>;
  status(): Promise<PrinterHostState>;
}
const PrinterHost = registerPlugin<PrinterHostPlugin>("PrinterHost");

function cartLineNote(line: CartLine): string {
  const optionNotes = line.selections.flatMap((selection) => {
    const group = line.dish.option_groups.find((candidate) => candidate.id === selection.groupId);
    if (!group) return [];
    const labels = group.options
      .filter((option) => selection.optionIds.includes(option.id))
      .map((option) => option.label);
    return labels.length ? [`${group.name}：${labels.join("、")}`] : [];
  });
  if (line.customNote) optionNotes.push(optionNotes.length ? `备注：${line.customNote}` : line.customNote);
  return optionNotes.join("，");
}

function formatItemNote(note: string): string {
  const parts = note.split(/[；;]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1) return parts[0].replace(/^备注[：:]\s*/, "");
  return parts.join("，");
}

function tableDisplayName(tableName: string | null | undefined, tableNumber: number | null | undefined): string {
  return tableName || (tableNumber ? `${tableNumber}号桌` : "无桌台");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

function centsFromYuan(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function statusText(status: string): string {
  return ({ OPEN: "进行中", SETTLED: "已结账", VOID: "未结账结束", REVERSED: "已撤销" } as Record<string, string>)[status] || status;
}

function Dialog({ title, description, children, onClose, className = "" }: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  return <div className="modal-backdrop"><div className={`modal ${className}`} role="dialog" aria-modal="true"><div className="modal-heading"><div><h2>{title}</h2>{description && <p className="muted">{description}</p>}</div><button type="button" className="close-button" onClick={onClose} aria-label="关闭">×</button></div>{children}</div></div>;
}

function ConfirmDialog({ title, message, confirmText = "确认", danger = false, busy = false, onClose, onConfirm }: {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return <Dialog title={title} onClose={onClose} className="confirm-modal"><p className="dialog-message">{message}</p><div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>返回</button><button type="button" className={danger ? "primary danger-button" : "primary"} onClick={onConfirm} disabled={busy}>{busy ? "处理中…" : confirmText}</button></div></Dialog>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
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
      <form className="login-card" noValidate onSubmit={submit}>
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
  const links: Array<[Page, string]> = [["tables", "桌台"], ["orders", "订单查询"], ["customers", "顾客"], ["dishes", "菜品"], ["print", "打印管理"]];
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
  const [openingTable, setOpeningTable] = useState<Table | null>(null);

  async function openTable(values: { phone: string; name: string; people: number }) {
    if (!openingTable) return;
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/tables/${openingTable.id}/open`, {
        method: "POST",
        body: JSON.stringify({ phone: values.phone, customerName: values.name, people: values.people, idempotencyKey: requestKey(`open-${openingTable.id}`) })
      });
      setOpeningTable(null);
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
          return <button key={table.id} className={`table-card ${occupied ? "occupied" : "available"}`} onClick={() => occupied ? openOrder(table.order!.id) : setOpeningTable(table)} disabled={busy || table.status === "DISABLED"}>
            <div className="table-name">{table.name}</div>
            <div className="table-number">{table.number}<small>号桌</small></div>
            <div className="table-state">{table.status === "DISABLED" ? "停用" : occupied ? "用餐中" : "空桌"}</div>
            <div className="table-detail">{occupied ? `${table.order!.customer.name} · ${table.order!.peopleCount} 人` : `${table.seats} 人桌`}</div>
            {occupied && <div className="table-total">{money(table.order!.currentFen)}</div>}
          </button>;
        })}
      </div>
      {!tables.length && <div className="empty">还没有可用桌台，请在“设置”中新增。</div>}
      {openingTable && <TableOpenDialog table={openingTable} busy={busy} onClose={() => setOpeningTable(null)} onSubmit={openTable} />}
    </section>
  );
}

function TableOpenDialog({ table, busy, onClose, onSubmit }: {
  table: Table;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: { phone: string; name: string; people: number }) => Promise<void>;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [people, setPeople] = useState("2");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSubmit({ phone: phone.trim(), name: name.trim(), people: Math.max(1, Number(people) || 1) });
  }
  return <Dialog title={`开台：${table.name}`} description="顾客手机号可留空；本单仍会完整记录到订单查询。" onClose={onClose} className="checkout-modal"><form noValidate onSubmit={submit}><div className="form-grid"><label>顾客手机号（可留空）<input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="留空表示散客" autoFocus /></label><label>顾客称呼（可留空）<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：张女士" /></label><label>用餐人数<input type="number" min="1" value={people} onChange={(event) => setPeople(event.target.value)} /></label></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? "开台中…" : "确认开台"}</button></div></form></Dialog>;
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
  const [previewOpen, setPreviewOpen] = useState(false);
  const [optionTarget, setOptionTarget] = useState<Dish | null>(null);
  const [noteTarget, setNoteTarget] = useState<{ key: string; note: string } | null>(null);
  const [orderNoteOpen, setOrderNoteOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ item: OrderItem; action: "gift" | "return" } | null>(null);
  const [confirmAction, setConfirmAction] = useState<"reopen" | "end" | null>(null);
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

  function selectionKey(dish: Dish, selections: DishOptionSelection[]): string {
    const normalized = selections
      .map((selection) => ({ groupId: selection.groupId, optionIds: [...selection.optionIds].sort() }))
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
    return `${dish.id}:${JSON.stringify(normalized)}`;
  }

  function addConfiguredDish(dish: Dish, selections: DishOptionSelection[], customNote = "") {
    const key = selectionKey(dish, selections);
    setCart((current) => {
      const line = current[key];
      return {
        ...current,
        [key]: line
          ? { ...line, quantity: line.quantity + 1 }
          : { key, dish, quantity: 1, customNote, selections }
      };
    });
  }

  function addDish(dish: Dish) {
    if (dish.option_groups.length) {
      setOptionTarget(dish);
      return;
    }
    addConfiguredDish(dish, []);
  }

  function changeCart(key: string, delta: number) {
    setCart((current) => {
      const line = current[key];
      if (!line) return current;
      const quantity = line.quantity + delta;
      if (quantity <= 0) {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: { ...line, quantity } };
    });
  }

  function editNote(key: string) {
    const line = cart[key];
    if (!line) return;
    setNoteTarget({ key, note: line.customNote });
  }

  function saveNote(note: string) {
    if (!noteTarget) return;
    const { key } = noteTarget;
    setCart((current) => {
      const line = current[key];
      return line ? { ...current, [key]: { ...line, customNote: note } } : current;
    });
    setNoteTarget(null);
  }

  async function saveOrderNote(note: string) {
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${orderId}/note`, {
        method: "PATCH",
        body: JSON.stringify({ note })
      });
      setOrder(result.order);
      setOrderNoteOpen(false);
      setMessage("本单备注已保存");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitItems() {
    const items = Object.values(cart).map((line) => ({ dishId: line.dish.id, quantity: line.quantity, note: line.customNote, options: line.selections }));
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

  async function itemAction(values: { quantity: number; reason: string; made: boolean }) {
    if (!actionTarget) return;
    const { item, action } = actionTarget;
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${orderId}/items/${item.id}/${action}`, { method: "POST", body: JSON.stringify(values) });
      setActionTarget(null);
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
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${orderId}/reopen`, { method: "POST", body: JSON.stringify({}) });
      setConfirmAction(null);
      setOrder(result.order);
      setMessage("已撤销结账并生成新账单，未重复打印厨房菜单");
      await refreshTables();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function endWithoutPayment() {
    setBusy(true);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${orderId}/end`, { method: "POST", body: JSON.stringify({ reason: "顾客未结账直接离开", idempotencyKey: requestKey(`end-${orderId}`) }) });
      setConfirmAction(null);
      setOrder(result.order);
      setMessage("本单已直接结束，未生成收款记录");
      await refreshTables();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (!order) return <section className="page-section"><div className="loading">正在读取账单…</div></section>;
  const cartTotal = Object.values(cart).reduce((sum, line) => sum + line.dish.price_fen * line.quantity, 0);
  const cartCost = Object.values(cart).reduce((sum, line) => sum + line.dish.cost_fen * line.quantity, 0);
  const displayRevenue = order.totals.subtotalFen + cartTotal;
  const displayCost = order.totals.costFen + cartCost;
  const displayMargin = displayRevenue > 0 ? Math.round(((displayRevenue - displayCost) / displayRevenue) * 10000) / 100 : 0;
  const open = order.status === "OPEN";
  const activeSettlement = order.settlements.find((settlement) => settlement.status === "ACTIVE");
  const previewTotalFen = open ? displayRevenue : activeSettlement?.received_fen ?? order.totals.subtotalFen;
  const previewTotalLabel = open ? "当前应收" : activeSettlement ? "实收" : "账单金额";
  const nativePreviewAction = Capacitor.isNativePlatform();
  return <section className="page-section order-page">
    <div className="section-heading order-heading"><div><button className="back-button" onClick={goBack}>‹ 桌台</button><h2>{order.tableName || (order.tableNumber ? `${order.tableNumber}号桌` : "账单")} <span className={`status-pill ${open ? "green" : "gray"}`}>{statusText(order.status)}</span></h2><p className="muted">{order.customer.name} · {order.peopleCount} 人 · 开台 {formatTime(order.openedAt)}{order.customer.phone ? ` · ${order.customer.phone}` : " · 未填写手机号"}</p>{order.orderNote && <p className="order-note"><span>本单备注：</span>{order.orderNote}</p>}</div><div className="heading-actions"><button className={`secondary preview-full-order-button${nativePreviewAction ? " native-preview-full-order-button" : ""}`} onClick={() => setPreviewOpen(true)}>预览全单</button>{open && <button className="secondary" onClick={() => setOrderNoteOpen(true)} disabled={busy}>本单备注</button>}{order.status === "SETTLED" && user.role === "OWNER" && <button className="secondary" onClick={() => setConfirmAction("reopen")} disabled={busy}>撤销重结</button>}{open && <><button className="secondary danger-outline" onClick={() => setConfirmAction("end")} disabled={busy}>直接结束</button><button className="primary" onClick={() => setCheckoutOpen(true)} disabled={busy || !order.items.length}>结账 {money(order.totals.subtotalFen)}</button></>}</div></div>
    <div className="order-layout">
      <div className="catalog-panel">
        <div className="search-row"><input placeholder="搜索菜名、拼音或首字母" value={search} onChange={(event) => setSearch(event.target.value)} /><button className="secondary" onClick={() => setSearch("")}>清空</button></div>
        <div className="category-row" role="group" aria-label="按分类浏览菜品"><button aria-pressed={!categoryId} className={!categoryId ? "category-chip selected" : "category-chip"} onClick={() => setCategoryId("")}>全部</button>{categories.map((category) => <button aria-pressed={categoryId === category.id} className={categoryId === category.id ? "category-chip selected" : "category-chip"} key={category.id} onClick={() => setCategoryId(category.id)}>{category.name}</button>)}</div>
        <div className="dish-grid">{visibleDishes.map((dish) => { const quantity = Object.values(cart).filter((line) => line.dish.id === dish.id).reduce((sum, line) => sum + line.quantity, 0); return <button className="dish-card" key={dish.id} onClick={() => addDish(dish)} disabled={!open || busy}><span className="dish-name">{dish.name}</span><span className="dish-meta">{dish.unit} · {money(dish.price_fen)}</span><span className="dish-margin">毛利率 {dish.gross_margin_percent}%{dish.option_groups.length ? " · 可选口味" : ""}</span>{quantity > 0 && <span className="dish-quantity-badge">{quantity}</span>}</button>; })}</div>
        {!visibleDishes.length && <div className="empty">暂无匹配菜品，请在“菜品”中配置。</div>}
      </div>
      <aside className="current-order">
        <div className="order-card-heading"><h3>订单总览</h3><span>{order.items.length} 项已提交</span></div>
        <div className="order-lines">{order.items.map((item) => <div className="order-line" key={item.id}><div className="line-main"><strong>{item.name}</strong><span>{money(item.priceFen)} × {item.quantity}</span>{item.note && <small>{formatItemNote(item.note)}</small>}{(item.giftedQuantity > 0 || item.returnedQuantity > 0) && <small className="line-flags">{item.giftedQuantity ? `赠${item.giftedQuantity}` : ""}{item.returnedQuantity ? ` 退${item.returnedQuantity}` : ""}</small>}</div>{open && <div className="line-actions"><button onClick={() => setActionTarget({ item, action: "gift" })} disabled={!item.availableQuantity}>赠送</button><button onClick={() => setActionTarget({ item, action: "return" })} disabled={item.returnedQuantity >= item.quantity}>退菜</button></div>}</div>)}</div>
        {Object.keys(cart).length > 0 && <div className="cart-box"><div className="order-card-heading"><h3>待提交</h3><span>{money(cartTotal)}</span></div>{Object.values(cart).map((line) => { const note = cartLineNote(line); return <div className="cart-line" key={line.key}><div><strong>{line.dish.name}</strong><small className={note ? "line-note" : "line-note placeholder"}>{note || "点击备注填写口味"}</small></div><button onClick={() => editNote(line.key)}>备注</button><div className="quantity"><button onClick={() => changeCart(line.key, -1)}>−</button><span>{line.quantity}</span><button onClick={() => changeCart(line.key, 1)}>＋</button></div></div>; })}<button className="primary wide" onClick={submitItems} disabled={busy}>提交并打印两份</button></div>}
        <div className="order-total"><span>当前应收</span><strong>{money(displayRevenue)}</strong><small>原价 {money(order.totals.grossFen + cartTotal)} · 赠送 {money(order.totals.giftFen)} · 退菜 {money(order.totals.returnFen)}</small><div className="order-margin">本单毛利率 <strong>{displayMargin}%</strong></div></div>
      </aside>
    </div>
    {previewOpen && <OrderPreviewDialog order={order} cartLines={Object.values(cart)} totalFen={previewTotalFen} totalLabel={previewTotalLabel} onClose={() => setPreviewOpen(false)} />}
    {checkoutOpen && <CheckoutPanel order={order} onClose={() => setCheckoutOpen(false)} onDone={async (nextOrder, message) => { setOrder(nextOrder); setCheckoutOpen(false); setMessage(message); await refreshTables(); }} />}
    {optionTarget && <DishOptionsDialog dish={optionTarget} onClose={() => setOptionTarget(null)} onSubmit={(selections, note) => { addConfiguredDish(optionTarget, selections, note); setOptionTarget(null); }} />}
    {noteTarget && <NoteDialog note={noteTarget.note} title="填写自定义备注" onClose={() => setNoteTarget(null)} onSubmit={saveNote} />}
    {orderNoteOpen && <NoteDialog note={order.orderNote} title="本单备注" onClose={() => setOrderNoteOpen(false)} onSubmit={(note) => void saveOrderNote(note)} />}
    {actionTarget && <ItemActionDialog item={actionTarget.item} action={actionTarget.action} busy={busy} onClose={() => setActionTarget(null)} onSubmit={itemAction} />}
    {confirmAction === "reopen" && <ConfirmDialog title="撤销并重新开账" message="原账单、积分冲销和新账单都会保留，是否继续？" confirmText="确认撤销重结" busy={busy} onClose={() => setConfirmAction(null)} onConfirm={() => void reopen()} />}
    {confirmAction === "end" && <ConfirmDialog title="直接结束本单" message="本单将释放桌台，不生成结账或收款记录；订单仍会保留在订单查询中。" confirmText="直接结束" danger busy={busy} onClose={() => setConfirmAction(null)} onConfirm={() => void endWithoutPayment()} />}
  </section>;
}

function OrderPreviewDialog({ order, cartLines, totalFen, totalLabel, onClose }: {
  order: Order;
  cartLines: CartLine[];
  totalFen: number;
  totalLabel: string;
  onClose: () => void;
}) {
  const rows = [
    ...order.items.map((item) => ({
      key: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      priceFen: item.priceFen,
      note: item.note,
      state: "已提交"
    })),
    ...cartLines.map((line) => ({
      key: line.key,
      name: line.dish.name,
      quantity: line.quantity,
      unit: line.dish.unit,
      priceFen: line.dish.price_fen,
      note: cartLineNote(line),
      state: "待提交"
    }))
  ];
  return <Dialog title="全单预览" description={`${tableDisplayName(order.tableName, order.tableNumber)} · ${order.peopleCount} 人 · ${rows.length} 项`} onClose={onClose} className="order-preview-modal">
    {rows.length > 0 ? <div className="order-preview-list">{rows.map((row) => <div className="order-preview-row" key={row.key}>
      <div className="order-preview-main"><strong>{row.name}</strong><span>{row.quantity} {row.unit} × {money(row.priceFen)}<b>{money(row.quantity * row.priceFen)}</b></span></div>
      <span className={`status-pill ${row.state === "待提交" ? "gray" : "green"}`}>{row.state}</span>
      {row.note && <small>{formatItemNote(row.note)}</small>}
    </div>)}</div> : <div className="empty">还没有选择菜品</div>}
    <div className="order-preview-total"><span>{totalLabel}</span><strong>{money(totalFen)}</strong></div>
    <div className="modal-actions"><button className="secondary" onClick={onClose}>关闭</button></div>
  </Dialog>;
}

function DishOptionsDialog({ dish, onClose, onSubmit }: { dish: Dish; onClose: () => void; onSubmit: (selections: DishOptionSelection[], note: string) => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  function toggle(group: DishOptionGroup, optionId: string) {
    setSelected((current) => {
      const previous = current[group.id] || [];
      const next = group.allowMultiple
        ? previous.includes(optionId) ? previous.filter((id) => id !== optionId) : [...previous, optionId]
        : previous.includes(optionId) ? [] : [optionId];
      return { ...current, [group.id]: next };
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const missing = dish.option_groups.find((group) => group.required && !(selected[group.id] || []).length);
    if (missing) {
      setError(`请选择${missing.name}`);
      return;
    }
    setError("");
    onSubmit(dish.option_groups.map((group) => ({ groupId: group.id, optionIds: selected[group.id] || [] })).filter((selection) => selection.optionIds.length), note.trim());
  }
  return <Dialog title={`选择${dish.name}备注`} description="可直接选择口味，也可以补充自定义备注" onClose={onClose} className="option-modal"><form noValidate onSubmit={submit}>{dish.option_groups.map((group) => <div className="option-group" key={group.id}><div className="option-group-heading"><strong>{group.name}</strong><small>{group.required ? "必选" : "可不选"}{group.allowMultiple ? " · 可多选" : " · 单选"}</small></div><div className="option-chips">{group.options.map((option) => <button type="button" key={option.id} className={(selected[group.id] || []).includes(option.id) ? "option-chip selected" : "option-chip"} onClick={() => toggle(group, option.id)}>{option.label}</button>)}</div></div>)}<label>自定义备注（可留空）<textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="例如：不要香菜、打包" /></label>{error && <div className="message error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary">加入待提交</button></div></form></Dialog>;
}

function NoteDialog({ note, title = "填写备注", onClose, onSubmit }: { note: string; title?: string; onClose: () => void; onSubmit: (note: string) => void }) {
  const [value, setValue] = useState(note);
  return <Dialog title={title} onClose={onClose}><form noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(value.trim()); }}><label>备注内容<textarea value={value} onChange={(event) => setValue(event.target.value)} rows={4} autoFocus placeholder="例如：少辣、不要香菜" /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary">保存备注</button></div></form></Dialog>;
}

function ItemActionDialog({ item, action, busy, onClose, onSubmit }: { item: OrderItem; action: "gift" | "return"; busy: boolean; onClose: () => void; onSubmit: (values: { quantity: number; reason: string; made: boolean }) => Promise<void> }) {
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [made, setMade] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = Math.max(0, Number(quantity) || 0);
    if (!parsed || parsed > item.availableQuantity) {
      setError(`数量必须在 1 到 ${item.availableQuantity} 之间`);
      return;
    }
    setError("");
    await onSubmit({ quantity: parsed, reason: reason.trim(), made: action === "return" && made });
  }
  return <Dialog title={action === "gift" ? "记录赠送" : "记录退菜"} description={`${item.name}，可操作 ${item.availableQuantity} ${item.unit}`} onClose={onClose}><form noValidate onSubmit={submit}><div className="form-grid"><label>{action === "gift" ? "赠送数量" : "退菜数量"}<input type="number" min="1" max={item.availableQuantity} value={quantity} onChange={(event) => setQuantity(event.target.value)} autoFocus /></label><label>{action === "gift" ? "赠送原因（可留空）" : "退菜原因（可留空）"}<input value={reason} onChange={(event) => setReason(event.target.value)} /></label></div>{action === "return" && <label className="checkbox-row"><input type="checkbox" checked={made} onChange={(event) => setMade(event.target.checked)} />这道菜已经制作</label>}{error && <div className="message error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? "保存中…" : "确认"}</button></div></form></Dialog>;
}

function CheckoutPanel({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (order: Order, message: string) => Promise<void> }) {
  const [discount, setDiscount] = useState("0");
  const [usePoints, setUsePoints] = useState(false);
  const [pointSettings, setPointSettings] = useState({ enabled: true, redeemPoints: 10, redeemFen: 100 });
  const [received, setReceived] = useState((order.totals.subtotalFen / 100).toFixed(2));
  const [payment, setPayment] = useState("现金");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const manualFen = centsFromYuan(discount);
  const baseDueFen = Math.max(0, order.totals.subtotalFen - manualFen);
  const maxByBalance = Math.floor(Math.max(0, Number(order.customer.points || 0)) / pointSettings.redeemPoints) * pointSettings.redeemPoints;
  const maxByAmount = Math.floor(baseDueFen / pointSettings.redeemFen) * pointSettings.redeemPoints;
  const pointsUsed = usePoints ? Math.min(maxByBalance, maxByAmount) : 0;
  const pointsDiscountFen = Math.floor(pointsUsed / pointSettings.redeemPoints) * pointSettings.redeemFen;
  const dueFen = Math.max(0, baseDueFen - pointsDiscountFen);
  const projectedMargin = dueFen > 0 ? Math.round(((dueFen - order.totals.costFen) / dueFen) * 10000) / 100 : 0;

  useEffect(() => {
    api<{ settings: Settings }>("/api/settings").then(({ settings }) => {
      const next = {
        enabled: Boolean(settings.points_enabled),
        redeemPoints: Math.max(1, Number(settings.points_redeem_points) || 10),
        redeemFen: Math.max(1, Number(settings.points_redeem_fen) || 100)
      };
      setPointSettings(next);
      if (!next.enabled) setUsePoints(false);
    }).catch(() => undefined);
  }, []);

  useEffect(() => { setReceived((dueFen / 100).toFixed(2)); }, [dueFen]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ order: Order; settlement: { receivedFen: number; pointsBalance: number } }>(`/api/orders/${order.id}/checkout`, {
        method: "POST",
        body: JSON.stringify({ manualDiscountFen: manualFen, usePoints, receivedFen: centsFromYuan(received), paymentMethod: payment, idempotencyKey: requestKey(`checkout-${order.id}`) })
      });
      await onDone(result.order, `结账完成，打印任务已生成，积分余额 ${result.settlement.pointsBalance} 分`);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title="确认结账" description={`${order.tableName || `${order.tableNumber || ""}号桌`} · ${order.customer.name}`} onClose={onClose} className="checkout-modal"><form noValidate onSubmit={submit}><div className="checkout-summary"><div><span>菜品原价</span><strong>{money(order.totals.grossFen)}</strong></div><div><span>赠送</span><strong>-{money(order.totals.giftFen)}</strong></div><div><span>退菜</span><strong>-{money(order.totals.returnFen)}</strong></div><div className="emphasis"><span>结账前应收</span><strong>{money(order.totals.subtotalFen)}</strong></div></div><div className="form-grid"><label>人工减免（元）<input type="number" min="0" step="0.01" value={discount} onChange={(event) => setDiscount(event.target.value)} /></label><label className="points-choice"><span>积分抵扣</span><span className="checkbox-row"><input type="checkbox" checked={usePoints} disabled={!order.customer.id || !pointSettings.enabled || order.customer.points <= 0} onChange={(event) => setUsePoints(event.target.checked)} />使用积分</span><small>{!order.customer.id ? "散客不能使用积分" : !pointSettings.enabled ? "积分功能未开启" : `可用 ${order.customer.points} 分，自动抵扣 ${pointsUsed} 分（${money(pointsDiscountFen)}）`}</small></label><label>收款方式<select value={payment} onChange={(event) => setPayment(event.target.value)}><option>现金</option><option>微信</option><option>支付宝</option><option>银行卡</option><option>其他</option></select></label><label>实收金额（元）<input type="number" min="0" step="0.01" value={received} onChange={(event) => setReceived(event.target.value)} /></label></div>{error && <div className="message error">{error}</div>}<div className="payable-banner"><span>本次应收<strong>{money(dueFen)}</strong></span><small>预计本单毛利率 {projectedMargin}%</small></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>返回修改</button><button className="primary" disabled={busy}>{busy ? "结账中…" : "确认收款并打印小票"}</button></div></form></Dialog>;
}

function OrderQueryPage({ openOrder, setMessage }: { openOrder: (orderId: string) => void; setMessage: (message: string) => void }) {
  const [filters, setFilters] = useState({ from: "", to: "", minAmount: "", maxAmount: "", q: "", status: "", paymentMethod: "" });
  const [orders, setOrders] = useState<OrderSearchRow[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.minAmount) params.set("minFen", String(centsFromYuan(filters.minAmount)));
      if (filters.maxAmount) params.set("maxFen", String(centsFromYuan(filters.maxAmount)));
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.status) params.set("status", filters.status);
      if (filters.paymentMethod) params.set("paymentMethod", filters.paymentMethod);
      const result = await api<{ orders: OrderSearchRow[] }>(`/api/orders/search?${params.toString()}`);
      setOrders(result.orders);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function showDetail(id: string) {
    try {
      const result = await api<{ order: Order }>(`/api/orders/${id}`);
      setSelected(result.order);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  useEffect(() => { void load(); }, []);
  function setFilter(key: keyof typeof filters, value: string) { setFilters((current) => ({ ...current, [key]: value })); }

  return <section className="page-section"><div className="section-heading"><div><h2>订单查询</h2><p className="muted">按时间、金额、状态、桌台、顾客或收款方式查询，未填写手机号的订单也会保留。</p></div><button className="secondary" onClick={load} disabled={busy}>刷新</button></div><div className="content-card order-query-card"><div className="filter-grid"><label>开始日期<input type="date" value={filters.from} onChange={(event) => setFilter("from", event.target.value)} /></label><label>结束日期<input type="date" value={filters.to} onChange={(event) => setFilter("to", event.target.value)} /></label><label>最低金额（元）<input type="number" min="0" step="0.01" value={filters.minAmount} onChange={(event) => setFilter("minAmount", event.target.value)} /></label><label>最高金额（元）<input type="number" min="0" step="0.01" value={filters.maxAmount} onChange={(event) => setFilter("maxAmount", event.target.value)} /></label><label className="filter-wide">关键字<input placeholder="订单号、桌台、顾客称呼或手机号" value={filters.q} onChange={(event) => setFilter("q", event.target.value)} /></label><label>订单状态<select value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部状态</option><option value="OPEN">进行中</option><option value="SETTLED">已结账</option><option value="VOID">未结账结束</option><option value="REVERSED">已撤销</option></select></label><label>收款方式<select value={filters.paymentMethod} onChange={(event) => setFilter("paymentMethod", event.target.value)}><option value="">全部方式</option><option>现金</option><option>微信</option><option>支付宝</option><option>银行卡</option><option>其他</option></select></label></div><div className="filter-actions"><button className="primary" onClick={load} disabled={busy}>{busy ? "查询中…" : "查询订单"}</button><button className="secondary" onClick={() => { setFilters({ from: "", to: "", minAmount: "", maxAmount: "", q: "", status: "", paymentMethod: "" }); }}>清空条件</button></div></div><div className="content-card"><table><thead><tr><th>时间</th><th>桌台</th><th>顾客</th><th>手机号</th><th>状态</th><th>菜品数量</th><th>金额</th><th>毛利率</th><th>收款方式</th><th></th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td>{formatTime(order.opened_at)}</td><td>{order.table_name || (order.table_number ? `${order.table_number}号桌` : "无桌台")}</td><td>{order.customer_name || "散客"}</td><td>{order.customer_phone || "未填写"}</td><td><span className={`status-pill ${order.status === "OPEN" ? "green" : "gray"}`}>{statusText(order.status)}</span></td><td>{order.item_count}</td><td>{money(order.amount_fen)}</td><td>{order.gross_margin_percent === null ? "—" : `${order.gross_margin_percent}%`}</td><td>{order.payment_method || "—"}</td><td><button className="text-button" onClick={() => void showDetail(order.id)}>查看详情</button></td></tr>)}</tbody></table>{!orders.length && <div className="empty">没有符合条件的订单</div>}</div>{selected && <OrderDetailDialog order={selected} onClose={() => setSelected(null)} onContinue={selected.status === "OPEN" ? () => { setSelected(null); openOrder(selected.id); } : undefined} />}</section>;
}

function OrderDetailDialog({ order, onClose, onContinue }: { order: Order; onClose: () => void; onContinue?: () => void }) {
  return <Dialog title="订单详情" description={`${order.tableName || (order.tableNumber ? `${order.tableNumber}号桌` : "无桌台")} · ${statusText(order.status)}`} onClose={onClose} className="detail-modal large-modal"><div className="detail-summary"><div><span>顾客</span><strong>{order.customer.name || "散客"}</strong></div><div><span>手机号</span><strong>{order.customer.phone || "未填写"}</strong></div><div><span>人数</span><strong>{order.peopleCount} 人</strong></div><div><span>开台时间</span><strong>{formatTime(order.openedAt)}</strong></div><div><span>结束时间</span><strong>{formatTime(order.endedAt || order.settledAt)}</strong></div><div><span>本单毛利率</span><strong>{order.grossMarginPercent === null ? "—" : `${order.grossMarginPercent}%`}</strong></div></div>{order.orderNote && <p className="order-note"><span>本单备注：</span>{order.orderNote}</p>}<h3>菜品明细</h3><div className="mini-list order-detail-items">{order.items.map((item) => <div key={item.id}><span>{item.name} × {item.quantity}{item.note ? `（${item.note}）` : ""}</span><strong>{money(item.priceFen * item.quantity)}</strong><small>{item.giftedQuantity ? `赠送 ${item.giftedQuantity}` : ""}{item.returnedQuantity ? ` 退菜 ${item.returnedQuantity}` : ""}</small></div>)}</div><div className="checkout-summary detail-checkout-summary"><div><span>原价</span><strong>{money(order.totals.grossFen)}</strong></div><div><span>赠送</span><strong>-{money(order.totals.giftFen)}</strong></div><div><span>退菜</span><strong>-{money(order.totals.returnFen)}</strong></div><div className="emphasis"><span>有效收入</span><strong>{money(order.revenueFen ?? order.totals.subtotalFen)}</strong></div></div>{order.endReason && <p className="muted">结束说明：{order.endReason}</p>}{order.settlements.length > 0 && <><h3>结账记录</h3><div className="mini-list">{order.settlements.map((settlement) => <div key={settlement.id}><span>第 {settlement.version} 次 · {settlement.payment_method} · {settlement.status === "ACTIVE" ? "有效" : "已撤销"}</span><strong>{money(settlement.received_fen)}</strong><small>{formatTime(settlement.settled_at)} · {settlement.operator_name || "未知操作员"} · 积分抵扣 {settlement.redeemed_points} 分 · 人工减免 {money(settlement.manual_discount_fen)}</small></div>)}</div></>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>关闭</button>{onContinue && <button type="button" className="primary" onClick={onContinue}>继续处理</button>}</div></Dialog>;
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

type DishFormState = { name: string; pinyin: string; categoryId: string; price: string; cost: string; unit: string; optionGroups: OptionGroupDraft[] };
type OptionGroupDraft = { id: string; name: string; required: boolean; allowMultiple: boolean; options: string[] };

function newDishForm(categoryId = ""): DishFormState {
  return { name: "", pinyin: "", categoryId, price: "", cost: "", unit: "份", optionGroups: [] };
}

function dishToForm(dish: Dish): DishFormState {
  return {
    name: dish.name,
    pinyin: dish.pinyin,
    categoryId: dish.category_id || "",
    price: (dish.price_fen / 100).toFixed(2),
    cost: (dish.cost_fen / 100).toFixed(2),
    unit: dish.unit,
    optionGroups: dish.option_groups.map((group) => ({
      id: group.id,
      name: group.name,
      required: group.required,
      allowMultiple: group.allowMultiple,
      options: group.options.map((option) => option.label)
    }))
  };
}

function DishOptionEditor({ groups, onChange }: { groups: OptionGroupDraft[]; onChange: (groups: OptionGroupDraft[]) => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  function update(index: number, patch: Partial<OptionGroupDraft>) {
    onChange(groups.map((group, groupIndex) => groupIndex === index ? { ...group, ...patch } : group));
  }
  function addOption(index: number) {
    const group = groups[index];
    const value = (inputs[group.id] || "").trim();
    if (!value || group.options.includes(value)) return;
    update(index, { options: [...group.options, value] });
    setInputs((current) => ({ ...current, [group.id]: "" }));
  }
  return <div className="options-editor"><div className="options-editor-heading"><div><strong>点菜备注选项</strong><small>例如“辣度”设置为不辣、微辣、中辣；不设置也可以只填写自定义备注。</small></div><button type="button" className="secondary" onClick={() => onChange([...groups, { id: `new-${crypto.randomUUID()}`, name: "", required: false, allowMultiple: false, options: [] }])}>新增备注问题</button></div>{groups.map((group, index) => <div className="option-editor-group" key={group.id}><div className="option-editor-top"><input placeholder="问题名称，例如：辣度" value={group.name} onChange={(event) => update(index, { name: event.target.value })} /><label className="checkbox-row"><input type="checkbox" checked={group.required} onChange={(event) => update(index, { required: event.target.checked })} />必选</label><label className="checkbox-row"><input type="checkbox" checked={group.allowMultiple} onChange={(event) => update(index, { allowMultiple: event.target.checked })} />可多选</label><button type="button" className="text-button danger-text" onClick={() => onChange(groups.filter((_, groupIndex) => groupIndex !== index))}>删除问题</button></div><div className="option-edit-list">{group.options.map((option) => <span className="option-edit-chip" key={option}>{option}<button type="button" onClick={() => update(index, { options: group.options.filter((item) => item !== option) })}>×</button></span>)}</div><div className="option-add-row"><input placeholder="输入选项后回车" value={inputs[group.id] || ""} onChange={(event) => setInputs((current) => ({ ...current, [group.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addOption(index); } }} /><button type="button" className="secondary" onClick={() => addOption(index)}>添加选项</button></div></div>)}</div>;
}

function DishesPage({ categories, user, setMessage, reloadCategories }: { categories: Category[]; user: User; setMessage: (message: string) => void; reloadCategories: () => Promise<void> }) {
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<DishFormState>(newDishForm(categories[0]?.id || ""));
  const [editing, setEditing] = useState<DishFormState | null>(null);
  const [editingId, setEditingId] = useState("");
  const [archiveId, setArchiveId] = useState("");
  const [categoryDialog, setCategoryDialog] = useState(false);
  async function load() { try { const result = await api<{ dishes: Dish[] }>(`/api/dishes?q=${encodeURIComponent(query)}`); setDishes(result.dishes); } catch (error) { setMessage(errorText(error)); } }
  useEffect(() => { void load(); }, [query]);
  useEffect(() => { if (!form.categoryId && categories[0]) setForm((current) => ({ ...current, categoryId: categories[0].id })); }, [categories]);
  function dishPayload(values: DishFormState) { return { name: values.name, pinyin: values.pinyin, categoryId: values.categoryId || null, priceFen: centsFromYuan(values.price), costFen: centsFromYuan(values.cost), unit: values.unit }; }
  async function saveOptions(dishId: string, groups: OptionGroupDraft[]) { await api(`/api/dishes/${dishId}/options`, { method: "PUT", body: JSON.stringify({ groups: groups.map((group) => ({ name: group.name, required: group.required, allowMultiple: group.allowMultiple, options: group.options.map((label) => ({ label })) })) }) }); }
  async function addDish(event: FormEvent) { event.preventDefault(); if (!form.name.trim()) return setMessage("菜品名称不能为空"); if (form.optionGroups.some((group) => !group.name.trim() || !group.options.length)) return setMessage("请补全备注问题和选项"); try { const result = await api<{ dishId: string }>("/api/dishes", { method: "POST", body: JSON.stringify(dishPayload(form)) }); await saveOptions(result.dishId, form.optionGroups); setForm(newDishForm(categories[0]?.id || "")); await load(); setMessage("菜品已保存"); } catch (error) { setMessage(errorText(error)); } }
  async function updateDish(event: FormEvent) { event.preventDefault(); if (!editing || !editingId) return; if (!editing.name.trim()) return setMessage("菜品名称不能为空"); if (editing.optionGroups.some((group) => !group.name.trim() || !group.options.length)) return setMessage("请补全备注问题和选项"); try { await api(`/api/dishes/${editingId}`, { method: "PATCH", body: JSON.stringify(dishPayload(editing)) }); await saveOptions(editingId, editing.optionGroups); setEditing(null); setEditingId(""); await load(); setMessage("菜品信息已修改"); } catch (error) { setMessage(errorText(error)); } }
  async function archive() { try { await api(`/api/dishes/${archiveId}`, { method: "DELETE" }); setArchiveId(""); await load(); setMessage("菜品已归档"); } catch (error) { setMessage(errorText(error)); } }
  return <section className="page-section"><div className="section-heading"><div><h2>菜品</h2><p className="muted">售价、成本、毛利率和备注选项只影响新订单，历史账单使用快照</p></div>{user.role === "OWNER" && <button className="secondary" onClick={() => setCategoryDialog(true)}>管理分类</button>}</div>{user.role === "OWNER" && <form className="content-card dish-form" noValidate onSubmit={addDish}><h3>新增菜品</h3><div className="form-grid five"><label>菜名<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>拼音/首字母<input value={form.pinyin} onChange={(event) => setForm({ ...form, pinyin: event.target.value })} placeholder="可选" /></label><label>分类<select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>售价（元）<input type="number" min="0" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></label><label>成本（元）<input type="number" min="0" step="0.01" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} /></label></div><DishOptionEditor groups={form.optionGroups} onChange={(optionGroups) => setForm({ ...form, optionGroups })} /><button className="primary">保存菜品</button></form>}<div className="search-row large"><input placeholder="搜索菜品" value={query} onChange={(event) => setQuery(event.target.value)} /><button className="secondary" onClick={() => setQuery("")}>清空</button></div><div className="content-card"><table><thead><tr><th>菜品</th><th>分类</th><th>售价</th><th>成本</th><th>毛利率</th><th>备注问题</th><th>单位</th>{user.role === "OWNER" && <th></th>}</tr></thead><tbody>{dishes.map((dish) => <tr key={dish.id}><td>{dish.name}</td><td>{dish.category_name || "未分类"}</td><td>{money(dish.price_fen)}</td><td>{user.role === "OWNER" ? money(dish.cost_fen) : "—"}</td><td>{dish.gross_margin_percent}%</td><td>{dish.option_groups.length ? `${dish.option_groups.length} 个` : "无"}</td><td>{dish.unit}</td>{user.role === "OWNER" && <td><button className="text-button" onClick={() => { setEditing(dishToForm(dish)); setEditingId(dish.id); }}>修改</button><button className="text-button danger-text" onClick={() => setArchiveId(dish.id)}>归档</button></td>}</tr>)}</tbody></table>{!dishes.length && <div className="empty">还没有在售菜品</div>}</div>{categoryDialog && <CategoryManagerDialog categories={categories} onClose={() => setCategoryDialog(false)} onChanged={reloadCategories} setMessage={setMessage} />}{editing && <Dialog title="修改菜品" description="修改只影响之后新加的菜品，历史订单不会变化。" onClose={() => { setEditing(null); setEditingId(""); }} className="large-modal"><form noValidate onSubmit={updateDish}><div className="form-grid"><label>菜名<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label>拼音/首字母<input value={editing.pinyin} onChange={(event) => setEditing({ ...editing, pinyin: event.target.value })} /></label><label>分类<select value={editing.categoryId} onChange={(event) => setEditing({ ...editing, categoryId: event.target.value })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>单位<input value={editing.unit} onChange={(event) => setEditing({ ...editing, unit: event.target.value })} /></label><label>售价（元）<input type="number" min="0" step="0.01" value={editing.price} onChange={(event) => setEditing({ ...editing, price: event.target.value })} /></label><label>成本（元）<input type="number" min="0" step="0.01" value={editing.cost} onChange={(event) => setEditing({ ...editing, cost: event.target.value })} /></label></div><DishOptionEditor groups={editing.optionGroups} onChange={(optionGroups) => setEditing({ ...editing, optionGroups })} /><div className="modal-actions"><button type="button" className="secondary" onClick={() => { setEditing(null); setEditingId(""); }}>取消</button><button className="primary">保存修改</button></div></form></Dialog>}{archiveId && <ConfirmDialog title="归档菜品" message="停售并归档这道菜？历史账单不会受影响。" confirmText="确认归档" danger onClose={() => setArchiveId("")} onConfirm={() => void archive()} />}</section>;
}

function CategoryManagerDialog({ categories, onClose, onChanged, setMessage }: { categories: Category[]; onClose: () => void; onChanged: () => Promise<void>; setMessage: (message: string) => void }) {
  const [name, setName] = useState("");
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(categories.map((category) => [category.id, category.name])));
  const [deleteId, setDeleteId] = useState("");
  useEffect(() => { setNames(Object.fromEntries(categories.map((category) => [category.id, category.name]))); }, [categories]);
  async function add() { if (!name.trim()) return setMessage("分类名称不能为空"); try { await api("/api/categories", { method: "POST", body: JSON.stringify({ name: name.trim() }) }); setName(""); await onChanged(); setMessage("分类已新增"); } catch (error) { setMessage(errorText(error)); } }
  async function update(id: string) { try { await api(`/api/categories/${id}`, { method: "PATCH", body: JSON.stringify({ name: names[id] }) }); await onChanged(); setMessage("分类已修改"); } catch (error) { setMessage(errorText(error)); } }
  async function archive() { try { await api(`/api/categories/${deleteId}`, { method: "DELETE" }); setDeleteId(""); await onChanged(); setMessage("分类已停用"); } catch (error) { setMessage(errorText(error)); } }
  return <Dialog title="分类管理" description="停用分类不会删除历史订单里的分类快照。" onClose={onClose} className="large-modal"><div className="category-manager-list">{categories.map((category) => <div className="category-manager-row" key={category.id}><input value={names[category.id] || ""} onChange={(event) => setNames((current) => ({ ...current, [category.id]: event.target.value }))} /><button className="secondary" onClick={() => void update(category.id)}>保存</button><button className="text-button danger-text" onClick={() => setDeleteId(category.id)}>停用</button></div>)}</div><div className="category-add-row"><input placeholder="新增分类名称" value={name} onChange={(event) => setName(event.target.value)} /><button className="primary" onClick={() => void add()}>新增分类</button></div><div className="modal-actions"><button className="secondary" onClick={onClose}>关闭</button></div>{deleteId && <ConfirmDialog title="停用分类" message="停用后不能再给新菜品选择，但历史订单仍会保留。" confirmText="确认停用" danger onClose={() => setDeleteId("")} onConfirm={() => void archive()} />}</Dialog>;
}

function printKindText(kind: string): string {
  return ({ KITCHEN: "备菜单", RETURN: "退菜单", RECEIPT: "结账小票" } as Record<string, string>)[kind] || kind;
}

function printStatusText(status: string): string {
  return ({ PENDING: "待打印", CLAIMED: "打印中", SENT: "已打印", FAILED: "打印失败", NEEDS_CHECK: "待核对" } as Record<string, string>)[status] || status;
}

function PrintManagementPage({ setMessage }: { setMessage: (message: string) => void }) {
  const [status, setStatus] = useState("PENDING");
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [selected, setSelected] = useState<PrintJob | null>(null);
  const [busy, setBusy] = useState(false);
  const tabs: Array<[string, string]> = [["PENDING", "打印队列"], ["CLAIMED", "打印中"], ["SENT", "已打印"], ["FAILED", "失败"], ["NEEDS_CHECK", "待核对"]];
  async function load() {
    setBusy(true);
    try {
      const result = await api<{ jobs: PrintJob[] }>(`/api/print-jobs?status=${status}&limit=100`);
      setJobs(result.jobs);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, [status]);
  async function dispatch(job: PrintJob) {
    try { await api(`/api/print-jobs/${job.id}/dispatch`, { method: "POST" }); await load(); setMessage("已发送手动打印指令；设备离线时任务会继续保留"); } catch (error) { setMessage(errorText(error)); }
  }
  async function reprint(job: PrintJob) {
    try { await api(`/api/print-jobs/${job.id}/reprint`, { method: "POST" }); setStatus("PENDING"); setMessage("已生成补打任务"); } catch (error) { setMessage(errorText(error)); }
  }
  return <section className="page-section"><div className="section-heading"><div><h2>打印管理</h2><p className="muted">打印机离线或失败的任务不会在重连时自动补打，需要在这里手动点击打印。</p></div><button className="secondary" onClick={() => void load()} disabled={busy}>刷新</button></div><div className="print-tabs">{tabs.map(([key, label]) => <button key={key} className={status === key ? "category-chip selected" : "category-chip"} onClick={() => setStatus(key)}>{label}</button>)}</div><div className="content-card"><table><thead><tr><th>生成时间</th><th>类型</th><th>桌台</th><th>订单号</th><th>份数</th><th>状态</th><th>设备</th><th>操作</th></tr></thead><tbody>{jobs.map((job) => { const payload = job.payload || {}; return <tr key={job.id}><td>{formatTime(job.created_at)}</td><td>{printKindText(job.kind)}{payload.reprintOf ? "（补打）" : ""}</td><td>{String(payload.tableName || (payload.tableNumber ? `${payload.tableNumber}号桌` : "无桌台"))}</td><td className="mono-text">{job.order_id ? job.order_id.slice(0, 8) : "—"}</td><td>{job.copy_no}</td><td><span className={`status-pill ${job.status === "SENT" ? "green" : job.status === "FAILED" || job.status === "NEEDS_CHECK" ? "red" : "gray"}`}>{printStatusText(job.status)}</span></td><td>{job.device_id || "—"}</td><td className="table-actions"><button className="text-button" onClick={() => setSelected(job)}>预览</button>{job.status === "SENT" ? <button className="text-button" onClick={() => void reprint(job)}>重新打印</button> : job.status !== "CLAIMED" ? <button className="text-button" onClick={() => void dispatch(job)}>{job.status === "PENDING" ? "打印" : "重新打印"}</button> : null}</td></tr>; })}</tbody></table>{!jobs.length && <div className="empty">当前没有{tabs.find(([key]) => key === status)?.[1] || "打印"}任务</div>}</div>{selected && <PrintPreviewDialog job={selected} onClose={() => setSelected(null)} />}</section>;
}

function PrintPreviewDialog({ job, onClose }: { job: PrintJob; onClose: () => void }) {
  const payload = job.payload || {};
  const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : [];
  const totals = payload.totals && typeof payload.totals === "object" ? payload.totals as Record<string, unknown> : null;
  const isReceipt = job.kind === "RECEIPT";
  const hasFooter = Boolean(payload.footer);
  const orderNote = isReceipt ? "" : String(payload.orderNote || "");
  const tableName = String(payload.tableName || (payload.tableNumber ? `${payload.tableNumber}号桌` : "无桌台"));
  return <Dialog title="打印结果预览" description={`${printKindText(job.kind)} · ${printStatusText(job.status)}`} onClose={onClose} className="print-preview-modal"><div className="print-paper"><div className="print-paper-title">{String(payload.title || printKindText(job.kind))}</div><div className="print-table-name">{tableName}</div><div>人数：{String(payload.peopleCount || "—")}　顾客：{String(payload.customer || "散客")}</div>{payload.batchNo ? <div>批次：第 {String(payload.batchNo)} 批</div> : null}{isReceipt ? <><div>开台时间：{formatTime(String(payload.openedAt || ""))}</div><div>结账时间：{formatTime(String(payload.settledAt || payload.createdAt || ""))}</div></> : <div>时间：{formatTime(String(payload.createdAt || job.created_at))}</div>}{orderNote && <div className="print-order-note">本单备注：{orderNote}</div>}<hr />{items.map((item, index) => { const quantity = Number(item.quantity || 0); const priceFen = Number(item.priceFen || 0); const note = formatItemNote(String(item.note || "")); return <div className="print-line" key={`${String(item.name)}-${index}`}><div className="print-line-main"><strong>{String(item.name)}</strong><span>× {quantity} {item.unit ? String(item.unit) : ""}</span>{isReceipt && <b>{money(priceFen * quantity)}</b>}</div>{isReceipt && <div className="print-unit-price">单价 {money(priceFen)}</div>}{note && <div className="print-item-note">{note}</div>}</div>; })}{totals && <><hr /><div>应收：{money(Number(totals.dueFen ?? totals.receivedFen ?? 0))}</div><div className="print-total">实收：{money(Number(totals.receivedFen || 0))}</div></>}{hasFooter ? <><hr /><div className="print-footer">{String(payload.footer)}</div></> : null}</div><div className="modal-actions"><button className="secondary" onClick={onClose}>关闭</button></div></Dialog>;
}

function StatsPage({ setMessage }: { setMessage: (message: string) => void }) {
  const today = businessDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<{ summary: Record<string, number>; sales: Array<Record<string, unknown>> } | null>(null);
  async function load() { try { setData(await api(`/api/stats?from=${from}&to=${to}`)); } catch (error) { setMessage(errorText(error)); } }
  useEffect(() => { void load(); }, []);
  const s = data?.summary;
  return <section className="page-section"><div className="section-heading"><div><h2>营业统计</h2><p className="muted">按北京时间营业日统计有效结账数据，营业额已扣积分抵扣和人工减免</p></div><button className="secondary" onClick={() => { window.location.href = `/api/stats/export.csv?from=${from}&to=${to}`; }}>导出表格</button></div><div className="filter-bar"><label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><button className="primary" onClick={load}>查询</button></div>{s && <><div className="metric-grid"><Metric label="营业额" value={money(s.revenueFen)} /><Metric label="订单数" value={`${s.orderCount} 单`} /><Metric label="用餐人数" value={`${s.peopleCount} 人`} /><Metric label="人均消费" value={money(s.averagePersonFen)} /><Metric label="毛利润" value={money(s.grossProfitFen)} /><Metric label="毛利率" value={`${s.grossMarginPercent}%`} /><Metric label="优惠金额" value={money(s.discountFen)} /><Metric label="退菜损耗" value={money(s.lossFen)} /></div><div className="content-card"><h3>菜品销量</h3><table><thead><tr><th>菜品</th><th>售出</th><th>赠送</th><th>退菜</th><th>销售金额</th></tr></thead><tbody>{data.sales.map((row) => <tr key={String(row.dish_name)}><td>{String(row.dish_name)}</td><td>{String(row.sold_quantity)}</td><td>{String(row.gifted_quantity)}</td><td>{String(row.returned_quantity)}</td><td>{money(Number(row.amount_fen))}</td></tr>)}</tbody></table></div></>}</section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>; }

function AndroidPrinterPanel({ setMessage }: { setMessage: (message: string) => void }) {
  const [devices, setDevices] = useState<PairedPrinter[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [state, setState] = useState<PrinterHostState | null>(null);
  const [busy, setBusy] = useState(false);
  const isAndroid = Capacitor.getPlatform() === "android";

  async function refreshStatus() {
    if (!isAndroid) return;
    try {
      const next = await PrinterHost.status();
      setState(next);
      if (next.deviceId) setSelectedId(next.deviceId);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  async function loadPaired() {
    setBusy(true);
    try {
      const result = await PrinterHost.listPaired();
      setDevices(result.devices);
      await refreshStatus();
      if (!selectedId && result.devices[0]) setSelectedId(result.devices[0].id);
      if (!result.devices.length) setMessage("请先在安卓系统蓝牙设置中完成打印机配对");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!isAndroid) return;
    void loadPaired();
    const timer = window.setInterval(() => { void refreshStatus(); }, 5000);
    return () => window.clearInterval(timer);
  }, [isAndroid]);

  async function enable() {
    const device = devices.find((candidate) => candidate.id === selectedId);
    if (!device) return setMessage("请选择已配对的打印机");
    setBusy(true);
    try {
      const registration = await api<{ printerToken: string }>("/api/print-devices/register", {
        method: "POST",
        body: JSON.stringify({ deviceId: device.id, name: device.name })
      });
      const next = await PrinterHost.configure({
        deviceId: device.id,
        deviceName: device.name,
        printerToken: registration.printerToken,
        serverUrl: window.location.origin
      });
      setState(next);
      setMessage("安卓打印服务已启用；只自动打印连接后新生成的任务");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      setState(await PrinterHost.stop());
      setMessage("安卓打印服务已停用");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (!isAndroid) return null;
  return <div className="content-card printer-host-card"><div className="printer-host-heading"><div><h3>安卓打印主机</h3><p className="muted">先在系统蓝牙中配对打印机。断线期间产生的任务不会在重连后自动补打。</p></div><span className={`status-pill ${state?.connected ? "green" : state?.enabled ? "red" : "gray"}`}>{state?.connected ? "已连接" : state?.enabled ? "连接中" : "未启用"}</span></div><div className="printer-host-controls"><label>已配对打印机<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">请选择</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.id}</option>)}</select></label><button type="button" className="secondary" onClick={() => void loadPaired()} disabled={busy}>刷新设备</button><button type="button" className="primary" onClick={() => void enable()} disabled={busy || !selectedId}>启用打印</button>{state?.enabled && <button type="button" className="secondary danger-outline" onClick={() => void stop()} disabled={busy}>停用</button>}</div>{state?.message && <p className="printer-host-message">{state.message}</p>}</div>;
}

function SettingsPage({ setMessage }: { setMessage: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings>({});
  const [tables, setTables] = useState<Table[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Table | null>(null);
  const [employeeForm, setEmployeeForm] = useState({ username: "", name: "", password: "" });
  async function load() { try { const [settingResult, tableResult, employeeResult] = await Promise.all([api<{ settings: Settings }>("/api/settings"), api<{ tables: Table[] }>("/api/tables"), api<{ employees: Employee[] }>("/api/employees")]); setSettings(settingResult.settings); setTables(tableResult.tables); setEmployees(employeeResult.employees); setLoaded(true); } catch (error) { setMessage(errorText(error)); } }
  useEffect(() => { void load(); }, []);
  function value(key: string, fallback = "") { return String(settings[key] ?? fallback); }
  async function saveSettings() { try { await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) }); setMessage("设置已保存"); } catch (error) { setMessage(errorText(error)); } }
  async function saveTable(table: Table, values: { name: string; number: number; seats: number }) { try { await api(`/api/tables/${table.id}`, { method: "PATCH", body: JSON.stringify(values) }); await load(); setMessage(`${values.name}已保存`); } catch (error) { setMessage(errorText(error)); } }
  async function addTable(values: { name: string; number: number; seats: number }) { try { await api("/api/tables", { method: "POST", body: JSON.stringify(values) }); await load(); setMessage(`${values.name}已新增`); } catch (error) { setMessage(errorText(error)); } }
  async function deleteTable() { if (!deleteTarget) return; try { await api(`/api/tables/${deleteTarget.id}`, { method: "DELETE" }); setDeleteTarget(null); await load(); setMessage(`${deleteTarget.name}已删除`); } catch (error) { setMessage(errorText(error)); } }
  async function addEmployee(event: FormEvent) { event.preventDefault(); try { await api("/api/employees", { method: "POST", body: JSON.stringify(employeeForm) }); setEmployeeForm({ username: "", name: "", password: "" }); await load(); setMessage("员工账号已开通"); } catch (error) { setMessage(errorText(error)); } }
  async function toggleEmployee(employee: Employee) { try { await api(`/api/employees/${employee.id}`, { method: "PATCH", body: JSON.stringify({ active: !employee.active }) }); await load(); setMessage(employee.active ? "员工账号已停用" : "员工账号已启用"); } catch (error) { setMessage(errorText(error)); } }
  if (!loaded) return <section className="page-section"><div className="loading">正在读取设置…</div></section>;
  return <section className="page-section"><div className="section-heading"><div><h2>设置</h2><p className="muted">店铺、积分规则、打印设备、桌台和员工账号</p></div></div><div className="settings-layout"><AndroidPrinterPanel setMessage={setMessage} /><div className="content-card"><h3>店铺与小票</h3><div className="form-grid"><label>店名<input value={value("store_name")} onChange={(event) => setSettings({ ...settings, store_name: event.target.value })} /></label><label>小票尾注<input value={value("receipt_footer")} onChange={(event) => setSettings({ ...settings, receipt_footer: event.target.value })} /></label><label>打印设备编号<input value={value("printer_device_id")} onChange={(event) => setSettings({ ...settings, printer_device_id: event.target.value })} placeholder="由安卓打印服务填写" /></label><label>打印设备名称<input value={value("printer_device_name")} onChange={(event) => setSettings({ ...settings, printer_device_name: event.target.value })} /></label></div></div><div className="content-card"><h3>积分规则</h3><label className="toggle-row"><input type="checkbox" checked={Boolean(settings.points_enabled)} onChange={(event) => setSettings({ ...settings, points_enabled: event.target.checked })} />启用积分</label><div className="form-grid three"><label>每多少分获得 1 分<small>按实收金额计算，填写分</small><input type="number" min="1" value={value("points_earn_fen", "100")} onChange={(event) => setSettings({ ...settings, points_earn_fen: Number(event.target.value) })} /></label><label>多少积分抵 1 元<input type="number" min="1" value={value("points_redeem_points", "10")} onChange={(event) => setSettings({ ...settings, points_redeem_points: Number(event.target.value) })} /></label><label>每个抵扣单位金额（分）<input type="number" min="1" value={value("points_redeem_fen", "100")} onChange={(event) => setSettings({ ...settings, points_redeem_fen: Number(event.target.value) })} /></label></div></div><div className="content-card"><h3>桌台管理</h3><p className="muted">桌台有历史订单时不能物理删除，可改名或停用以保留历史记录。</p><div className="table-settings">{tables.map((table) => <TableSetting key={table.id} table={table} onSave={saveTable} onDelete={() => setDeleteTarget(table)} />)}</div><AddTableForm onAdd={addTable} /></div><div className="content-card"><h3>员工账号</h3><p className="muted">开通后员工使用自己的账号登录；停用不会删除历史操作记录。</p><form className="employee-form" noValidate onSubmit={addEmployee}><label>登录账号<input value={employeeForm.username} onChange={(event) => setEmployeeForm({ ...employeeForm, username: event.target.value })} /></label><label>员工姓名<input value={employeeForm.name} onChange={(event) => setEmployeeForm({ ...employeeForm, name: event.target.value })} /></label><label>初始密码<small>至少 8 位</small><input type="password" value={employeeForm.password} onChange={(event) => setEmployeeForm({ ...employeeForm, password: event.target.value })} /></label><button className="primary">开通账号</button></form><div className="employee-list">{employees.map((employee) => <div className="employee-row" key={employee.id}><div><strong>{employee.name}</strong><span>{employee.username} · {employee.role === "OWNER" ? "老板" : "收银员"}</span></div><span className={employee.active ? "status-pill green" : "status-pill gray"}>{employee.active ? "启用" : "停用"}</span>{employee.role !== "OWNER" && <button type="button" className="secondary" onClick={() => void toggleEmployee(employee)}>{employee.active ? "停用" : "启用"}</button>}</div>)}</div></div><button className="primary" type="button" onClick={() => void saveSettings()}>保存店铺与积分设置</button></div>{deleteTarget && <ConfirmDialog title="删除桌台" message={`确定删除“${deleteTarget.name}”？只有从未产生订单且当前空闲的桌台可以删除。`} confirmText="确认删除" danger onClose={() => setDeleteTarget(null)} onConfirm={() => void deleteTable()} />}</section>;
}

function TableSetting({ table, onSave, onDelete }: { table: Table; onSave: (table: Table, values: { name: string; number: number; seats: number }) => Promise<void>; onDelete: () => void }) {
  const [name, setName] = useState(table.name);
  const [number, setNumber] = useState(table.number);
  const [seats, setSeats] = useState(table.seats);
  useEffect(() => { setName(table.name); setNumber(table.number); setSeats(table.seats); }, [table.name, table.number, table.seats]);
  return <div className="table-setting"><label>桌台名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>桌号<input type="number" min="1" value={number} onChange={(event) => setNumber(Number(event.target.value))} /></label><label>座位<input type="number" min="1" value={seats} onChange={(event) => setSeats(Number(event.target.value))} /></label><span className={table.order ? "occupied-dot" : "available-dot"}>{table.order ? "使用中" : table.status === "DISABLED" ? "停用" : "空闲"}</span><button className="secondary" type="button" disabled={Boolean(table.order)} onClick={() => void onSave(table, { name: name.trim(), number, seats })}>保存</button><button className="text-button danger-text" type="button" disabled={Boolean(table.order)} onClick={onDelete}>删除</button></div>;
}

function AddTableForm({ onAdd }: { onAdd: (values: { name: string; number: number; seats: number }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [seats, setSeats] = useState("4");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); const tableNumber = Number(number); if (!tableNumber || tableNumber < 1) { setError("桌号必须是大于零的整数"); return; } setError(""); const tableName = name.trim() || `${tableNumber}号桌`; await onAdd({ name: tableName, number: tableNumber, seats: Math.max(1, Number(seats) || 4) }); setName(""); setNumber(""); setSeats("4"); }
  return <form className="add-table-form" noValidate onSubmit={submit}><h4>新增桌台</h4><div className="form-grid three"><label>桌台名称<input placeholder="例如：靠窗一号桌" value={name} onChange={(event) => setName(event.target.value)} /></label><label>桌号<input type="number" min="1" value={number} onChange={(event) => setNumber(event.target.value)} /></label><label>座位数<input type="number" min="1" value={seats} onChange={(event) => setSeats(event.target.value)} /></label></div>{error && <div className="message error">{error}</div>}<button className="secondary">新增桌台</button></form>;
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
      : page === "orders" ? <OrderQueryPage openOrder={setSelectedOrderId} setMessage={setMessage} />
        : page === "customers" ? <CustomersPage setMessage={setMessage} />
              : page === "dishes" ? <DishesPage categories={categories} user={user} setMessage={setMessage} reloadCategories={refreshCategories} />
                : page === "stats" ? <StatsPage setMessage={setMessage} />
                  : page === "print" ? <PrintManagementPage setMessage={setMessage} />
                  : <SettingsPage setMessage={setMessage} />;
  return <div className="app-shell"><Header user={user} page={page} setPage={(next) => { setSelectedOrderId(""); setPage(next); }} onLogout={logout} selectedOrder={Boolean(selectedOrderId)} />{message && <div className="toast">{message}<button onClick={() => setMessage("")}>×</button></div>}<main>{content}</main></div>;
}
