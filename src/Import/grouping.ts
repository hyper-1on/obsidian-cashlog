// 导入功能 · 分组与批量标记
//
// 清单的交互模型是「继承 + 覆盖」：
// - 分组行有一个默认标签（可以是任意深度，只写「支出」也行）
// - 组内每条草稿继承它；用户单独改过的记为 manual
// - 分组行显示的标签是算出来的：全组一致就显示那个值，不一致显示「自定义」
//
// 「自定义」不存成数据，只是计算出来的展示状态。存了就会出现
// 「值是自定义、但组内其实又统一了」这类不一致。
//
// 设计成可插拔是为了后续改动：
// - 分组维度是一个函数，换成按商品 / 按时段 / 按平台分类都不用改这里
// - 批量操作是一个 update 对象，之后要加「批量设备注/附加标签」只扩字段

import type { ImportDraft } from "./draft";

/** 一个分组（默认按交易对方聚合）。 */
export interface ImportGroup {
  /** 分组键 */
  key: string;
  /** 组内草稿，保持原顺序 */
  drafts: ImportDraft[];
  /** 组级默认标签；null 表示没设过 */
  defaultTag: string | null;
}

/** 分组键提取函数。换维度只需实现一个新的。 */
export type GroupKeyFn = (draft: ImportDraft) => string;

/** 默认：按交易对方。对方为空时落进同一个「未注明」组。 */
export const groupByCounterparty: GroupKeyFn = (draft) => {
  const name = (draft.record.counterparty ?? "").trim();
  return name === "" || name === "/" ? "（未注明对方）" : name;
};

/** 备选：按平台分类。没有分类的来源会全部落进「（无分类）」。 */
export const groupByCategory: GroupKeyFn = (draft) => {
  const cat = (draft.record.category ?? "").trim();
  return cat === "" || cat === "/" ? "（无分类）" : cat;
};

/** 备选：按资金渠道（用于账户映射的场景）。 */
export const groupByPayMethod: GroupKeyFn = (draft) => {
  const pay = (draft.record.payMethod ?? "").trim();
  return pay === "" || pay === "/" ? "（未知渠道）" : pay;
};

/**
 * 按给定维度分组。
 * 组内顺序保持 drafts 的原始顺序（也就是账单里的时间倒序），
 * 这样展开后一眼就能看出时段分布，方便按时段多选。
 */
export function groupDrafts(
  drafts: ImportDraft[],
  keyFn: GroupKeyFn = groupByCounterparty,
): ImportGroup[] {
  const map = new Map<string, ImportGroup>();

  for (const draft of drafts) {
    const key = keyFn(draft);
    let group = map.get(key);
    if (!group) {
      group = { key, drafts: [], defaultTag: null };
      map.set(key, group);
    }
    group.drafts.push(draft);

    // 组级默认标签先取第一条有标签的值，供展示与后续「应用到全组」使用
    if (group.defaultTag === null && draft.mainTag !== null) {
      group.defaultTag = draft.mainTag;
    }
  }

  return [...map.values()];
}

/** 组内标签的展示状态。 */
export type GroupTagState =
  | { kind: "empty"; tag: null } // 全组都没设
  | { kind: "uniform"; tag: string } // 全组一致
  | { kind: "mixed"; tag: null }; // 不一致，界面显示「自定义」

/**
 * 计算组内标签状态。
 *
 * 注意这里看的是「实际生效的 mainTag」，不是 defaultTag。
 * defaultTag 只是「组级最后设过的值」，用户逐条改过之后它可能已经过时。
 */
export function groupTagState(group: ImportGroup): GroupTagState {
  const tags = new Set<string>();
  let hasNull = false;

  for (const draft of group.drafts) {
    if (draft.mainTag === null) hasNull = true;
    else tags.add(draft.mainTag);
  }

  if (tags.size === 0) return { kind: "empty", tag: null };
  if (tags.size === 1 && !hasNull) return { kind: "uniform", tag: [...tags][0] };
  return { kind: "mixed", tag: null };
}

