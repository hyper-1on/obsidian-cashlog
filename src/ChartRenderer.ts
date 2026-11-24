/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { MarkdownRenderChild, TFile } from "obsidian";
import { t, tp } from "./i18n";
import { parseTagText, stripCommonPrefix } from "./TagTree";
import { round2 } from "./MoneyUtils";
import { Query, TableColConfig, parseTableConfig, createDefaultTableConfig, withGlobalQuery, formatWeekKey } from "./Query/Query";
import type { ChartConfig, GroupByField, SplitBy, PieValueType } from "./Query/Query";
import { QueryResult, EntryGroup } from "./Query/Filter";
import { CashlogEntry } from "./EntryLocation";
import { extractNoteName, renderAttachmentLink } from "./PathUtils";
import type CashlogPlugin from "./main";
import { getErrorMessage } from "./ErrorUtils";
import { Chart, registerables, type TooltipItem } from "chart.js";
import ChartDataLabels from "chartjs-plugin-datalabels";
import type { Context as DatalabelsContext } from "chartjs-plugin-datalabels/types/context";

Chart.register(...registerables, ChartDataLabels);

// 字段标签。惰性求值：本模块在 i18n 初始化之前就被加载，
// 顶层调用 t() 会把中文文案固化成模块常量，导致英文界面仍显示中文。
function fieldLabel(field: TableColConfig["field"]): string {
  return t(`chart.field.${field}`);
}

// 条目的业务类型标签
function entryTypeLabel(entry: CashlogEntry): string {
  if (entry.isTransfer) return t("cashlogModal.type.transfer");
  if (entry.isBalanceChange) return t("cashlogModal.type.balanceChange");
  if (entry.isIncome) return t("cashlogModal.type.income");
  return t("cashlogModal.type.expense");
}

// 渲染 cashlog-chart 代码块为动态 HTML 表格
// 根据「显示控制」指令过滤表格列。
// hide <field> 是减法语义，与 colN（决定候选列）不冲突：
// colN 列出要显示哪些列，hide 再从中移除对应字段。
// show account 可抵消 hide account（手册：「强制显示账户列」）。
function resolveVisibleColumns(
  config: ReturnType<typeof parseTableConfig>,
  query: Query,
): TableColConfig[] {
  return config.cols.slice(0, config.colCount).filter((col) => {
    switch (col.field) {
      case "date":
        return !query.shouldHideDate;
      case "amount":
        return !query.shouldHideAmount;
      case "account":
        return !(query.shouldHideAccount && !query.shouldShowAccount);
      default:
        return true;
    }
  });
}

export function renderChartTable(
  containerEl: HTMLElement,
  result: QueryResult,
  query: Query,
  tableConfig?: ReturnType<typeof parseTableConfig>,
  plugin?: CashlogPlugin,
): void {
  const config = tableConfig || createDefaultTableConfig();
  // 显示控制指令在这里生效（此前表格完全不读这些开关，导致 hide/show 静默失效）
  const visibleCols = resolveVisibleColumns(config, query);

  containerEl.empty();
  containerEl.addClass("cashlog-chart");

  // 外层容器用于统一表格对齐
  const wrapper = containerEl.createDiv({ cls: "cashlog-chart-table-wrapper" });

  if (!result.groups?.length) return;

  // 分组标题去掉 "#" 并省略公共前缀
  const tableDisplayKeys = stripCommonPrefix(result.groups.map((g) => g.key));

  for (const group of result.groups) {
    // 分组标题
    if (result.groups.length > 1) {
      wrapper.createEl("h4", { cls: "cashlog-chart-group", text: tableDisplayKeys.get(group.key) ?? group.key });
    }

    // 表格
    const table = wrapper.createEl("table", { cls: "cashlog-chart-table" });

    // 表头
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    for (const col of visibleCols) {
      const th = headerRow.createEl("th");
      th.textContent = col.header || fieldLabel(col.field);
      th.style.textAlign = col.align;
    }

    // 表体
    const tbody = table.createEl("tbody");
    for (const entry of group.entries) {
      renderEntryRow(tbody, entry, query, group.key, plugin, visibleCols);
    }

    // 分组小计（colspan 跟随可见列数）
    if (result.groups.length > 1 && query.shouldShowGroupSubtotal) {
      renderGroupSubtotalRow(tbody, group, visibleCols.length);
    }
  }

  // 总汇总
  if (query.shouldShowChartSummary) {
    renderTotalSummary(containerEl, result);
  }
}

