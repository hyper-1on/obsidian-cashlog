// 导入功能 · 转账配对
//
// 支付宝分列式里，内部划转表现为成对的两条：
//   ...SOV_102   支出  -0.23   余额 1.41
//   ...SOV_101   收入   0.23   余额 1.64
// 同一秒、金额相等、方向相反，流水号只差末三位。
//
// 识别出来只是「提示」：清单里会标「这两条可能是一笔转账」，
// 是否合并由用户决定。不自动合并，因为同一个时间点也可能真的有两笔独立收支。

import type { ImportDraft } from "./draft";

export interface TransferPair {
  out: ImportDraft;
  in: ImportDraft;
  /** 判定依据，便于在清单里向用户解释 */
  reason: string;
}

/** 流水号去掉末三位（_101 / _102 这类后缀）后的主体。 */
function orderBase(orderNo: string | null): string | null {
  if (!orderNo) return null;
  const m = orderNo.match(/^(.*?)(?:_\d{3})?$/);
  return m ? m[1] : orderNo;
}

/**
 * 找出可能是同一笔转账的成对记录。
 *
 * 判定条件（全部满足）：
 * - 一条支出、一条收入
 * - 交易时间完全相同（到秒）
 * - 金额相等
 * 若两笔的流水号主体也相同（只差 _101/_102 后缀），额外标记为高置信。
 */
export function findTransferPairs(drafts: ImportDraft[]): TransferPair[] {
  const used = new Set<ImportDraft>();
  const pairs: TransferPair[] = [];

  const expenses = drafts.filter((d) => d.entryType === "expense");
  const incomes = drafts.filter((d) => d.entryType === "income");

  for (const out of expenses) {
    if (used.has(out)) continue;

    let matched: ImportDraft | null = null;
    let matchedReason = "";

    for (const inn of incomes) {
      if (used.has(inn)) continue;
      if (inn.record.tradeTime !== out.record.tradeTime) continue;
      if (Math.abs(inn.record.amount - out.record.amount) >= 0.005) continue;

      const outBase = orderBase(out.record.orderNo);
      const inBase = orderBase(inn.record.orderNo);
      const sameBase = outBase !== null && inBase !== null && outBase === inBase;

      matched = inn;
      matchedReason = sameBase
        ? "同一秒、等额、方向相反，且流水号主体相同"
        : "同一秒、等额、方向相反";
      break;
    }

    if (matched) {
      used.add(out);
      used.add(matched);
      pairs.push({ out, in: matched, reason: matchedReason });
    }
  }

  return pairs;
}

/** 把配对结果整理成「草稿 → 配对的另一半」，便于清单渲染时查。 */
export function pairIndex(pairs: TransferPair[]): Map<ImportDraft, ImportDraft> {
  const index = new Map<ImportDraft, ImportDraft>();
  for (const pair of pairs) {
    index.set(pair.out, pair.in);
    index.set(pair.in, pair.out);
  }
  return index;
}
