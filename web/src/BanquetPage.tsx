import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, idempotentApi, money } from "./api.js";

type PosTable = { id: string; number: number; name: string; seats: number; status: string; reservationCount?: number };
type PreorderLine = {
  dishId: string; name: string; quantity: number; unit: string; priceFen: number; note: string;
  optionSnapshot: Array<{ groupId?: string; groupName: string; optionIds?: string[]; labels: string[] }>;
};
type DepositLedgerLine = { id: string; kind: "RECEIVE" | "REFUND" | "APPLY" | "RESTORE"; amount_fen: number; payment_method: string; note: string; created_at: string };
type BanquetReservation = {
  id: string; table_id: string | null; table_name: string; table_number: number | null; table_seats: number | null;
  starts_at: string; ends_at: string; customer_name: string; customer_phone: string | null; people_count: number;
  points_earning_enabled: boolean; status: "RESERVED" | "CANCELLED" | "CONVERTED"; preorder: PreorderLine[];
  order_id: string | null; note: string; deposit_balance_fen: number; deposit_ledger?: DepositLedgerLine[];
};

function localDateTime(value: Date): string {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function defaultPeriod() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(18, 0, 0, 0);
  return { startsAt: localDateTime(start), endsAt: localDateTime(new Date(start.getTime() + 4 * 60 * 60_000)) };
}

function defaultFilters() {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 30);
  return { from: localDateTime(from).slice(0, 10), to: localDateTime(to).slice(0, 10), status: "", q: "" };
}

function toIso(local: string): string {
  const date = new Date(local);
  if (!local || Number.isNaN(date.getTime())) throw new Error("请填写有效的日期和时间");
  return date.toISOString();
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请稍后重试";
}

function statusLabel(row: BanquetReservation): string {
  if (row.status === "CONVERTED") return "已开台";
  if (row.status === "CANCELLED") return "已取消";
  if (new Date(row.starts_at).getTime() <= Date.now()) return "待自动开台";
  return "待到店";
}

function moneyInputToFen(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("请输入大于零的金额");
  return Math.round(parsed * 100);
}

function Modal({ title, children, onClose, className = "" }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  return <div className="modal-backdrop"><div className={`modal ${className}`} role="dialog" aria-modal="true"><div className="modal-heading"><div><h2>{title}</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="关闭">×</button></div>{children}</div></div>;
}

