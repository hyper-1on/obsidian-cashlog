/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { moment } from "./types";
import { CashlogEntry, type AccountAmount } from "./CashlogEntry";
import { EditableEntryData } from "./CashlogModal";
import type CashlogPlugin from "./main";
import { AccountManager } from "./AccountManager";
import type { EntryLocation } from "./EntryLocation";
import { round2 } from "./MoneyUtils";
import { t } from "./i18n";

// 构建上下文：indentation、listMarker、location 可能来自新条目的行上下文，也可能来自原条目
export interface EntryBuildContext {
  indentation: string;
  listMarker: string;
  location: EntryLocation | null;
}

// 校验弹窗数据，返回错误信息；null 表示可以提交。
// 存在意义：无金额且无账户金额的条目在严格解析下不会被识别为记账条目，
// 若放任写回，用户会看到「显示记账成功、查询却查不到」的假象。
export function validateEntryData(data: EditableEntryData): string | null {
  const num = (value: string): number => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  if (data.tagType === "transfer") {
    const outTotal = data.fromAccounts.reduce((sum, a) => sum + num(a.amount), 0);
    if (outTotal <= 0) return t("validation.transferOutRequired");
    const inTotal = data.toAccounts.reduce((sum, a) => sum + num(a.amount), 0);
    if (inTotal <= 0) return t("validation.transferInRequired");
    return null;
  }

  if (data.tagType === "balanceChange") {
    // 目标余额允许为 0（表示把账户清空）
    return null;
  }

  const total = data.accounts.reduce((sum, a) => sum + num(a.amount), 0);
  if (total <= 0) return t("validation.amountRequired");
  return null;
}

// 从 Modal 数据构建 CashlogEntry（统一版本，支持新建和编辑）
export function buildEntryFromModalData(
  data: EditableEntryData,
  plugin: CashlogPlugin,
  context: EntryBuildContext,
): CashlogEntry {
  const settings = plugin.settings;
  const date = data.date ? moment(data.date, "YYYY-MM-DD") : moment();
  const validDate = date.isValid() ? date : moment();

  if (data.tagType === "transfer") {
    const accountAmounts: AccountAmount[] = [
      ...data.fromAccounts.map((a) => ({
        account: a.account,
        amount: -(parseFloat(a.amount) || 0),
      })),
      ...data.toAccounts.map((a) => ({
        account: a.account,
        amount: parseFloat(a.amount) || 0,
      })),
    ];

    return new CashlogEntry(
      data.description,
      0,
      validDate,
      data.time || null,
      [settings.transferTag],
      context.indentation,
      context.listMarker,
      context.location,
      "",
      accountAmounts,
      data.attachments,
      "transfer",
    );
  }

  // 余额变更类型
  if (data.tagType === "balanceChange") {
    const entries = plugin.cache.getEntries();
    // 编辑既有条目时必须排除它自身（缓存里还是写回前的旧行），
    // 否则旧 delta 会被重复计入，导致余额每次编辑都偏移。
    const currentBalances = AccountManager.recomputeBalances(
      entries,
      settings.accountBalances,
      settings.accounts,
      context.location,
    );

    const accountAmounts: AccountAmount[] = [];
    for (const item of data.balanceChangeAccounts) {
      const targetBalance = parseFloat(item.amount) || 0;
      const currentBalance = currentBalances[item.account] || 0;
      const difference = targetBalance - currentBalance;
      accountAmounts.push({ account: item.account, amount: parseFloat(difference.toFixed(2)) });
    }

    return new CashlogEntry(
      data.description,
      0,
      validDate,
      data.time || null,
      [settings.balanceChangeTag],
      context.indentation,
      context.listMarker,
      context.location,
      "",
      accountAmounts,
      data.attachments,
      "balanceChange",
    );
  }

  const sign = data.tagType === "income" ? 1 : -1;
  const baseTag = data.tagType === "income" ? settings.incomeTag : settings.expenseTag;
  const fullTag = data.subTag ? `${baseTag}/${data.subTag}` : baseTag;

  let noAccountAmt = 0;
  const accountAmounts: AccountAmount[] = [];

  for (const item of data.accounts) {
    const amt = (parseFloat(item.amount) || 0) * sign;
    if (item.account === "") {
      noAccountAmt += amt;
    } else {
      accountAmounts.push({ account: item.account, amount: amt });
    }
  }

  const amount = round2(noAccountAmt + accountAmounts.reduce((s, aa) => s + aa.amount, 0));

  // 主标签 + 附加标签：副标签原样写回，否则编辑一次就会丢失 #地点/食堂 这类标签
  const allTags = [fullTag, ...data.extraTags];

  return new CashlogEntry(
    data.description,
    amount,
    validDate,
    data.time || null,
    allTags,
    context.indentation,
    context.listMarker,
    context.location,
    "",
    accountAmounts,
    data.attachments,
    "normal",
  );
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
