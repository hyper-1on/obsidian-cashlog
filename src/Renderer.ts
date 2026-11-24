/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { Keymap, Notice, TFile } from "obsidian";
import { CashlogEntry } from "./EntryLocation";
import { QueryResult, Summary } from "./Query/Filter";
import { Query } from "./Query/Query";
import { CashlogModal, EditableEntryData } from "./CashlogModal";
import { buildEntryFromModalData } from "./EntryEditor";
import { extractNoteName, renderAttachmentLink } from "./PathUtils";
import { resolveEntryLine } from "./EntryLocator";
import { stripCommonPrefix } from "./TagTree";
import { t, tp } from "./i18n";
import { round2 } from "./MoneyUtils";
import { getErrorMessage } from "./ErrorUtils";
import type CashlogPlugin from "./main";

// 渲染查询结果到 HTML
export function renderQueryResult(
  containerEl: HTMLElement,
  result: QueryResult,
  query: Query,
  plugin: CashlogPlugin,
  // 面板明细页会传 true，让面板的隐私开关也覆盖到条目列表
  hideAmounts: boolean = false,
): void {
  containerEl.empty();
  containerEl.addClass("cashlog-results");

  // 分组标题去掉 "#" 并省略公共前缀（全是支出时 "支出/餐饮" → "餐饮"）
  const displayKeys = stripCommonPrefix(result.groups.map((g) => g.key));
  for (const group of result.groups) {
    // 分组标题
    if (result.groups.length > 1) {
      const groupHeader = containerEl.createDiv({
        cls: "cashlog-group-header",
      });
      groupHeader.createEl("strong", { text: displayKeys.get(group.key) ?? group.key });
    }

    // 条目列表
    const listStyle = query.listStyle;
    const listTag = listStyle === "ordered" ? "ol" : listStyle === "none" ? "div" : "ul";
    const list = containerEl.createEl(listTag);
    // none 样式沿用原 cashlog-list（无标记），ul/ol 用浏览器默认列表样式
    if (listStyle === "none") {
      list.addClass("cashlog-list");
    }

    for (const entry of group.entries) {
      renderEntry(list, entry, query, plugin, listStyle, hideAmounts);
    }

    // 分组汇总
    if (result.groups.length > 1) {
      const groupSummary = calculateGroupSummary(group.entries);
      renderGroupSummary(containerEl, groupSummary, hideAmounts);
    }
  }

  // 总汇总
  if (
    query.shouldShowTotal ||
    query.shouldShowTotalIncome ||
    query.shouldShowTotalExpense ||
    query.shouldShowBalance ||
    query.shouldShowCount
  ) {
    renderSummary(containerEl, result.summary, query, hideAmounts);
  }
}

