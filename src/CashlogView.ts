/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type CashlogPlugin from "./main";
import { renderDashboard, hideTooltip, DashboardCallbacks } from "./DashboardRenderer";
import { renderPanelSettings, setPanelHideAmounts } from "./PanelSettings";
import { renderQueryResult } from "./Renderer";
import { Query, PANEL_PIE_COLORS } from "./Query/Query";
import { QueryResult, EntryGroup } from "./Query/Filter";
import { CashlogEntry } from "./EntryLocation";
import {
  transformToChartData,
  renderPieChart,
  clearLabelColorCache,
} from "./ChartRenderer";
import type { ChartDataResult } from "./ChartRenderer";
import type { ChartConfig } from "./Query/Query";
import { t, tp, formatMoney } from "./i18n";
import { round2 } from "./MoneyUtils";

export const CASHLOG_VIEW_TYPE = "cashlog-panel";

export class CashlogView extends ItemView {
  private plugin: CashlogPlugin;
  private activeTab: "dashboard" | "settings" = "dashboard";
  // 仪表盘子页面导航
  private subPage: {
    type: "entries" | "pie";
    title: string;
    entries: CashlogEntry[];
    expenseTag?: string;
    // 账户页面上下文
    context?: "account";
    accountName?: string;
    initialBalance?: number;
  } | null = null;
  private hideAmounts: boolean = true;
  // 面板饼图实例：重建内容前必须销毁，否则会泄漏 Chart 实例与 ResizeObserver
  private pieChart: { destroy(): void } | null = null;
  private panelContentEl: HTMLElement;
  private tabBarEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: CashlogPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CASHLOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("view.panelTitle");
  }

  getIcon(): string {
    return "wallet";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("cashlog-panel");

    // 内容区
    this.panelContentEl = container.createDiv({ cls: "cashlog-panel-content" });

    // 底部标签栏
    this.tabBarEl = container.createDiv({ cls: "cashlog-panel-tabs" });

    this.renderTabBar();
    this.switchTab("dashboard");

    // 监听缓存更新以刷新面板
    this.registerEvent(
      this.plugin.events.on("cashlog-render-refresh", () => {
        this.refresh();
      }),
    );
    await Promise.resolve();
  }

  async onClose(): Promise<void> {
    this.destroyPieChart();
    // tooltip 挂在 document.body 上，视图关闭时必须显式清理，否则会悬挂在页面上
    hideTooltip();
    // 面板关闭期间主题可能变化，丢弃缓存的标签颜色
    clearLabelColorCache();
  }

  // 饼图实例必须显式销毁：清空容器只会移除 canvas，
  // Chart 实例与它的 ResizeObserver 会一直留在内存里。
  private destroyPieChart(): void {
    this.pieChart?.destroy();
    this.pieChart = null;
  }

  // 统一的内容重建入口：先销毁图表、清理 body 上的 tooltip，再清空容器
  private clearPanelContent(): void {
    this.destroyPieChart();
    // 重建时 tooltip 的触发元素会被 empty() 移除，此后 mouseleave 不再触发；
    // 若不显式清理，tooltip 会一直悬挂在页面上直到下次触发
    hideTooltip();
    this.panelContentEl.empty();
  }

  private renderTabBar(): void {
    this.tabBarEl.empty();

    const dashboardBtn = this.tabBarEl.createEl("button", {
      cls: "cashlog-tab-btn" + (this.activeTab === "dashboard" ? " active" : ""),
      text: t("view.tab.dashboard"),
    });
    dashboardBtn.addEventListener("click", () => this.switchTab("dashboard"));

    const settingsBtn = this.tabBarEl.createEl("button", {
      cls: "cashlog-tab-btn" + (this.activeTab === "settings" ? " active" : ""),
      text: t("view.tab.settings"),
    });
    settingsBtn.addEventListener("click", () => this.switchTab("settings"));
  }

  private switchTab(tab: "dashboard" | "settings"): void {
    this.activeTab = tab;
    this.subPage = null;
    this.renderTabBar();

    // 设置页里的金额展示也要跟随隐私开关
    setPanelHideAmounts(this.hideAmounts);

    this.clearPanelContent();

    if (tab === "dashboard") {
      const callbacks: DashboardCallbacks = {
        showEntries: (entries, title, extra) => this.showEntryList(entries, title, extra),
        showPieChart: (entries, expenseTag) => this.showPieChart(entries, expenseTag),
      };
      renderDashboard(this.panelContentEl, this.plugin, callbacks, this.hideAmounts, () => this.toggleHideAmounts());
    } else {
      renderPanelSettings(this.panelContentEl, this.plugin);
    }
  }

  private toggleHideAmounts(): void {
    this.hideAmounts = !this.hideAmounts;
    if (this.activeTab !== "dashboard") return;
    if (this.subPage) {
      // 子页面也提供切换按钮，切换后重渲染当前子页面即可
      this.renderSubPage();
      return;
    }
    this.clearPanelContent();
    const callbacks: DashboardCallbacks = {
      showEntries: (entries, title, extra) => this.showEntryList(entries, title, extra),
      showPieChart: (entries, expenseTag) => this.showPieChart(entries, expenseTag),
    };
    renderDashboard(this.panelContentEl, this.plugin, callbacks, this.hideAmounts, () => this.toggleHideAmounts());
  }

  refresh(): void {
    if (this.subPage) {
      // 缓存更新后数据可能变化，安全起见返回仪表盘
      this.subPage = null;
    }
    if (this.activeTab === "dashboard") {
      this.clearPanelContent();
      const callbacks: DashboardCallbacks = {
        showEntries: (entries, title, extra) => this.showEntryList(entries, title, extra),
        showPieChart: (entries, expenseTag) => this.showPieChart(entries, expenseTag),
      };
      renderDashboard(this.panelContentEl, this.plugin, callbacks, this.hideAmounts, () => this.toggleHideAmounts());
    } else if (this.activeTab === "settings") {
      this.clearPanelContent();
      renderPanelSettings(this.panelContentEl, this.plugin);
    }
  }

  // 显示条目列表子页面
  private showEntryList(entries: CashlogEntry[], title: string, extra?: { accountName?: string; initialBalance?: number }): void {
    const context = extra?.accountName ? "account" as const : undefined;
    this.subPage = { type: "entries", title, entries, context, ...extra };
    this.renderSubPage();
  }

  // 显示扇形图子页面
  private showPieChart(entries: CashlogEntry[], expenseTag: string): void {
    this.subPage = { type: "pie", title: t("view.pieChartTitle"), entries, expenseTag };
    this.renderSubPage();
  }

  // 返回仪表盘主页
  private goBack(): void {
    this.subPage = null;
    const callbacks: DashboardCallbacks = {
      showEntries: (entries, title, extra) => this.showEntryList(entries, title, extra),
      showPieChart: (entries, expenseTag) => this.showPieChart(entries, expenseTag),
    };
    this.clearPanelContent();
    renderDashboard(this.panelContentEl, this.plugin, callbacks, this.hideAmounts, () => this.toggleHideAmounts());
  }

  // 渲染返回按钮
  // 子页面头部：返回按钮 + 金额隐藏开关。
  // 眼睛按钮原本只渲染在主页面的统计周期标签里（DashboardRenderer.renderPeriodLabel），
  // 子页面走的是另一条渲染链，因此需要在这里单独提供，否则子页面无法切换明/隐金额。
  private renderSubPageHeader(): void {
    const header = this.panelContentEl.createDiv({ cls: "cashlog-subpage-header" });

    const backBtn = header.createEl("button", { cls: "cashlog-back-btn" });
    backBtn.textContent = t("view.backToDashboard");
    backBtn.addEventListener("click", () => this.goBack());

    const toggle = header.createEl("button", { cls: "cashlog-subpage-toggle" });
    setIcon(toggle, this.hideAmounts ? "eye-off" : "eye");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleHideAmounts();
    });
  }

  // 渲染子页面内容
  private renderSubPage(): void {
    if (!this.subPage) return;

    this.clearPanelContent();
    this.renderSubPageHeader();

    // 子页面标题
    this.panelContentEl.createDiv({
      cls: "cashlog-subpage-title",
      text: this.subPage.title,
    });

    if (this.subPage.type === "entries") {
      this.renderEntryListPage();
    } else if (this.subPage.type === "pie") {
      this.renderPieChartPage();
    }
  }

  // 渲染条目列表子页面
  private renderEntryListPage(): void {
    if (!this.subPage || this.subPage.type !== "entries") return;

    if (this.subPage.context === "account") {
      this.renderAccountDetailPage();
    } else {
      this.renderGenericEntryList();
    }
  }

  // 通用条目列表（非账户页面）
  private renderGenericEntryList(): void {
    if (!this.subPage) return;
    const entries = this.subPage.entries;
    const query = new Query("list style none\nshow total", this.plugin.settings);

    const totalIncome = round2(entries
      .filter((e) => e.amount > 0)
      .reduce((sum, e) => sum + e.amount, 0));
    const totalExpense = round2(entries
      .filter((e) => e.amount < 0)
      .reduce((sum, e) => sum + e.amount, 0));

    const result: QueryResult = {
      groups: [{ key: this.subPage.title, entries }],
      summary: {
        totalIncome,
        totalExpense,
        balance: round2(totalIncome + totalExpense),
        count: entries.length,
      },
    };

    const listContainer = this.panelContentEl.createDiv();
    renderQueryResult(listContainer, result, query, this.plugin, this.hideAmounts);
  }

  // 账户明细页面：展示初始余额 + 收支/转账/调账分类汇总 + 当前余额 + 条目列表
  private renderAccountDetailPage(): void {
    if (!this.subPage) return;
    const accountName = this.subPage.accountName;
    if (!accountName) return;
    // 按时间从新到旧排序：日期降序，同日按时间降序
    const entries = [...this.subPage.entries].sort((a, b) => {
      const aDate = a.date ? a.date.valueOf() : 0;
      const bDate = b.date ? b.date.valueOf() : 0;
      if (aDate !== bDate) return bDate - aDate;
      return (b.time ?? "").localeCompare(a.time ?? "");
    });
    const initialBalance = this.subPage.initialBalance ?? 0;

    // 按账户金额类型分类汇总
    let incomeSum = 0;       // 普通收入（accountAmount > 0）
    let expenseSum = 0;      // 普通支出（accountAmount < 0）
    let transferIn = 0;      // 转入（转账中该账户为正）
    let transferOut = 0;     // 转出（转账中该账户为负）
    let balanceAdj = 0;      // 余额调整

    for (const entry of entries) {
      for (const aa of entry.accountAmounts) {
        if (aa.account !== accountName) continue;
        if (entry.isTransfer) {
          if (aa.amount > 0) transferIn += aa.amount;
          else transferOut += aa.amount;
        } else if (entry.isBalanceChange) {
          balanceAdj += aa.amount;
        } else {
          if (aa.amount > 0) incomeSum += aa.amount;
          else expenseSum += aa.amount;
        }
      }
    }

    const currentBalance = initialBalance + incomeSum + expenseSum + transferIn + transferOut + balanceAdj;

    // === 余额明细卡片 ===
    const card = this.panelContentEl.createDiv({ cls: "cashlog-account-detail-card" });
    card.createDiv({ cls: "cashlog-account-detail-title", text: tp("dashboard.accountDetail.title", { account: accountName }) });

    const rows: Array<{ label: string; value: number; cls?: string }> = [
      { label: t("dashboard.accountDetail.initialBalance"), value: initialBalance },
      { label: t("dashboard.accountDetail.incomeSubtotal"), value: incomeSum, cls: "cashlog-amount-income" },
      { label: t("dashboard.accountDetail.expenseSubtotal"), value: expenseSum, cls: "cashlog-amount-expense" },
      { label: t("dashboard.accountDetail.transferIn"), value: transferIn, cls: "cashlog-amount-income" },
      { label: t("dashboard.accountDetail.transferOut"), value: transferOut, cls: "cashlog-amount-expense" },
      { label: t("dashboard.accountDetail.balanceAdjust"), value: balanceAdj },
    ];

    for (const r of rows) {
      const row = card.createDiv({ cls: "cashlog-account-detail-row" });
      row.createSpan({ cls: "cashlog-account-detail-label", text: r.label });
      const valCls = r.cls || (r.value >= 0 ? "cashlog-amount-income" : "cashlog-amount-expense");
      const sign = r.value >= 0 ? "" : "-";
      row.createSpan({
        cls: `cashlog-account-detail-value ${valCls}`,
        text: `${sign}${this.hideAmounts ? "***" : formatMoney(Math.abs(r.value))}`,
      });
    }

    // 分隔线 + 当前余额
    card.createDiv({ cls: "cashlog-account-detail-divider" });
    const totalRow = card.createDiv({ cls: "cashlog-account-detail-row cashlog-account-detail-total" });
    totalRow.createSpan({ cls: "cashlog-account-detail-label", text: t("dashboard.accountDetail.currentBalance") });
    const totalCls = currentBalance >= 0 ? "cashlog-amount-income" : "cashlog-amount-expense";
    const totalSign = currentBalance >= 0 ? "" : "-";
    totalRow.createSpan({
      cls: `cashlog-account-detail-value ${totalCls}`,
      text: `${totalSign}${this.hideAmounts ? "***" : formatMoney(Math.abs(currentBalance))}`,
    });

    // === 条目列表（使用原有样式） ===
    const listQuery = new Query("list style none\nshow total", this.plugin.settings);
    const totalIncome = round2(entries
      .filter((e) => e.amount > 0)
      .reduce((sum, e) => sum + e.amount, 0));
    const totalExpense = round2(entries
      .filter((e) => e.amount < 0)
      .reduce((sum, e) => sum + e.amount, 0));

    const listResult: QueryResult = {
      groups: [{ key: t("dashboard.accountDetail.entries"), entries }],
      summary: {
        totalIncome,
        totalExpense,
        balance: round2(totalIncome + totalExpense),
        count: entries.length,
      },
    };

    const listContainer = this.panelContentEl.createDiv();
    renderQueryResult(listContainer, listResult, listQuery, this.plugin, this.hideAmounts);
  }

  // 渲染扇形图子页面
  private renderPieChartPage(): void {
    if (!this.subPage || this.subPage.type !== "pie") return;

    const entries = this.subPage.entries;
    const expenseTag = this.subPage.expenseTag || this.plugin.settings.expenseTag;

    // 按支出子标签分组统计
    const expenseEntries = entries.filter((e) => e.isExpense && !e.isTransfer);
    const categoryMap: Record<string, CashlogEntry[]> = {};

    for (const entry of expenseEntries) {
      const category = entry.getCategory(expenseTag) || t("dashboard.categoryFallback");
      if (!categoryMap[category]) categoryMap[category] = [];
      categoryMap[category].push(entry);
    }

    // 构建 QueryResult（用于 transformToChartData）
    const groups: EntryGroup[] = Object.entries(categoryMap)
      .map(([key, ents]) => ({ key, entries: ents }))
      .sort((a, b) => b.entries.length - a.entries.length);

    const result: QueryResult = {
      groups,
      summary: { totalIncome: 0, totalExpense: 0, balance: 0, count: expenseEntries.length },
    };

    // 饼图调色板（与图表共用定义，见 Query.ts 的 PANEL_PIE_COLORS）
    const defaultColors = PANEL_PIE_COLORS;

    const chartData: ChartDataResult = transformToChartData(
      result,
      "tag",
      "expense",
      defaultColors,
    );

    const chartConfig: ChartConfig = {
      type: "pie",
      title: "",
      groupBy: "tag",
      valueType: "expense",
      width: 300,
      height: 300,
      showLegend: true,
      showLabels: true,
      colors: defaultColors,
      splitBy: "none",
      splitItems: [],
    };

    // 创建子容器避免 createChartContainer 清空返回按钮和标题
    const chartContainer = this.panelContentEl.createDiv();
    this.pieChart = renderPieChart(chartContainer, chartData, chartConfig, this.hideAmounts);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
