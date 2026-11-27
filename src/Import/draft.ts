// 导入功能 · 草稿
//
// 把归一化后的流水转成「待用户确认的条目草稿」。
// 草稿只是候选：标签、账户、方向都可能是空的，由清单界面补齐。
//
// 刻意不在这里决定标签。平台分类（餐饮美食 / 商户消费）各平台叫法不同，
// 而且有的导出根本没有，硬映射只会制造错误数据；宁可留空让用户批量指定。

import type { ImportRecord } from "./types";

/** 草稿在清单里的状态。 */
export type DraftStatus =
  | "new" // 没有发现冲突，默认勾选
  | "suspect-duplicate" // 笔记里已有同日同额的记录，默认不勾
  | "batch-duplicate" // 本次文件内重复，默认不勾
  | "needs-direction"; // 中性交易，方向未定，必须先选

/** 一条待确认的导入草稿。 */
export interface ImportDraft {
  /** 原始解析结果 */
  record: ImportRecord;
  /** 目标条目类型；undetermined 时为 null，等用户选 */
  entryType: "expense" | "income" | "transfer" | null;
  /** 主标签，如 #支出/餐饮；为空表示还没指定 */
  mainTag: string | null;
  /**
   * mainTag 的来源。
   * inherited = 跟随所属分组（用户没单独改过）；
   * manual    = 用户在这一条上单独指定过，组级再改时按策略决定是否覆盖。
   */
  tagSource: "inherited" | "manual";
  /** 附加标签（地点、必要性等） */
  extraTags: string[];
  /** 描述：默认由对方/商品拼出，用户可改 */
  description: string;
  /** 账户名；转账时需要「转出」「转入」两个，这里只存主账户 */
  account: string | null;
  /** 目标账户（仅转账有意义） */
  transferToAccount: string | null;
  /** 清单状态 */
  status: DraftStatus;
  /** 疑似重复时，命中的已有条目条数 */
  duplicateCount: number;
  /** 是否勾选；由状态决定默认值，用户可改 */
  selected: boolean;
}

/** 笔记里已存在的条目，用于去重的精简特征。 */
export interface ExistingEntryKey {
  /** YYYY-MM-DD */
  date: string;
  /** 金额绝对值 */
  amount: number;
  /** 方向：只有 income / expense 能可靠比对 */
  direction: "income" | "expense";
}

const WECHAT_NEUTRAL = "中性交易";

/**
 * 由流水记录生成草稿。
 *
 * 描述拼接优先级：交易对方 → 商品 → 备注。
 * 对方是「谁」，商品是「买了什么」，对账时先看对方更符合直觉。
 */
export function toDraft(record: ImportRecord): ImportDraft {
  const entryType =
    record.direction === "income"
      ? "income"
      : record.direction === "expense"
        ? "expense"
        : record.direction === "transfer"
          ? "transfer"
          : null;

  const description = buildDescription(record);

  return {
    record,
    entryType,
    mainTag: null,
    tagSource: "inherited",
    extraTags: [],
    description,
    account: null,
    transferToAccount: null,
    status: record.direction === "undetermined" ? "needs-direction" : "new",
    duplicateCount: 0,
    // 一律默认勾选：按方向决定会出现「这组全勾、那组全不勾」的观感，
    // 用户无从判断是不是自己点过。方向未定的条目导入时会被拦下并说明。
    selected: true,
  };
}

/** 默认描述。各项都不存在时给一个可编辑的占位，避免生成空描述。 */
export function buildDescription(record: ImportRecord): string {
  const parts: string[] = [];
  const push = (v: string | null) => {
    const s = (v ?? "").trim();
    if (s && s !== "/" && !parts.includes(s)) parts.push(s);
  };

  push(record.counterparty);
  push(record.product);
  push(record.note);

  if (parts.length === 0) {
    return record.category && record.category !== WECHAT_NEUTRAL ? record.category : "导入记录";
  }
  return parts.join(" ");
}

/** 草稿的日期部分（YYYY-MM-DD），用于分组与去重。 */
export function draftDate(draft: ImportDraft): string {
  return draft.record.tradeTime.slice(0, 10);
}

/** 批量生成草稿。 */
export function toDrafts(records: ImportRecord[]): ImportDraft[] {
  return records.map(toDraft);
}
