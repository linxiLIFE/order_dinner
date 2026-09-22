import { useEffect, useState, type FormEvent } from "react";
import { api, idempotentApi, money } from "./api.js";

type PosTable = {
  id: string;
  number: number;
  name: string;
  seats: number;
  status: "AVAILABLE" | "OCCUPIED" | "DISABLED" | string;
  reservationCount?: number;
  nextReservationAt?: string | null;
};
type LegacyPreorderLine = {
  name?: string;
  quantity?: number;
  unit?: string;
  priceFen?: number;
  note?: string;
  optionSnapshot?: Array<{ groupName: string; labels: string[] }>;
};
type DepositLedgerLine = {
  id: string;
  kind: "RECEIVE" | "REFUND" | "APPLY" | "RESTORE";
  amount_fen: number;
  payment_method: string;
  note: string;
  created_at: string;
};
type BanquetReservation = {
  id: string;
  hall_id: string | null;
  hall_name: string | null;
  table_id: string | null;
  table_name: string;
  table_number: number | null;
  table_seats: number | null;
  starts_at: string;
  ends_at: string;
  customer_name: string;
  customer_phone: string | null;
  people_count: number;
  points_earning_enabled: boolean;
  status: "RESERVED" | "CANCELLED" | "CONVERTED";
  preorder: LegacyPreorderLine[];
  order_id: string | null;
  note: string;
  deposit_balance_fen: number;
  deposit_ledger?: DepositLedgerLine[];
};

function localDateTime(value: Date): string {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function defaultPeriod() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 4 * 60 * 60_000);
  return { startsAt: localDateTime(start), endsAt: localDateTime(end) };
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

function statusLabel(status: BanquetReservation["status"]): string {
  if (status === "CONVERTED") return "已开账单";
  if (status === "CANCELLED") return "已取消";
  return "待办";
}

function tableStatusLabel(table: PosTable | undefined): string {
  if (!table) return "桌台已不存在";
  if (table.status === "DISABLED") return "已停用";
  if (table.status === "OCCUPIED") return "当前用餐中";
  return "当前空桌";
}

function moneyInputToFen(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("请输入大于零的金额");
  return Math.round(parsed * 100);
}

function tableTitle(table: Pick<PosTable, "name" | "number" | "seats"> | Pick<BanquetReservation, "table_name" | "table_number" | "table_seats">): string {
  const name = "name" in table ? table.name : table.table_name;
  const number = "number" in table ? table.number : table.table_number;
  const seats = "seats" in table ? table.seats : table.table_seats;
  const details = [number ? `${number}号桌` : "", seats ? `${seats}人桌` : ""].filter(Boolean);
  return details.length ? `${name || "未指定桌台"}（${details.join("，")}）` : (name || "未指定桌台");
}

