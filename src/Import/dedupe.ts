// 导入功能 · 去重
//
// 不持久化订单号（几千条会长到 100–200KB，且不是每个来源都有）。
// 改为每次导入时与「笔记里已有的条目」实时比对。
//
// 匹配只能做到「弱匹配」：同日期 + 同金额 + 同方向。
// 订单号没有写进笔记，无法精确比对。所以标记是「疑似」，不是「已导入」，
// 由用户在清单里最终决定 —— 同一天买两杯同价咖啡，第二条会被标成疑似，
// 但看一眼描述就能判断。

import type { ExistingEntryKey, ImportDraft } from "./draft";
import { draftDate } from "./draft";

/** 弱匹配键：日期 + 金额 + 方向。 */
function weakKey(date: string, amount: number, direction: "income" | "expense"): string {
  return `${date}|${amount.toFixed(2)}|${direction}`;
}

/**
 * 给草稿打上去重标记，就地修改并返回同一数组。
 *
 * 优先级：批次内重复 > 疑似重复 > 新增。
 * 中性交易（needs-direction）不参与去重 —— 方向都还没定，比不了。
 */
export function markDuplicates(
  drafts: ImportDraft[],
  existing: ExistingEntryKey[],
): ImportDraft[] {
  // 已有条目按弱匹配键计数：同一天可能有多笔同额记录
  const existingCount = new Map<string, number>();
  for (const e of existing) {
    const key = weakKey(e.date, e.amount, e.direction);
    existingCount.set(key, (existingCount.get(key) ?? 0) + 1);
  }

  // 本次文件内已出现过的订单号
  const seenOrder = new Map<string, number>();

  for (const draft of drafts) {
    const orderNo = draft.record.orderNo;

    // 1. 批次内重复：同一订单号第二次出现
    if (orderNo) {
      const seen = seenOrder.get(orderNo) ?? 0;
      seenOrder.set(orderNo, seen + 1);
      if (seen > 0) {
        draft.status = "batch-duplicate";
        draft.selected = false;
        continue;
      }
    }

    // 2. 方向未定的先不比对
    if (draft.status === "needs-direction") {
      draft.selected = false;
      continue;
    }

    // 3. 疑似重复
    if (draft.entryType === "income" || draft.entryType === "expense") {
      const key = weakKey(draftDate(draft), draft.record.amount, draft.entryType);
      const hit = existingCount.get(key) ?? 0;
      if (hit > 0) {
        draft.status = "suspect-duplicate";
        draft.duplicateCount = hit;
        draft.selected = false;
      }
    }
  }

  return drafts;
}
