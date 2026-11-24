// 导入功能 · 对账
//
// 个人账单的文件头都自带汇总（共 N 笔、收入 N 笔 X 元……）。
// 解析完拿它比对，是这个功能唯一「自证正确」的手段：
// 只要笔数和金额都对得上，就说明表头定位、方向判定、金额清洗都没错。

import type { DeclaredSummary, ImportRecord } from "./types";

export interface ReconcileItem {
  label: string;
  /** 解析出来的值 */
  actual: number;
  /** 文件头声明的值；未声明为 null */
  declared: number | null;
  /** declared 为 null 时记 null（无法比较），不算失败 */
  ok: boolean | null;
}

export interface ReconcileResult {
  items: ReconcileItem[];
  /** 有任何一项 ok === false */
  failed: boolean;
}

const EPSILON = 0.005;

function cmpCount(label: string, actual: number, declared: number | null | undefined): ReconcileItem {
  if (declared === null || declared === undefined) {
    return { label, actual, declared: null, ok: null };
  }
  return { label, actual, declared, ok: actual === declared };
}

function cmpSum(label: string, actual: number, declared: number | null | undefined): ReconcileItem {
  if (declared === null || declared === undefined) {
    return { label, actual, declared: null, ok: null };
  }
  return {
    label,
    actual,
    declared,
    ok: Math.abs(actual - declared) < EPSILON,
  };
}

/** 按方向分组统计笔数与金额合计。 */
export function summarize(records: ImportRecord[]): {
  total: number;
  income: { count: number; sum: number };
  expense: { count: number; sum: number };
  transfer: { count: number; sum: number };
  undetermined: { count: number; sum: number };
} {
  const bucket = (dir: ImportRecord["direction"]) => {
    const list = records.filter((r) => r.direction === dir);
    return {
      count: list.length,
      sum: Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    };
  };

  return {
    total: records.length,
    income: bucket("income"),
    expense: bucket("expense"),
    transfer: bucket("transfer"),
    undetermined: bucket("undetermined"),
  };
}

/**
 * 与文件头对账。
 *
 * 中性交易（undetermined）在文件头里单独算一类，所以拿 transfer + undetermined
 * 两个桶一起比，否则明明解析对了也会报差异。
 */
export function reconcile(records: ImportRecord[], declared: DeclaredSummary | null): ReconcileResult {
  const s = summarize(records);
  const items: ReconcileItem[] = [];

  if (declared) {
    items.push(cmpCount("总笔数", s.total, declared.totalCount));
    items.push(cmpCount("收入笔数", s.income.count, declared.income?.count));
    items.push(cmpSum("收入合计", s.income.sum, declared.income?.sum));
    items.push(cmpCount("支出笔数", s.expense.count, declared.expense?.count));
    items.push(cmpSum("支出合计", s.expense.sum, declared.expense?.sum));

    // 中性交易：文件头称「中性交易」或「不计收支」，界面上统一叫「未定」
    const undeterminedCount = s.transfer.count + s.undetermined.count;
    const undeterminedSum =
      Math.round((s.transfer.sum + s.undetermined.sum) * 100) / 100;
    items.push(cmpCount("未定笔数", undeterminedCount, declared.transfer?.count));
    items.push(cmpSum("未定合计", undeterminedSum, declared.transfer?.sum));
  }

  return {
    items,
    failed: items.some((i) => i.ok === false),
  };
}