// 渲染单个条目
function renderEntry(
  list: HTMLElement,
  entry: CashlogEntry,
  query: Query,
  plugin: CashlogPlugin,
  listStyle: "unordered" | "ordered" | "none" = "unordered",
  hideAmounts: boolean = false,
): void {
  const tag = listStyle === "none" ? "div" : "li";
  const li = list.createEl(tag, { cls: "cashlog-entry" });
  // hide account 隐藏账户名、hide amount 隐藏金额、show account 覆盖 hide account。
  // 两个指令都是「省略被隐藏的那部分、不留占位符」；返回空串表示该账户项已无内容可显示。
  const hideAccountName = query.shouldHideAccount && !query.shouldShowAccount;
  const hideAmountPart = query.shouldHideAmount;
  // 面板隐私开关是独立控件：它把金额打码为 ***，而不是省略
  const amountText = (value: number): string => (hideAmounts ? "***" : String(value));
  const accountText = (account: string, amount: number): string => {
    const accountPart = hideAccountName ? "" : `💳${account}`;
    const amountPart = hideAmountPart ? "" : `💴${amountText(amount)}`;
    return `${accountPart}${amountPart}`;
  };

  // 标签
  if (!query.shouldHideTag && entry.tags.length > 0) {
    const tagSpan = li.createSpan({
      cls: "cashlog-tag",
      text: entry.tags.join(" "),
    });
    tagSpan.insertAdjacentText("beforebegin", " ");
  }

  // 描述
  if (entry.description) {
    li.createSpan({
      cls: "cashlog-description",
      text: entry.description,
    });
  }

  // 转账和余额变更特殊显示
  if (entry.isTransfer || entry.isBalanceChange) {
    for (const aa of entry.accountAmounts) {
      const text = accountText(aa.account, aa.amount);
      if (!text) continue;
      li.createSpan({
        cls: `cashlog-account ${aa.amount < 0 ? "cashlog-transfer-from" : "cashlog-transfer-to"}`,
        text,
      });
    }
  } else {
    // 金额（无账户部分）
    if (!hideAmountPart) {
      const noAcct = entry.noAccountAmount;
      if (noAcct !== 0) {
        const amountClass = entry.isExpense ? "cashlog-amount-expense" : "cashlog-amount-income";
        li.createSpan({
          cls: `cashlog-amount ${amountClass}`,
          text: `💴${amountText(noAcct)}`,
        });
      }
    }

    // 账户
    for (const aa of entry.accountAmounts) {
      const text = accountText(aa.account, aa.amount);
      if (!text) continue;
      li.createSpan({ cls: "cashlog-account", text });
    }
  }

  // 附件
  if (entry.hasAttachments) {
    const folder = plugin.settings.attachmentFolder;
    for (const att of entry.attachments) {
      renderAttachmentLink(li, att, folder, (fullPath) => {
        const file = plugin.app.vault.getAbstractFileByPath(fullPath);
        if (file && file instanceof TFile) {
          void plugin.app.workspace.getLeaf().openFile(file);
        }
      });
    }
  }

  // 日期
  if (!query.shouldHideDate && entry.date) {
    li.createSpan({
      cls: "cashlog-date",
      text: `➕${entry.date.format("YYYY-MM-DD")}`,
    });
  }

  // 时间
  if (!query.shouldHideTime && entry.time) {
    li.createSpan({
      cls: "cashlog-time",
      text: `⏰${entry.time}`,
    });
  }

  // 编辑按钮
  if (plugin.settings.showEditButton && entry.location) {
    const editBtn = li.createEl("a", {
      cls: "cashlog-edit-button",
      attr: { href: "#" },
    });
    editBtn.setText(" ✏️");
    editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditModal(plugin, entry);
    });
  }

  // 笔记链接
  if (plugin.settings.showNoteLink && entry.location) {
    const noteName = extractNoteName(entry.location.path);
    const linkEl = li.createEl("a", {
      cls: "cashlog-note-link",
      text: ` ${noteName}`,
    });
    linkEl.addEventListener("click", (ev: MouseEvent) => {
      void openFileAtLine(plugin, entry, ev);
    });
    linkEl.addEventListener("mousedown", (ev: MouseEvent) => {
      // 中键点击在新标签页打开（仿 tasks）
      if (ev.button === 1) {
        void openFileAtLine(plugin, entry, ev);
      }
    });
  }
}

// 打开编辑 Modal
function openEditModal(plugin: CashlogPlugin, entry: CashlogEntry): void {
  const settings = plugin.settings;
  const app = plugin.app;

  const writeToFile = (data: EditableEntryData) => {
    if (!entry.location) return;
    // 收窄后固定下来，闭包内不再重复判空
    const location = entry.location;

    // 余额变更需要校验缓存是否就绪
    if (data.tagType === "balanceChange") {
      if (!plugin.cache) {
        new Notice(t("notice.accountBalanceUnavailable"));
        return;
      }
    }
    const newEntry = buildEntryFromModalData(data, plugin, {
      indentation: entry.indentation,
      listMarker: entry.listMarker,
      location,
    });
    const newLine = newEntry.toFileLineString();

    const file = app.vault.getAbstractFileByPath(location.path);
    if (file instanceof TFile) {
      app.vault.process(file, (content) => {
        const lines = content.split("\n");
        // 索引快照可能已过期：先校验行号处内容，再全局唯一匹配，避免改写别的行
        const targetLine = resolveEntryLine(lines, entry.originalMarkdown, location.lineNumber);
        if (targetLine === null) {
          new Notice(t("error.entryNotFound"));
          return content;
        }
        lines[targetLine] = newLine;
        return lines.join("\n");
      }).catch((e) => {
        new Notice(t("error.queryError") + ": " + getErrorMessage(e));
      });
    }
  };

  const modal = new CashlogModal(app, settings, entry, writeToFile, writeToFile, plugin);
  modal.open();
}

