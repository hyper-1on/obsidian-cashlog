/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import type { CashlogEntry } from "./CashlogEntry";
import type { EntryLocation } from "./EntryLocation";

export interface AccountBalance {
  account: string;
  balance: number;
}

export class AccountManager {
  // 条目是否位于指定位置（编辑场景下用于排除被编辑的条目自身）
  static isSameLocation(entry: CashlogEntry, location: EntryLocation | null): boolean {
    if (!location || !entry.location) return false;
    return (
      entry.location.path === location.path &&
      entry.location.lineNumber === location.lineNumber
    );
  }

  // 从缓存条目重算所有账户余额
  // excludeLocation：编辑既有条目时传入该条目的位置。
  // 缓存里包含这条尚未写回的旧条目，若不排除，它的旧 delta 会被重复计入，
  // 导致「余额变更」每次编辑都发生偏移。
  static recomputeBalances(
    entries: CashlogEntry[],
    initialBalances: Record<string, number>,
    accountList: string[],
    excludeLocation: EntryLocation | null = null,
  ): Record<string, number> {
    const balances: Record<string, number> = {};

    for (const acct of accountList) {
      balances[acct] = initialBalances[acct] || 0;
    }

    for (const entry of entries) {
      if (AccountManager.isSameLocation(entry, excludeLocation)) {
        continue;
      }
      for (const { account, amount } of entry.accountAmounts) {
        if (account && balances[account] !== undefined) {
          balances[account] += amount;
        }
      }
    }

    return balances;
  }

  // 获取指定账户的收支记录
  static getEntriesByAccount(entries: CashlogEntry[], account: string): CashlogEntry[] {
    return entries.filter((e) =>
      e.accountAmounts.some((aa) => aa.account === account),
    );
  }

  // 获取余额明细列表
  static getBalanceList(
    entries: CashlogEntry[],
    initialBalances: Record<string, number>,
    accountList: string[],
  ): AccountBalance[] {
    const balances = AccountManager.recomputeBalances(entries, initialBalances, accountList);
    return Object.entries(balances).map(([account, balance]) => ({
      account,
      balance,
    }));
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