export function BanquetPage({ onOpenOrder, onPreorder, setMessage, canManageHalls = false, focusTableId = "", focusReservationId = "" }: { onOpenOrder: (orderId: string) => void; onPreorder: (reservationId: string) => void; setMessage: (message: string) => void; canManageHalls?: boolean; focusTableId?: string; focusReservationId?: string }) {
  const [tables, setTables] = useState<PosTable[]>([]);
  const [reservations, setReservations] = useState<BanquetReservation[]>([]);
  const [detail, setDetail] = useState<BanquetReservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState(defaultFilters);
  const [tableFilterId, setTableFilterId] = useState(focusTableId);
  const appliedFilters = useRef(filters);
  const [createOpen, setCreateOpen] = useState(false);
  const [period, setPeriod] = useState(defaultPeriod);
  const [tableId, setTableId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [peopleCount, setPeopleCount] = useState("10");
  const [pointsEarningEnabled, setPointsEarningEnabled] = useState(true);
  const [bookingNote, setBookingNote] = useState("");
  const [editPeriod, setEditPeriod] = useState({ startsAt: "", endsAt: "" });
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositNote, setDepositNote] = useState("");
  const [depositPaymentMethod, setDepositPaymentMethod] = useState("现金");
  const [depositAction, setDepositAction] = useState<"receive" | "refund">("receive");

  const availableTables = tables.filter((table) => table.status !== "DISABLED");
  const filteredReservations = useMemo(() => {
    const keyword = filters.q.trim().toLowerCase();
    return reservations.filter((row) => (!tableFilterId || row.table_id === tableFilterId)
      && (!keyword || [row.customer_name, row.customer_phone, row.table_name, row.note].some((value) => String(value || "").toLowerCase().includes(keyword))));
  }, [filters.q, reservations, tableFilterId]);
  const counts = useMemo(() => ({
    all: filteredReservations.length,
    waiting: filteredReservations.filter((row) => row.status === "RESERVED").length,
    opened: filteredReservations.filter((row) => row.status === "CONVERTED").length,
    people: filteredReservations.filter((row) => row.status !== "CANCELLED").reduce((sum, row) => sum + row.people_count, 0)
  }), [filteredReservations]);

  async function loadList(nextFilters = appliedFilters.current) {
    const query = new URLSearchParams();
    if (nextFilters.from) query.set("from", new Date(`${nextFilters.from}T00:00:00`).toISOString());
    if (nextFilters.to) { const end = new Date(`${nextFilters.to}T00:00:00`); end.setDate(end.getDate() + 1); query.set("to", end.toISOString()); }
    if (nextFilters.status) query.set("status", nextFilters.status);
    const result = await api<{ reservations: BanquetReservation[] }>(`/api/banquets/reservations?${query.toString()}`);
    setReservations(result.reservations);
  }

  async function loadBase() {
    const tableResult = await api<{ tables: PosTable[] }>("/api/tables");
    setTables(tableResult.tables);
    setTableId((current) => current || tableResult.tables.find((table) => table.status !== "DISABLED")?.id || "");
  }

  useEffect(() => {
    let active = true;
    void Promise.all([loadBase(), loadList()]).then(() => { if (active && focusReservationId) void openDetail(focusReservationId); }).catch((error) => { if (active) setMessage(errorMessage(error)); });
    const timer = window.setInterval(() => { void loadList().catch(() => undefined); }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => { setTableFilterId(focusTableId); }, [focusTableId]);

  async function refresh() {
    setBusy(true);
    try { await Promise.all([loadBase(), loadList()]); if (detail) await openDetail(detail.id); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function applyFilters(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { appliedFilters.current = filters; await loadList(filters); } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  }

  async function openDetail(id: string) {
    try {
      const result = await api<{ reservation: BanquetReservation }>(`/api/banquets/reservations/${id}`);
      setDetail(result.reservation);
      setEditPeriod({ startsAt: localDateTime(new Date(result.reservation.starts_at)), endsAt: localDateTime(new Date(result.reservation.ends_at)) });
      setCancelConfirm(false);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function createReservation(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      if (!tableId) throw new Error("请选择桌台");
      const startsAt = toIso(period.startsAt); const endsAt = toIso(period.endsAt);
      if (new Date(endsAt) <= new Date(startsAt)) throw new Error("结束时间必须晚于开始时间");
      const payload = { tableId, startsAt, endsAt, customerName: customerName.trim(), customerPhone: customerPhone.trim(), peopleCount: Number(peopleCount), pointsEarningEnabled, note: bookingNote.trim() };
      const created = await idempotentApi<{ reservation: BanquetReservation }>("/api/banquets/reservations", "banquet:create", payload);
      setCreateOpen(false); setCustomerName(""); setCustomerPhone(""); setBookingNote(""); setPeriod(defaultPeriod());
      await loadList(); await openDetail(created.reservation.id); setMessage("宴席已添加，到点会自动开台");
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  }

  async function convertToOrder() {
    if (!detail) return; setBusy(true);
    try {
      const result = await idempotentApi<{ orderId: string }>(`/api/banquets/reservations/${detail.id}/convert`, `banquet:${detail.id}:convert`, {});
      setMessage("宴席已开台，预点菜已保留；进入桌台核对、加菜后再打印"); onOpenOrder(result.orderId);
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  }

  async function saveReschedule(event: FormEvent) {
    event.preventDefault(); if (!detail) return; setBusy(true);
    try {
      const startsAt = toIso(editPeriod.startsAt); const endsAt = toIso(editPeriod.endsAt);
      await api(`/api/banquets/reservations/${detail.id}`, { method: "PATCH", body: JSON.stringify({ startsAt, endsAt }) });
      await loadList(); await openDetail(detail.id); setMessage("宴席时间已修改");
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  }

  async function cancelReservation() {
    if (!detail) return; setBusy(true);
    try {
      await api(`/api/banquets/reservations/${detail.id}`, { method: "PATCH", body: JSON.stringify({ status: "CANCELLED" }) });
      await loadList(); await openDetail(detail.id); setMessage("宴席已取消，定金需单独退款");
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  }

  async function operateDeposit(event: FormEvent) {
    event.preventDefault(); if (!detail) return; setBusy(true);
    try {
      const route = `/api/banquets/reservations/${detail.id}/deposits/${depositAction}`;
      const result = await idempotentApi<{ reservation: BanquetReservation }>(route, `banquet:${detail.id}:${depositAction}`, { amountFen: moneyInputToFen(depositAmount), paymentMethod: depositPaymentMethod, note: depositNote.trim() });
      setDetail(result.reservation); setDepositAmount(""); setDepositNote(""); await loadList(); setMessage(depositAction === "receive" ? "定金收款已记账" : "定金退款已记账");
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  }

  return <section className="page-section banquet-page">
    <div className="section-heading"><div><h2>宴席总览</h2><p className="muted">查看预定、预点菜和开台状态</p></div><div className="heading-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>刷新</button><button type="button" className="primary" onClick={() => setCreateOpen(true)}>添加宴席</button></div></div>
    <div className="metric-grid banquet-metrics"><div className="metric-card"><span>当前结果</span><strong>{counts.all}</strong></div><div className="metric-card"><span>待开台</span><strong>{counts.waiting}</strong></div><div className="metric-card"><span>已开台</span><strong>{counts.opened}</strong></div><div className="metric-card"><span>预计人数</span><strong>{counts.people}</strong></div></div>
    {tableFilterId && <div className="banquet-table-filter"><span>当前只看：{tables.find((table) => table.id === tableFilterId)?.name || "本桌"}</span><button type="button" className="text-button" onClick={() => setTableFilterId("")}>查看全部宴席</button></div>}
    <div className="content-card banquet-filter-card"><form className="filter-grid" onSubmit={(event) => void applyFilters(event)}><label>开始日期<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label><label>结束日期<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label><label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部</option><option value="RESERVED">待开台</option><option value="CONVERTED">已开台</option><option value="CANCELLED">已取消</option></select></label><label>搜索<input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="姓名、手机、桌台、备注" /></label><div className="filter-actions"><button className="primary" disabled={busy}>筛选</button><button type="button" className="secondary" onClick={() => { const next = defaultFilters(); appliedFilters.current = next; setFilters(next); void loadList(next); }}>重置</button></div></form></div>
    <div className="content-card banquet-list-card">{filteredReservations.length ? <div className="banquet-list">{filteredReservations.map((row) => <button type="button" className="banquet-row" key={row.id} onClick={() => void openDetail(row.id)}><div className="banquet-row-time"><strong>{displayDate(row.starts_at)}</strong><span>至 {displayDate(row.ends_at)}</span></div><div><strong>{row.customer_name || "未填写姓名"}</strong><span>{row.customer_phone || "未填写手机"} · {row.people_count}人</span></div><div><strong>{row.table_name}{row.table_number ? ` · ${row.table_number}号桌` : ""}</strong><span>预点 {row.preorder?.length || 0} 项 · 定金 {money(row.deposit_balance_fen)}</span></div><span className={row.status === "RESERVED" ? "status-pill green" : "status-pill gray"}>{statusLabel(row)}</span><span className="banquet-detail-link">查看详情 ›</span></button>)}</div> : <div className="empty">没有符合条件的宴席</div>}</div>

    {createOpen && <Modal title="添加宴席" onClose={() => setCreateOpen(false)} className="large-modal"><form className="form-grid" onSubmit={(event) => void createReservation(event)}><label>桌台<select value={tableId} onChange={(event) => setTableId(event.target.value)} required><option value="">请选择桌台</option>{availableTables.map((table) => <option key={table.id} value={table.id}>{table.name}（{table.number}号桌，{table.seats}人桌）{table.reservationCount ? ` · 已有${table.reservationCount}条预定` : ""}</option>)}</select></label><label>开始时间<input type="datetime-local" value={period.startsAt} onChange={(event) => setPeriod({ ...period, startsAt: event.target.value })} required /></label><label>结束时间<input type="datetime-local" value={period.endsAt} onChange={(event) => setPeriod({ ...period, endsAt: event.target.value })} required /></label><label>预订人<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={120} /></label><label>手机号<input inputMode="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /></label><label>人数<input type="number" min="1" value={peopleCount} onChange={(event) => setPeopleCount(event.target.value)} required /></label><label>备注<input value={bookingNote} onChange={(event) => setBookingNote(event.target.value)} maxLength={500} /></label><label className="toggle-row"><input type="checkbox" checked={pointsEarningEnabled} onChange={(event) => setPointsEarningEnabled(event.target.checked)} />宴席累计积分</label><p className="muted form-wide">保存后可在详情中预点菜或立即开台；未手动开台时，到开始时间自动开台。</p><div className="modal-actions form-wide"><button type="button" className="secondary" onClick={() => setCreateOpen(false)}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存宴席"}</button></div></form></Modal>}

    {detail && <Modal title={`${detail.customer_name || "未填写姓名"} · ${detail.table_name}`} onClose={() => setDetail(null)} className="banquet-detail-modal"><div className="detail-summary"><div><span>时间</span><strong>{displayDate(detail.starts_at)}<br />至 {displayDate(detail.ends_at)}</strong></div><div><span>人数与联系</span><strong>{detail.people_count}人<br />{detail.customer_phone || "未填写手机"}</strong></div><div><span>状态</span><strong>{statusLabel(detail)}</strong></div><div><span>可抵定金</span><strong>{money(detail.deposit_balance_fen)}</strong></div></div>{detail.note && <p className="order-note"><span>备注：</span>{detail.note}</p>}
      {detail.status === "RESERVED" && <div className="banquet-action-grid"><div className="content-card banquet-preorder-entry"><h3>预点菜</h3><p className="muted">已保留 {detail.preorder?.length || 0} 项，可多次进入继续加菜。预点阶段不会打印。</p><button type="button" className="primary wide" onClick={() => onPreorder(detail.id)}>预点菜</button></div><div className="content-card"><h3>开台</h3><p className="muted">开台只保留菜品，不自动打印。员工进入桌台核对或加菜后再打印备菜单。</p><button type="button" className="primary wide" disabled={busy || !detail.table_id} onClick={() => void convertToOrder()}>现在开台</button></div></div>}
      {detail.status === "CONVERTED" && <div className="content-card"><h3>宴席已开台</h3><p className="muted">预点菜已进入正式订单，可继续点菜、打印和结账。</p><button type="button" className="primary" disabled={!detail.order_id} onClick={() => detail.order_id && onOpenOrder(detail.order_id)}>打开宴席账单</button></div>}
      <div className="content-card banquet-deposit-card"><h3>定金账本</h3><form className="form-grid" onSubmit={(event) => void operateDeposit(event)}><label>操作<select value={depositAction} onChange={(event) => setDepositAction(event.target.value as "receive" | "refund")}><option value="receive">收取定金</option>{canManageHalls && <option value="refund">退还定金</option>}</select></label><label>金额（元）<input inputMode="decimal" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} required /></label><label>方式<select value={depositPaymentMethod} onChange={(event) => setDepositPaymentMethod(event.target.value)}><option>现金</option><option>微信</option><option>支付宝</option><option>银行卡</option><option>其他</option></select></label><label>备注<input value={depositNote} onChange={(event) => setDepositNote(event.target.value)} /></label><button className="secondary" disabled={busy}>确认记账</button></form>{detail.deposit_ledger?.length ? <div className="employee-list">{detail.deposit_ledger.map((entry) => <div className="employee-row" key={entry.id}><div><strong>{({ RECEIVE: "收定金", REFUND: "退定金", APPLY: "结账抵扣", RESTORE: "撤销恢复" } as const)[entry.kind]}</strong><span>{displayDate(entry.created_at)} · {entry.note || entry.payment_method}</span></div><span>{entry.kind === "REFUND" || entry.kind === "APPLY" ? "−" : "+"}{money(entry.amount_fen)}</span></div>)}</div> : <div className="empty">暂无定金记录</div>}</div>
      {detail.status === "RESERVED" && <div className="content-card banquet-reschedule-card"><div className="banquet-reschedule-heading"><div><h3>改期或取消</h3><p className="muted">未开台前可调整宴席时间；取消后该桌台时段立即释放。</p></div><span className="banquet-section-kicker">预定管理</span></div><form className="banquet-reschedule-form" onSubmit={(event) => void saveReschedule(event)}><label>开始时间<input type="datetime-local" value={editPeriod.startsAt} onChange={(event) => setEditPeriod({ ...editPeriod, startsAt: event.target.value })} /></label><label>结束时间<input type="datetime-local" value={editPeriod.endsAt} onChange={(event) => setEditPeriod({ ...editPeriod, endsAt: event.target.value })} /></label><button className="secondary" disabled={busy}>保存改期</button></form><div className="banquet-cancel-area">{cancelConfirm ? <><span>取消后不能恢复，请确认。</span><div className="modal-actions"><button type="button" className="secondary" onClick={() => setCancelConfirm(false)}>返回</button><button type="button" className="danger-button" disabled={busy} onClick={() => void cancelReservation()}>确认取消</button></div></> : <><span>如不再需要此宴席，可释放预定时段。</span><button type="button" className="text-button danger-text" onClick={() => setCancelConfirm(true)}>取消宴席</button></>}</div></div>}
    </Modal>}
  </section>;
}

export default BanquetPage;