// 打开文件并定位到行（仿 tasks：重新读取文件精确定位行号）
async function openFileAtLine(
  plugin: CashlogPlugin,
  entry: CashlogEntry,
  ev: MouseEvent,
): Promise<void> {
  ev.preventDefault();
  ev.stopPropagation();

  if (!entry.location) return;

  const file = plugin.app.vault.getAbstractFileByPath(entry.location.path);
  if (!(file instanceof TFile)) return;

  // 重新读取文件内容，精确定位行号（仿 tasks getTaskLineAndFile）
  const content = await plugin.app.vault.read(file);
  const lines = content.split("\n");
  const storedLine = entry.location.lineNumber;
  const originalLine = entry.originalMarkdown;

  let resolvedLine = storedLine;

  // 策略1：存储的行号处内容是否仍匹配
  if (storedLine < lines.length && lines[storedLine] === originalLine) {
    resolvedLine = storedLine;
  } else {
    // 策略2：搜索文件中唯一匹配的行（仿 tasks tryFindingIdenticalUniqueMarkdownLineInFile）
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === originalLine) {
        matches.push(i);
      }
    }
    if (matches.length === 1) {
      resolvedLine = matches[0];
    }
    // 如果多处匹配或无匹配，回退到存储的行号
  }

  const leaf = plugin.app.workspace.getLeaf(Keymap.isModEvent(ev));
  await leaf.openFile(file, { eState: { line: resolvedLine } });
}

// 计算分组汇总
function calculateGroupSummary(entries: CashlogEntry[]): Summary {
  const totalIncome = round2(entries.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0));
  const totalExpense = round2(entries.filter((e) => e.amount < 0).reduce((sum, e) => sum + e.amount, 0));
  return {
    totalIncome,
    totalExpense,
    balance: round2(totalIncome + totalExpense),
    count: entries.length,
  };
}

// 汇总行里的金额展示：隐私开关打开时打码（笔数不是金额，不打码）
function summaryAmount(value: number, hideAmounts: boolean): string {
  return hideAmounts ? "***" : String(value);
}

// 渲染分组汇总
function renderGroupSummary(containerEl: HTMLElement, summary: Summary, hideAmounts: boolean = false): void {
  const div = containerEl.createDiv({ cls: "cashlog-group-summary" });
  if (summary.totalExpense !== 0) {
    div.createSpan({
      cls: "cashlog-summary-expense",
      text: tp("renderer.groupExpense", { amount: summaryAmount(summary.totalExpense, hideAmounts) }),
    });
  }
  if (summary.totalIncome !== 0) {
    div.createSpan({
      cls: "cashlog-summary-income",
      text: tp("renderer.groupIncome", { amount: summaryAmount(summary.totalIncome, hideAmounts) }),
    });
  }
}

// 渲染总汇总
function renderSummary(
  containerEl: HTMLElement,
  summary: Summary,
  query: Query,
  hideAmounts: boolean = false,
): void {
  const div = containerEl.createDiv({ cls: "cashlog-summary" });

  if (query.shouldShowTotalExpense || query.shouldShowTotal) {
    div.createDiv({
      cls: "cashlog-summary-expense",
      text: tp("renderer.totalExpense", { amount: summaryAmount(summary.totalExpense, hideAmounts) }),
    });
  }

  if (query.shouldShowTotalIncome || query.shouldShowTotal) {
    div.createDiv({
      cls: "cashlog-summary-income",
      text: tp("renderer.totalIncome", { amount: summaryAmount(summary.totalIncome, hideAmounts) }),
    });
  }

  if (query.shouldShowBalance || query.shouldShowTotal) {
    div.createDiv({
      cls: "cashlog-summary-balance",
      text: tp("renderer.netBalance", { amount: summaryAmount(summary.balance, hideAmounts) }),
    });
  }

  if (query.shouldShowCount || query.shouldShowTotal) {
    div.createDiv({
      cls: "cashlog-summary-count",
      text: tp("renderer.entryCount", { count: summary.count }),
    });
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
