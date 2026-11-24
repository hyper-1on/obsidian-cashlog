import { CashlogEntry } from "../EntryLocation";

// 过滤器：接受一个条目，返回是否匹配
export type FilterFunction = (entry: CashlogEntry) => boolean;

export interface FilterOrError {
  filter?: FilterFunction;
  error?: string;
}

// 排序器
export interface Sorter {
  field: string;
  direction: "ascending" | "descending";
}

// 分组器
export interface Grouper {
  field: string;
  // 仅对 tag 分组生效：子标签深度（1 = 一级，不填同 1）
  level?: number;
  // 仅对 tag 分组生效：定位到某一支（如 ["地点", "学校"]）。
  // 给定时会从条目的「全部标签」里找匹配项，而不只是主标签。
  tagPath?: string[];
}

// 查询结果
export interface QueryResult {
  groups: EntryGroup[];
  summary: Summary;
}

// 条目分组
export interface EntryGroup {
  key: string;
  entries: CashlogEntry[];
}

// 汇总信息
export interface Summary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  count: number;
}
