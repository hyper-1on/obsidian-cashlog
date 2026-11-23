// 插件设置数据模型

export interface BudgetConfig {
  id: string;
  name: string;
  amount: number;
  period: "weekly" | "monthly" | "yearly" | "custom";
  tag: string;
  startDate?: string;
  endDate?: string;
  rollover: boolean;
}

export interface GoalConfig {
  id: string;
  name: string;
  targetAmount: number;
  period: "weekly" | "monthly" | "yearly" | "custom";
  tag: string;
  startDate?: string;
  endDate?: string;
}

export interface CashlogSettings {
  incomeTag: string;
  expenseTag: string;
  transferTag: string;
  balanceChangeTag: string;
  incomeSubTags: string[];
  expenseSubTags: string[];
  globalQuery: string;
  excludePaths: string[];
  includePaths: string[];
  showEditButton: boolean;
  showNoteLink: boolean;

  // 账户功能
  enableAccounts: boolean;
  accounts: string[];
  accountBalances: Record<string, number>;

  // 附件功能
  enableAttachments: boolean;
  attachmentFolder: string;

  // 预算
  enableBudgets: boolean;
  budgets: BudgetConfig[];

  // 目标
  enableGoals: boolean;
  goals: GoalConfig[];

  // 面板统计
  statsMode: "day" | "week" | "month" | "year" | "all";
  statsMonthStartDay: number;
  statsWeekStartDay: number;

  // 货币符号覆盖：空字符串表示使用当前语言的默认符号
  currencySymbol: string;
}

export const DEFAULT_SETTINGS: CashlogSettings = {
  incomeTag: "#收入",
  expenseTag: "#支出",
  transferTag: "#转账",
  balanceChangeTag: "#余额变更",
  incomeSubTags: ["工资", "理财", "兼职", "红包", "其他"],
  expenseSubTags: ["餐饮", "交通", "购物", "娱乐", "住房", "医疗", "教育", "其他"],
  globalQuery: "",
  excludePaths: [],
  includePaths: [],
  showEditButton: true,
  showNoteLink: true,

  // 账户功能默认关闭
  enableAccounts: false,
  accounts: ["微信", "支付宝", "现金", "银行卡"],
  accountBalances: {},

  // 附件功能默认关闭
  enableAttachments: false,
  attachmentFolder: "cashlog-attachments",

  // 预算和目标默认关闭
  enableBudgets: false,
  budgets: [],
  enableGoals: false,
  goals: [],

  // 面板统计默认为按月
  statsMode: "month",
  statsMonthStartDay: 1,
  statsWeekStartDay: 1,

  // 空表示跟随语言默认（zh-CN → ¥，en → $）
  currencySymbol: "",
};

// 返回一份全新的默认设置。
// 直接用 DEFAULT_SETTINGS 会被调用方就地修改（例如 accounts.push），
// 从而永久污染默认值、使「恢复默认」失效，因此这里做深拷贝。
export function createDefaultSettings(): CashlogSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CashlogSettings;
}