// 渲染单行条目
function renderEntryRow(
  tbody: HTMLElement,
  entry: CashlogEntry,
  query: Query,
  groupKey: string,
  plugin: CashlogPlugin | undefined,
  cols: TableColConfig[],
): void {
  const tr = tbody.createEl("tr");

  for (const col of cols) {
    switch (col.field) {
      case "date": {
        let timeText = "";
        if (entry.date) {
          timeText = entry.date.format("YYYY-MM-DD");
          // hide time：日期列只保留日期部分
          if (entry.time && !query.shouldHideTime) {
            timeText += " " + entry.time;
          }
        }
        const td = tr.createEl("td", { text: timeText || "-" });
        td.style.textAlign = col.align;
        break;
      }
      case "amount": {
        const td = tr.createEl("td");
        td.style.textAlign = col.align;
        const displayAmount = getEntryDisplayAmount(entry, groupKey);
        // 转账/余额变更在非账户分组下总额为0，显示 / 表示无意义
        if ((entry.isTransfer || entry.isBalanceChange) && displayAmount === 0) {
          td.setText("/");
        } else {
          td.createSpan({
            cls: displayAmount < 0 ? "cashlog-amount-expense" : "cashlog-amount-income",
            text: `${displayAmount}`,
          });
        }
        break;
      }
      case "description": {
        const td = tr.createEl("td", { cls: "cashlog-chart-desc" });
        td.style.textAlign = col.align;
        // hide tag：即使开启了 show tag in description 也不渲染标签
        if (!query.shouldHideTag && query.shouldShowTagInDescription && entry.tags.length > 0) {
          for (const tag of entry.tags) {
            // 值（href）保持带 #，只把显示文字换成纯词条
            td.createEl("a", {
              cls: "tag",
              attr: { href: tag },
              text: parseTagText(tag),
            });
            td.appendText(" ");
          }
        }
        if (entry.description) {
          td.appendText(entry.description);
        }
        if (!td.textContent) {
          td.setText("-");
        }
        break;
      }
      case "account": {
        const td = tr.createEl("td");
        td.style.textAlign = col.align;
        if (entry.accountAmounts.length > 0) {
          for (const aa of entry.accountAmounts) {
            const amountCls = aa.amount < 0 ? "cashlog-amount-expense" : "cashlog-amount-income";
            const div = td.createDiv();
            div.createSpan({ text: `💳${aa.account}💴` });
            div.createSpan({ cls: amountCls, text: `${aa.amount}` });
          }
        } else {
          td.setText("-");
        }
        break;
      }
      case "attachment": {
        const td = tr.createEl("td");
        td.style.textAlign = col.align;
        if (entry.attachments.length > 0 && plugin) {
          const folder = plugin.settings.attachmentFolder;
          for (let i = 0; i < entry.attachments.length; i++) {
            renderAttachmentLink(td, entry.attachments[i], folder, (fullPath) => {
              const file = plugin.app.vault.getAbstractFileByPath(fullPath);
              if (file && file instanceof TFile) {
                void plugin.app.workspace.getLeaf().openFile(file);
              }
            });
            if (i < entry.attachments.length - 1) {
              td.appendText(" ");
            }
          }
        } else {
          td.setText("-");
        }
        break;
      }
      case "type": {
        const td = tr.createEl("td");
        td.style.textAlign = col.align;
        td.setText(entryTypeLabel(entry));
        break;
      }
      case "link": {
        const td = tr.createEl("td", { cls: "cashlog-chart-link" });
        td.style.textAlign = col.align;
        if (entry.location) {
          const noteName = extractNoteName(entry.location.path);
          const linkEl = td.createEl("a", {
            cls: "internal-link",
            text: noteName,
            attr: {
              "data-href": entry.location.path,
              href: entry.location.path,
            },
          });
          const locPath = entry.location.path;
          linkEl.addEventListener("click", (e) => {
            e.preventDefault();
            const file = plugin?.app.vault.getAbstractFileByPath(locPath);
            if (file && file instanceof TFile) {
              void plugin?.app.workspace.getLeaf().openFile(file);
            }
          });
        } else {
          td.setText("-");
        }
        break;
      }
      case "tag": {
        const td = tr.createEl("td", { cls: "cashlog-chart-tags" });
        td.style.textAlign = col.align;
        if (entry.tags.length > 0) {
          for (const tag of entry.tags) {
            // 值（href）保持带 #，只把显示文字换成纯词条
            td.createEl("a", { cls: "tag", attr: { href: tag }, text: parseTagText(tag) });
            td.appendText(" ");
          }
        } else {
          td.setText("-");
        }
        break;
      }
      case "time": {
        const td = tr.createEl("td", { text: entry.time || "-" });
        td.style.textAlign = col.align;
        break;
      }
    }
  }
}

