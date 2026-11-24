// 导入功能 · 值清洗
//
// 金额与时间在各平台写法不同，这里集中归一化，避免每个 profile 各写一套。

/**
 * 解析金额为数字。返回 null 表示「这一列没有值」。
 *
 * 关键点：判断的是「有没有值」而不是「值是否为 0」。
 * 支付宝的「账户开户」一行收入列是 0.00，按数值判会被当成空值，
 * 结果比文件头声明的笔数少一条。
 */
export function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;

  const cleaned = String(raw)
    .replace(/[￥¥]/g, "")
    .replace(/,/g, "")
    .replace(/\u00a0/g, " ") // 不间断空格
    .trim();

  if (cleaned === "" || cleaned === "/" || cleaned === "-") return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 金额保留两位小数，避免浮点尾差。 */
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 把各种时间写法统一成 YYYY-MM-DDTHH:mm:ss。
 * 只有日期时补 T00:00:00；认不出返回 null。
 *
 * 已覆盖：2026-10-16 07:44:25 / 2026/10/16 07:44 / 2026-10-16 / 20261016
 * 银行常见的 20261016074425 由调用方先切成两段再传进来。
 */
export function normalizeTradeTime(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;

  // 2026-10-16 07:44:25 / 2026/10/16 07:44:25 / 带 T
  const full = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (full) {
    const [, y, mo, d, h, mi, se] = full;
    return `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${mi}:${se ?? "00"}`;
  }

  // 只有日期：2026-10-16 / 2026/10/16
  const dateOnly = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return `${y}-${pad2(mo)}-${pad2(d)}T00:00:00`;
  }

  // 紧凑日期：20261016
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const [, y, mo, d] = compact;
    return `${y}-${mo}-${d}T00:00:00`;
  }

  return null;
}

/**
 * 把 Excel 日期序列号转成 YYYY-MM-DDTHH:mm:ss。
 * SheetJS 在 raw 模式下会给出序列号而不是日期对象，这里统一处理。
 * 序列号起点是 1899-12-30（Excel 的闰年 bug 所致）。
 */
export function excelSerialToTime(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return iso.slice(0, 19);
}

function pad2(v: string): string {
  return v.length === 1 ? `0${v}` : v;
}
