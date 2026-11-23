/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import type { CashlogEntry } from "./EntryLocation";
import type { BudgetConfig, GoalConfig } from "./Settings";
import { DateRange } from "./Query/DateRange";
import { moment } from "./types";
import type { Moment } from "./types";
import { round2 } from "./MoneyUtils";

export interface BudgetProgress {
  config: BudgetConfig;
  spent: number;
  remaining: number;
  percentage: number;
  isOverspent: boolean;
  // 该预算匹配的条目（已按时段和标签过滤）
  matchingEntries: CashlogEntry[];
}

export interface GoalProgress {
  config: GoalConfig;
  earned: number;
  remaining: number;
  percentage: number;
  isAchieved: boolean;
  // 该目标匹配的条目（已按时段和标签过滤）
  matchingEntries: CashlogEntry[];
}

// 周期类型（合并了 StatsMode 和 Budget period）
export type PeriodType = BudgetConfig["period"] | "day" | "week" | "month" | "year" | "all";

// 根据周期类型计算日期范围（Dashboard 和 Budget 共用）
export function computePeriodRange(
  period: PeriodType,
  statsWeekStartDay: number,
  statsMonthStartDay: number,
  startDate?: string,
  endDate?: string,
  // 可注入「当前时刻」，便于测试与自定义周期复用；默认取当前时刻
  now: Moment = moment(),
): DateRange | null {
  switch (period) {
    case "day":
      return new DateRange(now.clone().startOf("day"), now.clone().endOf("day"));
    case "week":
    case "weekly": {
      const dayOfWeek = now.isoWeekday();
      const diff = dayOfWeek < statsWeekStartDay
        ? 7 - (statsWeekStartDay - dayOfWeek)
        : dayOfWeek - statsWeekStartDay;
      const start = now.clone().subtract(diff, "days").startOf("day");
      return new DateRange(start, now.clone().endOf("day"));
    }
    case "month":
    case "monthly": {
      // 起始日可能大于某个月的天数（29-31 日遇上 2 月等），必须按目标月份夹取：
      // moment 的 date(31) 会溢出到下个月，导致统计周期区间错位。
      const clampDay = (m: Moment): number => Math.min(statsMonthStartDay, m.daysInMonth());
      const currentDay = now.date();
      let start: Moment;
      if (currentDay >= clampDay(now)) {
        start = now.clone().date(clampDay(now)).startOf("day");
      } else {
        const prevMonth = now.clone().subtract(1, "months");
        start = prevMonth.date(clampDay(prevMonth)).startOf("day");
      }
      return new DateRange(start, now.clone().endOf("day"));
    }
    case "yearly":
    case "year":
      return new DateRange(
        now.clone().startOf("year").startOf("day"),
        now.clone().endOf("day"),
      );
    case "custom":
      if (startDate && endDate) {
        const s = moment(startDate);
        const e = moment(endDate);
        if (s.isValid() && e.isValid()) {
          return new DateRange(s, e);
        }
      }
      return null;
    case "all":
    default:
      return null;
  }
}

export class BudgetManager {
  // 获取所有预算的进度
  getBudgetProgress(
    entries: CashlogEntry[],
    budgets: BudgetConfig[],
    statsWeekStartDay: number,
    statsMonthStartDay: number,
  ): BudgetProgress[] {
    return budgets.map((budget) => {
      const range = computePeriodRange(
        budget.period, statsWeekStartDay, statsMonthStartDay,
        budget.startDate, budget.endDate,
      );
      // rollover：把上一周期未用完的额度加到本期额度上
      const rolledOver = budget.rollover
        ? this.computeRollover(entries, budget, statsWeekStartDay, statsMonthStartDay)
        : 0;
      const effectiveAmount = round2(budget.amount + rolledOver);
      const matchingEntries = this.filterByBudget(
        entries, budget, range?.start ?? null, range?.end ?? null,
      );
      const spent = round2(Math.abs(
        matchingEntries.reduce((sum, e) => sum + (e.amount < 0 ? e.amount : 0), 0),
      ));
      const remaining = round2(effectiveAmount - spent);
      const percentage = effectiveAmount > 0 ? Math.min(100, (spent / effectiveAmount) * 100) : 0;

      return {
        config: budget,
        spent,
        remaining: Math.max(0, remaining),
        percentage,
        isOverspent: spent > effectiveAmount,
        matchingEntries,
      };
    });
  }