// 渲染分组小计行
function renderGroupSubtotalRow(tbody: HTMLElement, group: EntryGroup, colCount: number): void {
  const groupKey = group.key;
  const totalIncome = group.entries
    .filter((e) => getEntryDisplayAmount(e, groupKey) > 0)
    .reduce((sum, e) => sum + getEntryDisplayAmount(e, groupKey), 0);
  const totalExpense = group.entries
    .filter((e) => getEntryDisplayAmount(e, groupKey) < 0)
    .reduce((sum, e) => sum + getEntryDisplayAmount(e, groupKey), 0);

  const tr = tbody.createEl("tr", { cls: "cashlog-chart-summary-row" });

  // 小计标签列（跨过第一列）
  tr.createEl("td", { text: t("renderer.subtotal") });

  // 收入/支出金额列
  const amountTd = tr.createEl("td", { attr: { colspan: String(colCount - 1) } });
  const roundedIncome = round2(totalIncome);
  const roundedExpense = round2(totalExpense);
  if (roundedIncome !== 0) {
    amountTd.createSpan({ cls: "cashlog-amount-income", text: `+${roundedIncome}` });
  }
  if (roundedExpense !== 0) {
    if (roundedIncome !== 0) amountTd.createSpan({ text: " / " });
    amountTd.createSpan({ cls: "cashlog-amount-expense", text: `${roundedExpense}` });
  }
}

// 渲染总汇总（从所有分组条目中独立计算）
function renderTotalSummary(containerEl: HTMLElement, result: QueryResult): void {
  // 去重：多账户条目会在多个分组中出现，总汇总只计一次
  const seen = new Set<CashlogEntry>();
  const allEntries: CashlogEntry[] = [];
  for (const g of result.groups) {
    for (const e of g.entries) {
      if (!seen.has(e)) {
        seen.add(e);
        allEntries.push(e);
      }
    }
  }
  const totalIncome = allEntries
    .filter((e) => e.amount > 0 && !e.isTransfer && !e.isBalanceChange)
    .reduce((sum, e) => sum + e.amount, 0);
  const totalExpense = allEntries
    .filter((e) => e.amount < 0 && !e.isTransfer && !e.isBalanceChange)
    .reduce((sum, e) => sum + e.amount, 0);
  const balance = totalIncome + totalExpense;

  const div = containerEl.createDiv({ cls: "cashlog-chart-total-summary" });

  const roundedIncome = round2(totalIncome);
  const roundedExpense = round2(totalExpense);
  const roundedBalance = round2(balance);

  div.createDiv({
    cls: "cashlog-summary-income",
    text: tp("renderer.totalIncomeChart", { amount: roundedIncome.toLocaleString() }),
  });
  div.createDiv({
    cls: "cashlog-summary-expense",
    text: tp("renderer.totalExpenseChart", { amount: roundedExpense.toLocaleString() }),
  });
  div.createDiv({
    cls: "cashlog-summary-balance",
    text: tp("renderer.netBalanceChart", { amount: roundedBalance.toLocaleString() }),
  });
}

// 图表数据接口
export interface ChartDataResult {
  labels: string[];
  datasets: {
    label: string;
    data: number[];
    backgroundColor: string[];
    borderColor?: string;
    fill?: boolean;
  }[];
}