export function BanquetPage({
  onOpenOrder,
  setMessage,
  canManageHalls = false
}: {
  onOpenOrder: (orderId: string) => void;
  setMessage: (message: string) => void;
  canManageHalls?: boolean;
}) {
  const [tables, setTables] = useState<PosTable[]>([]);
  const [reservations, setReservations] = useState<BanquetReservation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<BanquetReservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState(defaultPeriod);
  const [tableId, setTableId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [peopleCount, setPeopleCount] = useState("10");
  const [pointsEarningEnabled, setPointsEarningEnabled] = useState(true);
  const [bookingNote, setBookingNote] = useState("");
  const [goToOrdering, setGoToOrdering] = useState(false);
  const [editPeriod, setEditPeriod] = useState({ startsAt: "", endsAt: "" });
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositNote, setDepositNote] = useState("");
  const [depositPaymentMethod, setDepositPaymentMethod] = useState("现金");
  const [depositAction, setDepositAction] = useState<"receive" | "refund">("receive");

  const availableTables = tables.filter((table) => table.status !== "DISABLED");
  const selectedTable = availableTables.find((table) => table.id === tableId);

  async function loadData(preferredReservationId = selectedId) {
    const [tableResult, reservationResult] = await Promise.all([
      api<{ tables: PosTable[] }>("/api/tables"),
      api<{ reservations: BanquetReservation[] }>("/api/banquets/reservations")
    ]);
    setTables(tableResult.tables);
    setReservations(reservationResult.reservations);
    setTableId((current) => current || tableResult.tables.find((table) => table.status !== "DISABLED")?.id || "");
    const nextId = preferredReservationId && reservationResult.reservations.some((row) => row.id === preferredReservationId)
      ? preferredReservationId : "";
    setSelectedId(nextId);
    if (nextId) {
      const result = await api<{ reservation: BanquetReservation }>(`/api/banquets/reservations/${nextId}`);
      setDetail(result.reservation);
      setEditPeriod({ startsAt: localDateTime(new Date(result.reservation.starts_at)), endsAt: localDateTime(new Date(result.reservation.ends_at)) });
    } else {
      setDetail(null);
    }
  }

  useEffect(() => {
    let active = true;
    void loadData("").catch((error) => { if (active) setMessage(errorMessage(error)); });
    return () => { active = false; };
  }, []);

  function reportError(error: unknown) {
    setMessage(errorMessage(error));
  }

  async function refresh(preferredId = selectedId) {
    setBusy(true);
    try { await loadData(preferredId); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  async function createReservation(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (!tableId) throw new Error("请选择已有桌台");
      if (goToOrdering && selectedTable?.status !== "AVAILABLE") {
        throw new Error("当前桌台正在用餐，不能立即进入普通点菜页；可以先保存预定，稍后再点菜");
      }
      const startsAt = toIso(period.startsAt);
      const endsAt = toIso(period.endsAt);
      if (new Date(endsAt) <= new Date(startsAt)) throw new Error("结束时间必须晚于开始时间");
      const payload = {
        tableId, startsAt, endsAt, customerName: customerName.trim(), customerPhone: customerPhone.trim(),
        peopleCount: Number(peopleCount), pointsEarningEnabled, note: bookingNote.trim()
      };
      const created = await idempotentApi<{ reservation: BanquetReservation }>("/api/banquets/reservations", "banquet:create", payload);
      setCustomerName(""); setCustomerPhone(""); setBookingNote("");
      if (goToOrdering) {
        const converted = await idempotentApi<{ orderId: string }>(
          `/api/banquets/reservations/${created.reservation.id}/convert`, `banquet:${created.reservation.id}:convert`, {}
        );
        setMessage("预定已保存，已进入普通点菜页；此时不会自动打印备菜单");
        onOpenOrder(converted.orderId);
      } else {
        await loadData(created.reservation.id);
        setMessage("宴席预定已保存；需要预点菜时，打开这条预定进入普通点菜页");
      }
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  async function saveReschedule(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      const startsAt = toIso(editPeriod.startsAt);
      const endsAt = toIso(editPeriod.endsAt);
      if (new Date(endsAt) <= new Date(startsAt)) throw new Error("结束时间必须晚于开始时间");
      await api(`/api/banquets/reservations/${detail.id}`, { method: "PATCH", body: JSON.stringify({ startsAt, endsAt }) });
      await loadData(detail.id); setMessage("宴席时间已改期");
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  async function cancelReservation() {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/banquets/reservations/${detail.id}`, { method: "PATCH", body: JSON.stringify({ status: "CANCELLED" }) });
      setCancelConfirm(false); await loadData(detail.id); setMessage("宴席预定已取消；如需退定金，请另行办理退款");
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  async function operateDeposit(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      const amountFen = moneyInputToFen(depositAmount);
      const payload = { amountFen, paymentMethod: depositPaymentMethod, note: depositNote.trim() };
      const route = `/api/banquets/reservations/${detail.id}/deposits/${depositAction}`;
      const result = await idempotentApi<{ reservation: BanquetReservation }>(route, `banquet:${detail.id}:${depositAction}`, payload);
      setDetail(result.reservation);
      setReservations((current) => current.map((row) => row.id === result.reservation.id ? result.reservation : row));
      setDepositAmount(""); setDepositNote(""); setMessage(depositAction === "receive" ? "定金收款已记账" : "定金退款已记账");
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  async function convertToOrder() {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await idempotentApi<{ orderId: string }>(
        `/api/banquets/reservations/${detail.id}/convert`, `banquet:${detail.id}:convert`, {}
      );
      setMessage("已进入普通点菜页；点菜完成后按正常流程打印和结账");
      onOpenOrder(result.orderId);
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  const detailTable = detail ? tableTitle(detail) : "";

  return <section className="page-section">
    <div className="section-heading">
      <div><h2>宴席预定</h2><p className="muted">先选已有桌台和时间，保存预定。需要预点菜时，直接进入普通点菜页，按平时点菜、备注和打印。</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>刷新</button>
    </div>

    <div className="content-card">
      <h3>新建宴席预定</h3>
      <p className="muted">预定本身不会开账单，也不会打印。勾选“现在去普通点菜”后，保存成功会直接打开所选桌台的普通点菜页面。</p>
      {!availableTables.length ? <div className="empty">还没有可选桌台，请先在“设置”中新增桌台。</div> : <form className="form-grid" onSubmit={(event) => void createReservation(event)}>
        <label>已有桌台<select value={tableId} onChange={(event) => setTableId(event.target.value)}>{availableTables.map((table) => <option value={table.id} key={table.id}>{tableTitle(table)} · {tableStatusLabel(table)}{table.reservationCount ? ` · 已有${table.reservationCount}条预定` : ""}</option>)}</select></label>
        <label>开始时间<input type="datetime-local" value={period.startsAt} onChange={(event) => setPeriod({ ...period, startsAt: event.target.value })} required /></label>
        <label>结束时间<input type="datetime-local" value={period.endsAt} onChange={(event) => setPeriod({ ...period, endsAt: event.target.value })} required /></label>
        <label>预订人<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={120} /></label>
        <label>手机号<input inputMode="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /></label>
        <label>人数<input type="number" min="1" value={peopleCount} onChange={(event) => setPeopleCount(event.target.value)} required /></label>
        <label className="toggle-row"><input type="checkbox" checked={pointsEarningEnabled} onChange={(event) => setPointsEarningEnabled(event.target.checked)} />这笔宴席累计积分</label>
        <label>备注<input value={bookingNote} onChange={(event) => setBookingNote(event.target.value)} maxLength={500} /></label>
        <label className="toggle-row form-wide"><input type="checkbox" checked={goToOrdering} onChange={(event) => setGoToOrdering(event.target.checked)} />现在去普通点菜（保存后直接进入标准点菜页）</label>
        {goToOrdering && selectedTable?.status !== "AVAILABLE" && <div className="form-wide warning-text">当前桌台{selectedTable ? "正在用餐" : "不可用"}，不能立即开普通点菜。取消勾选后仍可先保存预定。</div>}
        <button className="primary form-wide" disabled={busy || (goToOrdering && selectedTable?.status !== "AVAILABLE")}>{busy ? "保存中…" : goToOrdering ? "保存预定并进入普通点菜" : "保存预定"}</button>
      </form>}
    </div>

    <div className="content-card">
      <div className="section-heading"><div><h3>预定列表</h3><p className="muted">点选一条预定查看改期、定金和普通点菜入口。</p></div></div>
      {reservations.length ? <div className="employee-list">{reservations.map((row) => <button type="button" className="employee-row" key={row.id} onClick={() => void refresh(row.id)}>
        <div><strong>{displayDate(row.starts_at)} · {row.table_name || row.hall_name || "未指定桌台"}{row.table_number ? `（${row.table_number}号桌）` : ""}</strong><span>{row.customer_name || "未填写姓名"} · {row.people_count}人 · 定金可抵 {money(row.deposit_balance_fen)}</span></div>
        <span className={row.status === "RESERVED" ? "status-pill green" : "status-pill gray"}>{statusLabel(row.status)}</span>
        {row.order_id && <span className="muted">账单已开</span>}
      </button>)}</div> : <div className="empty">暂时没有宴席预定</div>}
    </div>

    {detail && <div className="content-card">
      <div className="section-heading"><div><h3>{detailTable} · {detail.customer_name || "未填写姓名"}</h3><p className="muted">{displayDate(detail.starts_at)} 至 {displayDate(detail.ends_at)} · {detail.people_count}人 · 积分{detail.points_earning_enabled ? "累计" : "不累计"}{detail.customer_phone ? ` · ${detail.customer_phone}` : ""}</p></div><span className={detail.status === "RESERVED" ? "status-pill green" : "status-pill gray"}>{statusLabel(detail.status)}</span></div>
      {detail.status === "RESERVED" && <div className="settings-layout">
        <div className="content-card">
          <h4>改期或取消</h4>
          <form className="form-grid" onSubmit={(event) => void saveReschedule(event)}>
            <label>开始时间<input type="datetime-local" value={editPeriod.startsAt} onChange={(event) => setEditPeriod({ ...editPeriod, startsAt: event.target.value })} required /></label>
            <label>结束时间<input type="datetime-local" value={editPeriod.endsAt} onChange={(event) => setEditPeriod({ ...editPeriod, endsAt: event.target.value })} required /></label>
            <button className="secondary" disabled={busy}>保存改期</button>
          </form>
          {cancelConfirm ? <div className="modal-actions"><span>取消预定后仍需单独办理定金退款。</span><button type="button" className="secondary" onClick={() => setCancelConfirm(false)}>返回</button><button type="button" className="danger-button" disabled={busy} onClick={() => void cancelReservation()}>确认取消</button></div> : <button type="button" className="text-button danger-text" disabled={busy} onClick={() => setCancelConfirm(true)}>取消预定</button>}
        </div>
        <div className="content-card preorder-entry-card">
          <h4>需要预点菜？</h4>
          <p>点击下面按钮进入普通点菜页。菜品、口味、数量、备注和厨房打印都按普通订单处理；保存预定时不会先打印备菜单。</p>
          <button type="button" className="primary" disabled={busy || !detail.table_id} onClick={() => void convertToOrder()}>进入普通点菜</button>
          {!detail.table_id && <p className="warning-text">这是一条旧宴席记录，没有绑定现有桌台，不能进入普通点菜页。</p>}
          {detail.preorder?.length > 0 && <p className="muted">这条旧记录已有 {detail.preorder.length} 项历史预点菜，仅供查看；新预点菜请使用普通点菜页。</p>}
        </div>
      </div>}

      <div className="settings-layout">
        <div className="content-card">
          <h4>定金账本 · 可抵扣 {money(detail.deposit_balance_fen)}</h4>
          <form className="form-grid" onSubmit={(event) => void operateDeposit(event)}>
            <label>操作<select value={depositAction} onChange={(event) => setDepositAction(event.target.value as "receive" | "refund")}><option value="receive">收取定金</option>{canManageHalls && <option value="refund">退还定金</option>}</select></label>
            <label>金额（元）<input inputMode="decimal" value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} placeholder="例如 500.00" required /></label>
            <label>{depositAction === "receive" ? "收款方式" : "退款方式"}<select value={depositPaymentMethod} onChange={(event) => setDepositPaymentMethod(event.target.value)}><option>现金</option><option>微信</option><option>支付宝</option><option>银行卡</option><option>其他</option></select></label>
            <label>备注<input value={depositNote} onChange={(event) => setDepositNote(event.target.value)} maxLength={300} /></label>
            <button className="secondary" disabled={busy}>{depositAction === "receive" ? "确认收款记账" : "确认退款记账"}</button>
          </form>
          {detail.deposit_ledger?.length ? <div className="employee-list">{detail.deposit_ledger.map((entry) => <div className="employee-row" key={entry.id}>
            <div><strong>{({ RECEIVE: "收定金", REFUND: "退定金", APPLY: "结账抵扣", RESTORE: "撤销恢复" } as const)[entry.kind]}</strong><span>{displayDate(entry.created_at)}{entry.kind === "RECEIVE" || entry.kind === "REFUND" ? ` · ${entry.payment_method}` : ""} · {entry.note}</span></div>
            <span>{entry.kind === "REFUND" || entry.kind === "APPLY" ? "−" : "+"}{money(entry.amount_fen)}</span>
          </div>)}</div> : <div className="empty">暂无定金记录</div>}
        </div>
        <div className="content-card">
          <h4>{detail.order_id ? "宴席账单" : "普通点菜"}</h4>
          {detail.order_id ? <><p>这笔宴席已经开账，可继续点菜、打印和结账。</p><button type="button" className="primary" onClick={() => onOpenOrder(detail.order_id!)}>打开宴席账单</button></> : <><p>需要预点菜时进入普通点菜页；现场用餐也可以在这里开账后再点菜。</p><button type="button" className="primary" disabled={busy || detail.status !== "RESERVED" || !detail.table_id} onClick={() => void convertToOrder()}>进入普通点菜</button></>}
        </div>
      </div>
    </div>}
  </section>;
}

export default BanquetPage;