  // 计算上一周期未用完的额度（预算滚存）。
  // 只有 weekly/monthly/yearly 有固定周期；day/custom/all 无法定义「上一周期」，返回 0。
  // 上期超支时不下滚（按 0 处理），避免负额度继续拉低本期额度。
  private computeRollover(
    entries: CashlogEntry[],
    budget: BudgetConfig,
    statsWeekStartDay: number,
    statsMonthStartDay: number,
  ): number {
    const thisRange = computePeriodRange(
      budget.period, statsWeekStartDay, statsMonthStartDay,
      budget.startDate, budget.endDate,
    );
    if (!thisRange) return 0;

    const thisStart = thisRange.start.clone();
    let prevStart: Moment;
    switch (budget.period) {
      case "weekly":
        prevStart = thisStart.clone().subtract(1, "week");
        break;
      case "monthly":
        prevStart = thisStart.clone().subtract(1, "month");
        break;
      case "yearly":
        prevStart = thisStart.clone().subtract(1, "year");
        break;
      default:
        return 0;
    }
    const prevEnd = thisStart.clone().subtract(1, "day").endOf("day");
    const prevEntries = this.filterByBudget(entries, budget, prevStart, prevEnd);
    const prevSpent = Math.abs(
      prevEntries.reduce((sum, e) => sum + (e.amount < 0 ? e.amount : 0), 0),
    );
    return Math.max(0, round2(budget.amount - prevSpent));
  }

  // 获取所有目标的进度
  getGoalProgress(
    entries: CashlogEntry[],
    goals: GoalConfig[],
    statsWeekStartDay: number,
    statsMonthStartDay: number,
  ): GoalProgress[] {
    return goals.map((goal) => {
      const range = computePeriodRange(
        goal.period, statsWeekStartDay, statsMonthStartDay,
        goal.startDate, goal.endDate,
      );
      const matchingEntries = this.filterByGoal(
        entries, goal, range?.start ?? null, range?.end ?? null,
      );
      const earned = round2(matchingEntries.reduce((sum, e) => sum + (e.amount > 0 ? e.amount : 0), 0));
      const remaining = round2(goal.targetAmount - earned);
      const percentage = goal.targetAmount > 0
        ? Math.min(100, (earned / goal.targetAmount) * 100)
        : 0;

      return {
        config: goal,
        earned,
        remaining: Math.max(0, remaining),
        percentage,
        isAchieved: earned >= goal.targetAmount,
        matchingEntries,
      };
    });
  }

  // 按条件过滤条目（共用：预算用 isExpense，目标用 isIncome）
  private filterByCondition(
    entries: CashlogEntry[],
    tag: string,
    periodStart: Moment | null,
    periodEnd: Moment | null,
    checkType: (e: CashlogEntry) => boolean,
  ): CashlogEntry[] {
    return entries.filter((entry) => {
      if (!checkType(entry)) return false;

      if (tag) {
        const matchesTag = entry.tags.some((t) =>
          t.toLowerCase().startsWith(tag.toLowerCase()),
        );
        if (!matchesTag) return false;
      }

      if (periodStart && periodEnd && entry.date) {
        return entry.date.isSameOrAfter(periodStart) && entry.date.isSameOrBefore(periodEnd);
      }

      return true;
    });
  }

  // 按预算条件过滤条目
  private filterByBudget(
    entries: CashlogEntry[],
    budget: BudgetConfig,
    periodStart: Moment | null,
    periodEnd: Moment | null,
  ): CashlogEntry[] {
    return this.filterByCondition(entries, budget.tag, periodStart, periodEnd, (e) => e.isExpense);
  }

  // 按目标条件过滤条目
  private filterByGoal(
    entries: CashlogEntry[],
    goal: GoalConfig,
    periodStart: Moment | null,
    periodEnd: Moment | null,
  ): CashlogEntry[] {
    return this.filterByCondition(entries, goal.tag, periodStart, periodEnd, (e) => e.isIncome);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