// 将查询结果转换为图表数据
// 单维度数据转换（扇形图用）
export function transformToChartData(
  result: QueryResult,
  groupBy: GroupByField,
  valueType: PieValueType,
  colors: string[],
): ChartDataResult {
  if (!result.groups?.length) {
    return { labels: [], datasets: [] };
  }

  const isTagOrType = groupBy === "tag" || groupBy === "type";
  const isAccount = groupBy === "account";

  // 收集 (标签, 显示值, 原始值) 三元组
  const slices: { label: string; display: number; raw: number }[] = [];
  // 图表标签去掉 "#" 并省略公共前缀
  const displayKeys = stripCommonPrefix(result.groups.map((g) => g.key));

  for (const group of result.groups) {
    let raw = 0;

    if (isTagOrType) {
      // 按标签/类型：仅统计收支（排除转账和余额变更），显示绝对值
      raw = group.entries
        .filter((e) => !e.isTransfer && !e.isBalanceChange)
        .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
      const display = round2(Math.abs(raw));
      // 排除转账/余额变更分组（过滤后值为 0 的切片不显示）
      if (display !== 0) {
        slices.push({
          label: formatGroupLabel(group.key, groupBy),
          display,
          raw: round2(raw),
        });
      }
    } else if (isAccount) {
      // 按账户
      switch (valueType) {
        case "income":
          raw = group.entries
            .filter((e) => e.isIncome && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          break;
        case "expense":
          raw = group.entries
            .filter((e) => e.isExpense && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          break;
        case "balance": {
          const inc = group.entries
            .filter((e) => e.isIncome && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          const exp = group.entries
            .filter((e) => e.isExpense && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          raw = inc + exp;
          break;
        }
        case "inflow":
          raw = group.entries
            .reduce((sum, e) => {
              const amt = pickEntryAmountValue(e, groupBy, group.key);
              return amt > 0 ? sum + amt : sum;
            }, 0);
          break;
        case "outflow":
          raw = group.entries
            .reduce((sum, e) => {
              const amt = pickEntryAmountValue(e, groupBy, group.key);
              return amt < 0 ? sum + amt : sum;
            }, 0);
          break;
        case "netflow":
          raw = group.entries
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          break;
      }
      slices.push({
        label: formatGroupLabel(group.key, groupBy),
        display: round2(Math.abs(raw)),
        raw: round2(raw),
      });
    } else {
      // 按日期/周/月/年：仅统计收支（排除转账和余额变更）
      switch (valueType) {
        case "income":
          raw = group.entries
            .filter((e) => e.isIncome && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          break;
        case "expense":
          raw = group.entries
            .filter((e) => e.isExpense && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          break;
        case "balance": {
          const inc = group.entries
            .filter((e) => e.isIncome && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          const exp = group.entries
            .filter((e) => e.isExpense && !e.isTransfer && !e.isBalanceChange)
            .reduce((sum, e) => sum + pickEntryAmountValue(e, groupBy, group.key), 0);
          raw = inc + exp;
          break;
        }
        default:
          raw = 0;
      }
      slices.push({
        label: formatGroupLabel(group.key, groupBy),
        display: round2(Math.abs(raw)),
        raw: round2(raw),
      });
    }
  }

  const labels = slices.map((s) => s.label);
  const data = slices.map((s) => s.display);
  const rawValues = slices.map((s) => s.raw);

  const bgColors = data.map((_, i) => colors[i % colors.length]);

  const labelMap: Record<string, string> = {
    income: t("chart.label.income"), expense: t("chart.label.expense"), balance: t("chart.label.balance"),
    inflow: t("chart.label.inflow"), outflow: t("chart.label.outflow"), netflow: t("chart.label.netflow"),
  };
  const label = labelMap[valueType] || "";

  const dataset: ChartDataResult["datasets"][number] & { _rawValues: number[] } = {
    label,
    data,
    backgroundColor: bgColors,
    borderColor: colors[0],
    fill: false,
    _rawValues: rawValues,
  };

  return { labels, datasets: [dataset] };
}

// 扇形图用的简易金额取值（按账户分组时取对应账户金额，否则用总额）
function pickEntryAmountValue(entry: CashlogEntry, groupBy: GroupByField, groupKey: string): number {
  if (groupBy === "account" && entry.accountAmounts.length > 0) {
    const aa = entry.accountAmounts.find((a) => a.account === groupKey);
    if (aa) return aa.amount;
  }
  return entry.amount;
}

// 双维度数据转换（条形图/折线图通用）
function transformSplitChartData(
  result: QueryResult,
  xGroupBy: GroupByField,
  splitBy: SplitBy,
  splitItems: string[],
  colors: string[],
  chartType: "bar" | "line",
): ChartDataResult {
  const labels: string[] = [];

  if (!result.groups?.length) {
    return { labels, datasets: [] };
  }

  // 从 result.groups 获取已按 xGroupBy 分组的条目（Query 已处理好分组）
  // 收集所有 X 组及其条目
  const xGroups: { key: string; entries: CashlogEntry[] }[] = result.groups.map((g) => ({
    key: g.key,
    entries: g.entries,
  }));

  // 日期/周/月份/年份分组时，确保按时间先后排序（渲染层保障）
  if (xGroupBy === "date" || xGroupBy === "week" || xGroupBy === "month" || xGroupBy === "year") {
    xGroups.sort((a, b) => {
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return 0;
    });
  }

  // 格式化 X 轴标签
  for (const g of xGroups) {
    labels.push(formatGroupLabel(g.key, xGroupBy));
  }

  // 确定子分组项
  let splitItemsList: string[] = [];
  switch (splitBy) {
    case "none":
      splitItemsList = ["balance"];
      break;
    case "valueType":
      splitItemsList = ["balance", "income", "expense"];
      break;
    case "type":
      splitItemsList = ["income", "expense"];
      break;
    case "tag":
    case "account":
      splitItemsList = splitItems;
      break;
    case "date":
      splitItemsList = collectDistinctDates(xGroups);
      break;
    case "week":
      splitItemsList = collectDistinctWeeks(xGroups);
      break;
    case "month":
      splitItemsList = collectDistinctMonths(xGroups);
      break;
    case "year":
      splitItemsList = collectDistinctYears(xGroups);
      break;
  }

  if (splitItemsList.length === 0) {
    return { labels, datasets: [] };
  }

  // 为每个子分组项构建数据集
  const datasets: ChartDataResult["datasets"] = splitItemsList.map((item, idx) => {
    const data: number[] = [];
    const rawData: number[] = [];
    for (const xg of xGroups) {
      const rawValue = computeBarValue(xg.entries, splitBy, item, xg.key, xGroupBy);
      rawData.push(round2(rawValue));
      // 条形图用绝对值，折线图保留原始符号
      const displayValue = chartType === "bar" ? Math.abs(rawValue) : rawValue;
      data.push(round2(displayValue));
    }
    const ds: ChartDataResult["datasets"][number] & { _rawData: number[] } = {
      label: formatSplitItemLabel(item, splitBy),
      data,
      backgroundColor: [colors[idx % colors.length]],
      _rawData: rawData,
    };
    return ds;
  });

  return { labels, datasets };
}

// 格式化分组标签
function formatGroupLabel(key: string, groupBy: GroupByField): string {
  switch (groupBy) {
    case "tag":
      // 去 "#" 后原样返回；公共前缀的省略由调用方的 stripCommonPrefix 统一处理。
      // 此前只取最后一段，"#支出/餐饮/午餐" 会退化成 "午餐"，丢失所属分类。
      return key.replace(/^#/, "");
    case "week":
      return key;
    case "month": {
      const parts = key.split("-");
      if (parts.length >= 2) return `${parts[0]}年${parseInt(parts[1])}月`;
      return key;
    }
    case "year":
      return `${key}年`;
    case "date":
      return key;
    default:
      return key;
  }
}

// 格式化子分组项标签
function formatSplitItemLabel(item: string, splitBy: SplitBy): string {
  switch (splitBy) {
    case "none":
    case "valueType":
      return item === "balance" ? t("chart.label.balance") : item === "income" ? t("chart.label.income") : t("chart.label.expense");
    case "type":
      return item === "income" ? t("chart.label.income") : t("chart.label.expense");
    case "week":
      return item;
    default:
      return item;
  }
}

// 从 accountAmounts 中获取当前分组的金额（可为负）
function getGroupAccountAmount(entry: CashlogEntry, groupKey: string): number {
  const aa = entry.accountAmounts.find((a) => a.account === groupKey);
  return aa?.amount ?? 0;
}

// 获取条目在表格中的显示金额：groupKey 匹配某个账户时才取专属金额，否则用总额
function getEntryDisplayAmount(entry: CashlogEntry, groupKey: string): number {
  if (entry.accountAmounts.length > 0) {
    const aa = entry.accountAmounts.find((a) => a.account === groupKey);
    if (aa) return aa.amount;
  }
  return entry.amount;
}

// 选择计算时使用的金额：子分组按账户时取对应账户金额，X轴按账户时取分组对应金额，否则用总额
function pickEntryAmount(entry: CashlogEntry, splitBy: SplitBy, xGroupBy: GroupByField, item: string, groupKey: string): number {
  if (splitBy === "account") {
    const aa = entry.accountAmounts.find((a) => a.account === item);
    return aa?.amount ?? 0;
  }
  if (xGroupBy === "account" && entry.accountAmounts.length > 0) {
    return getGroupAccountAmount(entry, groupKey);
  }
  return entry.amount;
}

// 计算单个子分组项在某个 X 组内的原始值（带符号）
function computeBarValue(entries: CashlogEntry[], splitBy: SplitBy, item: string, groupKey: string, xGroupBy: GroupByField): number {
  switch (splitBy) {
    case "none":
      // 与 valueType 分支保持一致：按账户分组时必须取该账户的金额，
      // 否则每根柱都会显示整条金额（多账户条目会被重复计入）。
      return entries
        .filter((e) => !e.isTransfer && !e.isBalanceChange)
        .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
    case "valueType": {
      switch (item) {
        case "income":
          return entries.filter((e) => e.isIncome && !e.isTransfer && !e.isBalanceChange)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
        case "expense":
          return entries.filter((e) => e.isExpense && !e.isTransfer && !e.isBalanceChange)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
        case "balance": {
          const inc = entries.filter((e) => e.isIncome && !e.isTransfer && !e.isBalanceChange)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
          const exp = entries.filter((e) => e.isExpense && !e.isTransfer && !e.isBalanceChange)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
          return inc + exp;
        }
        default: return 0;
      }
    }
    case "type": {
      switch (item) {
        case "income":
          return entries.filter((e) => e.isIncome && !e.isTransfer && !e.isBalanceChange)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
        case "expense":
          return entries.filter((e) => e.isExpense && !e.isTransfer && !e.isBalanceChange)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
        case "transfer":
          return entries.filter((e) => e.isTransfer)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
        case "balanceChange":
          return entries.filter((e) => e.isBalanceChange)
            .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
        default: return 0;
      }
    }
    case "tag": {
      // 拆分项可能来自图表弹窗（带 #）或手写查询（通常不带），
      // 两边归一化后再比，否则手写的 "chart bar items 支出/餐饮" 会聚合为 0。
      const want = parseTagText(item);
      return entries
        .filter((e) =>
          e.tags.some((t) => {
            const tag = parseTagText(t);
            return tag === want || tag.startsWith(want + "/");
          }),
        )
        .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
    }
    case "account":
      return entries.filter((e) => e.accountAmounts.some((aa) => aa.account === item))
        .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
    case "date": {
      return entries.filter((e) => e.date && e.date.format("YYYY-MM-DD") === item)
        .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
    }
    case "week": {
      return entries.filter((e) => e.date && formatWeekKey(e.date) === item)
        .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
    }
    case "month": {
      return entries.filter((e) => e.date && e.date.format("YYYY-MM") === item)
        .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
    }
    case "year": {
      return entries.filter((e) => e.date && e.date.format("YYYY") === item)
        .reduce((s, e) => s + pickEntryAmount(e, splitBy, xGroupBy, item, groupKey), 0);
    }
    default: return 0;
  }
}

// 从数据中收集所有不同日期
function collectDistinctDates(xGroups: { key: string; entries: CashlogEntry[] }[]): string[] {
  const dateSet = new Set<string>();
  for (const xg of xGroups) {
    for (const e of xg.entries) {
      if (e.date) dateSet.add(e.date.format("YYYY-MM-DD"));
    }
  }
  return Array.from(dateSet).sort();
}

// 从数据中收集所有不同月份
function collectDistinctMonths(xGroups: { key: string; entries: CashlogEntry[] }[]): string[] {
  const monthSet = new Set<string>();
  for (const xg of xGroups) {
    for (const e of xg.entries) {
      if (e.date) monthSet.add(e.date.format("YYYY-MM"));
    }
  }
  return Array.from(monthSet).sort();
}

// 从数据中收集所有不同周
function collectDistinctWeeks(xGroups: { key: string; entries: CashlogEntry[] }[]): string[] {
  const weekSet = new Set<string>();
  for (const xg of xGroups) {
    for (const e of xg.entries) {
      if (e.date) weekSet.add(formatWeekKey(e.date));
    }
  }
  return Array.from(weekSet).sort();
}

// 从数据中收集所有不同年份
function collectDistinctYears(xGroups: { key: string; entries: CashlogEntry[] }[]): string[] {
  const yearSet = new Set<string>();
  for (const xg of xGroups) {
    for (const e of xg.entries) {
      if (e.date) yearSet.add(e.date.format("YYYY"));
    }
  }
  return Array.from(yearSet).sort();
}

// 创建图表容器（公共逻辑）
export function createChartContainer(containerEl: HTMLElement, config: ChartConfig) {
  containerEl.empty();
  containerEl.addClass("cashlog-chart");

  const wrapper = containerEl.createDiv({ cls: "cashlog-chart-container" });

  if (config.title) {
    wrapper.createDiv({ cls: "cashlog-chart-title", text: config.title });
  }

  const canvas = wrapper.createEl("canvas", {
    cls: "cashlog-chart-canvas",
  });

  // 设置容器固定尺寸，配合 maintainAspectRatio: false 使图表精确匹配
  wrapper.style.width = `${config.width}px`;
  wrapper.style.height = `${config.height}px`;

  return { wrapper, canvas };
}

// 缓存主题文字颜色，避免反复创建 DOM 探针
let _cachedLabelColor: string | null = null;

function getLabelColor(): string {
  if (_cachedLabelColor) return _cachedLabelColor;
  const probe = activeDocument.createElement("span");
  probe.className = "cashlog-chart-probe";
  probe.textContent = ".";
  activeDocument.body.appendChild(probe);
  _cachedLabelColor = getComputedStyle(probe).color || "#333333";
  activeDocument.body.removeChild(probe);
  return _cachedLabelColor;
}

// 主题切换时清除缓存，由外部在恰当时机调用
export function clearLabelColorCache(): void {
  _cachedLabelColor = null;
}

// Chart.js 回调中用到的扩展数据集类型（包含自定义 _rawData/_rawValues）
type ChartDatasetExtended = { _rawData?: number[]; _rawValues?: number[]; data: number[]; label: string };

// 构建 datalabels 插件配置（条形图/折线图通用）
function buildDatalabelsConfig(config: ChartConfig) {
  if (!config.showLabels) return {};
  return {
    datalabels: {
      anchor: "end" as const,
      align: "end" as const,
      offset: 6,
      formatter: (value: number, context: DatalabelsContext) => {
        const ds = context.dataset as ChartDatasetExtended;
        const raw = ds._rawData?.[context.dataIndex];
        if (raw !== undefined) return raw.toLocaleString();
        return value.toLocaleString();
      },
      font: { weight: "bold" as const, size: 11 },
      color: getLabelColor(),
    },
  };
}

// 渲染条形图
function renderBarChart(
  containerEl: HTMLElement,
  chartData: ChartDataResult,
  config: ChartConfig,
): Chart {
  const { canvas } = createChartContainer(containerEl, config);

  const datasets = chartData.datasets.map((ds, i) => ({
    label: ds.label,
    data: ds.data,
    backgroundColor: ds.backgroundColor[0] || config.colors[i % config.colors.length],
    borderWidth: 1,
    _rawData: (ds as ChartDatasetExtended)._rawData,
  }));

  return new Chart(canvas, {
    type: "bar",
    data: {
      labels: chartData.labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { top: 50 },
      },
      plugins: {
        legend: {
          display: config.showLegend,
          position: "top",
          labels: { padding: 16 },
        },
        tooltip: {
          callbacks: {
            label: (context: TooltipItem<"bar">) => {
              const ds = context.dataset as ChartDatasetExtended;
              const raw = ds._rawData?.[context.dataIndex];
              const displayVal = raw !== undefined ? raw : (context.parsed.y ?? 0);
              return `${context.dataset.label}: ${displayVal.toLocaleString()}`;
            },
          },
        },
        ...buildDatalabelsConfig(config),
      },
      scales: { y: { beginAtZero: true, grace: "25%" } },
    },
  });
}

// 渲染折线图（支持多数据集）
function renderLineChart(
  containerEl: HTMLElement,
  chartData: ChartDataResult,
  config: ChartConfig,
): Chart {
  const { canvas } = createChartContainer(containerEl, config);

  const datasets = chartData.datasets.map((ds, i) => {
    const color = config.colors[i % config.colors.length];
    return {
      label: ds.label,
      data: ds.data,
      borderColor: color,
      backgroundColor: color + "1a",
      fill: false,
      tension: 0.3,
      pointBackgroundColor: color,
      _rawData: (ds as ChartDatasetExtended)._rawData,
    };
  });

  return new Chart(canvas, {
    type: "line",
    data: {
      labels: chartData.labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { top: 50 },
      },
      plugins: {
        legend: {
          display: config.showLegend,
          position: "top",
          labels: { padding: 16 },
        },
        tooltip: {
          callbacks: {
            label: (context: TooltipItem<"line">) => {
              const ds = context.dataset as ChartDatasetExtended;
              const raw = ds._rawData?.[context.dataIndex];
              const displayVal = raw !== undefined ? raw : (context.parsed.y ?? 0);
              return `${context.dataset.label}: ${displayVal.toLocaleString()}`;
            },
          },
        },
        ...buildDatalabelsConfig(config),
      },
      scales: { y: { grace: "25%" } },
    },
  });
}

// 把一组数值换算成整数百分比，并用「最大余数法」保证总和恰为 100%。
// 逐项各自四舍五入会让各切片之和漂移到 99% / 102% 之类，看起来像数据算错了。
export function computeIntegerPercentages(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 0);

  const exact = values.map((v) => (v / total) * 100);
  const result = exact.map((v) => Math.floor(v));
  let remainder = 100 - result.reduce((sum, v) => sum + v, 0);

  // 余下的百分点按小数部分从大到小依次分配
  const order = exact
    .map((v, index) => ({ index, fraction: v - Math.floor(v) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let i = 0; i < order.length && remainder > 0; i++) {
    result[order[i].index] += 1;
    remainder -= 1;
  }

  return result;
}

// 构建扇形图专用的 datalabels 插件配置
export function buildPieDatalabelsConfig(config: ChartConfig) {
  if (!config.showLabels) return {};
  return {
    datalabels: {
      anchor: "center" as const,
      formatter: (_value: number, context: DatalabelsContext) => {
        const ds = context.dataset as ChartDatasetExtended;
        const percentages = computeIntegerPercentages(ds.data);
        const percentage = percentages[context.dataIndex];
        return percentage === undefined ? "" : `${percentage}%`;
      },
      font: { weight: "bold" as const, size: 12 },
      color: "#fff",
    },
  };
}

// 渲染扇形图
export function renderPieChart(
  containerEl: HTMLElement,
  chartData: ChartDataResult,
  config: ChartConfig,
  // 面板的隐私开关：打开时 tooltip 里的金额打码（扇区比例仍然可见）
  hideAmounts: boolean = false,
): Chart | null {
  // 空数据保护：面板的饼图页直接调用本函数且没有 try/catch，
  // 之前无条件读 datasets[0] 会抛错并中断整个面板渲染。
  const dataset = chartData.datasets[0];
  if (!dataset || dataset.data.length === 0) {
    containerEl.createDiv({ cls: "cashlog-empty", text: t("error.noData") });
    return null;
  }

  const { canvas } = createChartContainer(containerEl, config);

  return new Chart(canvas, {
    type: "pie",
    data: {
      labels: chartData.labels,
      datasets: [{
        label: dataset.label,
        data: dataset.data,
        backgroundColor: dataset.backgroundColor,
        borderColor: "var(--background-primary, #ffffff)",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: config.showLegend },
        tooltip: {
          callbacks: {
            label: (context: TooltipItem<"pie">) => {
              const ds = context.dataset as ChartDatasetExtended;
              const rawValues = ds._rawValues;
              const raw = rawValues?.[context.dataIndex];
              const displayVal = raw !== undefined ? raw : context.parsed;
              const total = ds.data.reduce((a: number, b: number) => a + b, 0);
              const percentage = total > 0 ? ((context.dataset.data[context.dataIndex] / total) * 100).toFixed(1) : "0.0";
              const shownValue = hideAmounts ? "***" : displayVal.toLocaleString();
              return `${context.label}: ${shownValue} (${percentage}%)`;
            },
          },
        },
        ...buildPieDatalabelsConfig(config),
      },
    },
  });
}

// 代码块渲染子组件，支持自动刷新
export class CashlogChartRenderChild extends MarkdownRenderChild {
  private source: string;
  private plugin: CashlogPlugin;
  private chartInstance: { destroy(): void } | null = null;

  constructor(containerEl: HTMLElement, source: string, plugin: CashlogPlugin) {
    super(containerEl);
    this.source = source;
    this.plugin = plugin;
  }

  onload() {
    // 同样等索引就绪再首次渲染（与 CashlogRenderChild 一致，修复首屏竞态）
    void this.plugin.cache.whenReady().then(() => this.render());
    this.registerEvent(
      this.plugin.events.on("cashlog-render-refresh", () => {
        this.render();
      }),
    );
  }

  onunload() {
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
  }

  private render() {
    try {
      // 渲染前销毁旧图表实例
      if (this.chartInstance) {
        this.chartInstance.destroy();
        this.chartInstance = null;
      }

      const query = new Query(
        withGlobalQuery(this.source, this.plugin.settings.globalQuery),
        this.plugin.settings,
      );
      const error = query.getError();

      if (error) {
        this.containerEl.empty();
        this.containerEl.createDiv({
          cls: "cashlog-error",
          text: tp("error.queryError", { error }),
        });
        return;
      }

      const entries = this.plugin.cache.getEntries();
      if (!entries?.length) {
        this.containerEl.empty();
        this.containerEl.createDiv({
          cls: "cashlog-error",
          text: t("error.noData"),
        });
        return;
      }

      const result = query.apply(entries);
      const tableConfig = parseTableConfig(this.source);
      const chartConfig = query.getChartConfig();

      if (chartConfig.type === "table") {
        renderChartTable(this.containerEl, result, query, tableConfig, this.plugin);
      } else if (chartConfig.type === "bar") {
        // 条形图：双维度分组
        const chartData = transformSplitChartData(
          result,
          chartConfig.groupBy,
          chartConfig.splitBy || "valueType",
          chartConfig.splitItems || [],
          chartConfig.colors,
          "bar",
        );
        this.chartInstance = renderBarChart(this.containerEl, chartData, chartConfig);
      } else if (chartConfig.type === "line") {
        // 折线图：双维度分组
        const chartData = transformSplitChartData(
          result,
          chartConfig.groupBy,
          chartConfig.splitBy || "valueType",
          chartConfig.splitItems || [],
          chartConfig.colors,
          "line",
        );
        this.chartInstance = renderLineChart(this.containerEl, chartData, chartConfig);
      } else if (chartConfig.type === "pie") {
        // 扇形图
        const chartData = transformToChartData(
          result,
          chartConfig.groupBy,
          chartConfig.valueType,
          chartConfig.colors,
        );
        this.chartInstance = renderPieChart(this.containerEl, chartData, chartConfig);
      } else {
        this.containerEl.empty();
        this.containerEl.createDiv({
          cls: "cashlog-error",
          text: tp("error.unsupportedChartType", { type: chartConfig.type }),
        });
      }
    } catch (err) {
      this.containerEl.empty();
      this.containerEl.createDiv({
        cls: "cashlog-error",
        text: tp("error.chartRenderFailed", { message: getErrorMessage(err) }),
      });
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
