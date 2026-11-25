// 导入功能 · 生成 cashlog 行
//
// 纯函数：草稿 → 一行 Markdown。与 CashlogEntry.toFileLineString 保持同一种格式：
//   - #标签 描述 💴金额 ➕日期 ⏰时间
// 这里不直接构造 CashlogEntry，因为那个类需要完整的账户/附件上下文，
// 而导入阶段只需要「标签 + 描述 + 金额 + 日期」这几样。

import type { ImportDraft } from "./draft";
import { draftDate } from "./draft";

/**
 * 一条草稿能否写入。
 *
 * 不能写的三种情况：
 * - 方向未定（中性交易还没选）
 * - 没有主标签
 * - 没有选中
 */
export function draftReady(draft: ImportDraft): { ok: boolean; reason?: string } {
  if (!draft.selected) return { ok: false, reason: "未勾选" };
  if (draft.entryType === null) return { ok: false, reason: "方向未定" };
  if (draft.mainTag === null) return { ok: false, reason: "未指定标签" };
  if (draft.entryType === "transfer") {
    return { ok: false, reason: "转账条目暂不支持导入" };
  }
  return { ok: true };
}

/** 金额去尾零：35.50 → 35.5，35.00 → 35。 */
function moneyText(n: number): string {
  const fixed = Math.round(n * 100) / 100;
  return String(fixed);
}

/**
 * 把草稿序列化成一行。
 *
 * 支出写成负数、收入写正数，与 CashlogEntry 一致；
 * 指定了账户时写成 `💳账户💴金额`，否则只写 `💴金额`。
 */
export function draftToLine(draft: ImportDraft): string {
  if (draft.entryType !== "income" && draft.entryType !== "expense") {
    throw new Error(`不支持的条目类型: ${String(draft.entryType)}`);
  }

  const tags = [draft.mainTag, ...draft.extraTags].filter(
    (tag): tag is string => typeof tag === "string" && tag !== "",
  );

  const parts: string[] = [];
  if (tags.length > 0) parts.push(tags.join(" "));
  if (draft.description.trim() !== "") parts.push(draft.description.trim());

  const signed = draft.entryType === "income" ? draft.record.amount : -draft.record.amount;
  const money = moneyText(signed);
  if (draft.account) {
    parts.push(`💳${draft.account}💴${money}`);
  } else {
    parts.push(`💴${money}`);
  }

  parts.push(`➕${draftDate(draft)}`);

  // 交易时间带时分秒时，把时间也写进条目（cashlog 的 ⏰ 标记）
  const timePart = draft.record.tradeTime.slice(11, 16);
  if (timePart !== "00:00") parts.push(`⏰${timePart}`);

  return `- ${parts.join(" ")}`;
}

/** 批量生成，返回可写入的行；不可写入的草稿被跳过并给出原因。 */
export function buildLines(drafts: ImportDraft[]): {
  lines: string[];
  skipped: Array<{ draft: ImportDraft; reason: string }>;
} {
  const lines: string[] = [];
  const skipped: Array<{ draft: ImportDraft; reason: string }> = [];

  for (const draft of drafts) {
    const ready = draftReady(draft);
    if (!ready.ok) {
      skipped.push({ draft, reason: ready.reason ?? "未知原因" });
      continue;
    }
    lines.push(draftToLine(draft));
  }

  return { lines, skipped };
}