export interface SetGroupTagOptions {
  /**
   * 是否把手动改过的条目也覆盖掉。
   * 默认 true：用户点了组级选择器，通常就是想「全组统一」。
   * 置 false 时只更新 inherited 的条目，保留 manual 的例外。
   */
  overwriteManual?: boolean;
}

/**
 * 设置组级标签，并同步到组内条目。
 *
 * tag 传 null 表示「清空」，条目回到未指定状态。
 */
export function setGroupTag(
  group: ImportGroup,
  tag: string | null,
  options: SetGroupTagOptions = {},
): void {
  const overwriteManual = options.overwriteManual ?? true;
  group.defaultTag = tag;

  for (const draft of group.drafts) {
    if (!overwriteManual && draft.tagSource === "manual") continue;
    draft.mainTag = tag;
    draft.tagSource = "inherited";
  }
}

/** 单条修改：标记为 manual，组级之后是否覆盖由 setGroupTag 的策略决定。 */
export function setDraftTag(draft: ImportDraft, tag: string | null): void {
  draft.mainTag = tag;
  draft.tagSource = "manual";
}

/**
 * 批量更新的字段集合。
 * 现在只有标签与描述；以后要加附加标签、账户等，直接在这里扩字段，
 * 调用方（清单 UI）不用改结构。
 */
export interface BatchUpdate {
  /** 设成某个完整标签；不传表示不改 */
  mainTag?: string | null;
  /** 覆盖描述 */
  description?: string;
  /** 追加附加标签（去重） */
  addExtraTags?: string[];
}

/**
 * 对一组草稿应用批量更新。
 * 只有「明确给了值」的字段才会被改，未给的字段保持原样。
 */
export function applyBatch(drafts: ImportDraft[], update: BatchUpdate): void {
  for (const draft of drafts) {
    if (update.mainTag !== undefined) {
      draft.mainTag = update.mainTag;
      // 批量设置也算用户主动指定，标成 manual，避免之后组级操作被意外覆盖
      draft.tagSource = "manual";
    }
    if (update.description !== undefined) {
      draft.description = update.description;
    }
    if (update.addExtraTags && update.addExtraTags.length > 0) {
      for (const tag of update.addExtraTags) {
        if (!draft.extraTags.includes(tag)) draft.extraTags.push(tag);
      }
    }
  }
}

/** 统计各组里还有多少条没指定标签，用于清单底部的提示。 */
export function countUntagged(drafts: ImportDraft[]): number {
  return drafts.filter((d) => d.mainTag === null).length;
}

/** 分组排序方式。 */
export type GroupSort =
  | "bill" // 账单顺序（默认）
  | "amount-desc" // 组内合计金额从大到小
  | "amount-asc" // 组内合计金额从小到大
  | "count-desc" // 条数从多到少
  | "name" // 名称
  | "pending-first"; // 未处理完的排前面

/** 组内金额合计（绝对值）。 */
export function groupTotal(group: ImportGroup): number {
  return Math.round(group.drafts.reduce((sum, d) => sum + d.record.amount, 0) * 100) / 100;
}

/**
 * 按指定方式排序分组。
 * 返回新数组，不动传入的顺序 —— 调用方可能还要按账单顺序回退。
 */
export function sortGroups(groups: ImportGroup[], sort: GroupSort): ImportGroup[] {
  const copy = [...groups];

  switch (sort) {
    case "bill":
      return copy;
    case "amount-desc":
      return copy.sort((a, b) => groupTotal(b) - groupTotal(a));
    case "amount-asc":
      return copy.sort((a, b) => groupTotal(a) - groupTotal(b));
    case "count-desc":
      return copy.sort((a, b) => b.drafts.length - a.drafts.length);
    case "name":
      return copy.sort((a, b) => a.key.localeCompare(b.key, "zh-Hans-CN"));
    case "pending-first":
      // 组内还没统一标签的算「待处理」，排到前面；同组保持原顺序
      return copy.sort((a, b) => {
        const pa = groupTagState(a).kind === "uniform" ? 1 : 0;
        const pb = groupTagState(b).kind === "uniform" ? 1 : 0;
        return pa - pb;
      });
    default:
      return copy;
  }
}
