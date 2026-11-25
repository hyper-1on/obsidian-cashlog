// 导入功能 · 待确认清单
//
// 流程：选账单文件 → 解析 → 按对方分组 → 每组一个大类别（可到任意深度）
//      → 展开后逐条可改 → 勾选 → 写入目标笔记。
//
// 与现有界面保持一致：用 createSection 分区、Setting 排版、
// 标签选择复用 TagPickerModal（与记账表单同一套级联逻辑）。

import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import type CashlogPlugin from "../main";
import { t, tp } from "../i18n";
import { createSection } from "../ui/Section";
import { TagPickerModal } from "../ui/TagPicker";
import { parseImportRows } from "./index";
import { readStatementFile, isStatementFile } from "./ImportFileReader";
import { toDrafts, type ImportDraft } from "./draft";
import { markDuplicates } from "./dedupe";
import { findTransferPairs } from "./pairing";
import { groupDrafts, groupTagState, setGroupTag, applyBatch, countUntagged, type GroupKeyFn, type ImportGroup } from "./grouping";
import { buildLines } from "./writer";
import type { ImportParseResult } from "./types";

export interface ImportModalOptions {
  /** 分组维度，默认按交易对方 */
  groupKeyFn?: GroupKeyFn;
  /** 初始目标笔记路径 */
  targetPath?: string;
  /** 写入完成后的回调 */
  onDone?: (count: number) => void;
}

/** 来源的内部名 → 展示名。清单摘要里用。 */
const SOURCE_LABEL: Record<string, string> = {
  alipay_ledger: "支付宝 · 收支明细",
  alipay_app: "支付宝 · 电子回单",
  alipay_web: "支付宝 · 网页明细",
  wechat_personal: "微信支付 · 个人账单",
  wechat_merchant_trade: "微信商户 · 交易账单",
  wechat_merchant_fund: "微信商户 · 资金账单",
  alipay_merchant: "支付宝 · 商户账单",
  bank: "银行流水",
  generic: "通用流水",
};

export class ImportModal extends Modal {
  private readonly plugin: CashlogPlugin;
  private readonly options: ImportModalOptions;

  private result: ImportParseResult | null = null;
  private drafts: ImportDraft[] = [];
  private groups: ImportGroup[] = [];
  private targetPath: string;
  /** 资金渠道 → 账户名；空串表示不记账户 */
  private accountMap = new Map<string, string>();
  /** 已展开的分组键 */
  private expanded = new Set<string>();

  private bodyEl!: HTMLElement;

  constructor(app: App, plugin: CashlogPlugin, options: ImportModalOptions = {}) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.targetPath = options.targetPath ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cashlog-import-modal");
    this.titleEl.setText(t("import.title"));

    this.bodyEl = contentEl.createDiv({ cls: "cashlog-import-body" });
    this.renderFilePicker();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ---------------------------------------------------------------- 文件选择

  private renderFilePicker(): void {
    this.bodyEl.empty();

    const files = this.plugin.app.vault
      .getFiles()
      .filter((f) => isStatementFile(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const body = createSection(this.bodyEl, { title: t("import.pickFile") });

    if (files.length === 0) {
      body.createDiv({ cls: "cashlog-import-empty", text: t("import.noFiles") });
      return;
    }

    // 默认选最近修改的那个，省一次点击
    let selected = files[0].path;

    new Setting(body)
      .setName(t("import.pickFile"))
      .setDesc(tp("import.fileCount", { count: files.length }))
      .addDropdown((dd) => {
        for (const file of files) dd.addOption(file.path, file.path);
        dd.setValue(selected);
        dd.onChange((path) => {
          selected = path;
        });
      });

    // 目标笔记（先选文件后也可以改）
    new Setting(body)
      .setName(t("import.targetNote"))
      .setDesc(t("import.targetNoteDesc"))
      .addText((text) =>
        text
          .setPlaceholder("账本/流水.md")
          .setValue(this.targetPath)
          .onChange((value) => {
            this.targetPath = value.trim();
          }),
      );

    // 明确的「下一步」——选文件本身不触发任何事，否则用户不知道怎么继续
    const footer = this.bodyEl.createDiv({ cls: "cashlog-import-footer" });
    footer.createSpan({ cls: "cashlog-import-hint", text: t("import.pickFileHint") });

    const cancel = footer.createEl("button", { text: t("import.cancel") });
    cancel.className = "cashlog-settings-btn";
    cancel.addEventListener("click", () => this.close());

    const load = footer.createEl("button", { text: t("import.load") });
    load.className = "cashlog-settings-btn cashlog-settings-btn-primary";
    load.addEventListener("click", () => {
      load.disabled = true;
      load.textContent = t("import.loading");
      void this.loadFile(selected).finally(() => {
        load.disabled = false;
        load.textContent = t("import.load");
      });
    });
  }

  private async loadFile(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    try {
      const read = await readStatementFile(this.plugin.app, file);
      const result = parseImportRows(read.rows);
      if (result.source === null) {
        new Notice(t("import.parseFailed"));
        return;
      }

      this.result = result;
      this.drafts = toDrafts(result.records);

      // 与笔记里已有的条目做弱匹配（同日期+同金额+同方向）
      markDuplicates(
        this.drafts,
        this.plugin.cache.getEntries().flatMap((entry) => {
          const date = entry.date?.format("YYYY-MM-DD");
          if (!date) return [];
          const direction = entry.amount < 0 ? ("expense" as const) : ("income" as const);
          return [{ date, amount: Math.abs(entry.amount), direction }];
        }),
      );

      const pairs = findTransferPairs(this.drafts);
      this.groups = groupDrafts(this.drafts, this.options.groupKeyFn);
      this.collectAccounts();

      this.renderList(read.sheetName, pairs.length);
    } catch (e) {
      new Notice(`${t("import.parseFailed")} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 收集出现过的资金渠道，供账户映射使用。 */
  private collectAccounts(): void {
    this.accountMap.clear();
    for (const draft of this.drafts) {
      const channel = (draft.record.payMethod ?? "").trim();
      if (channel === "" || channel === "/") continue;
      if (!this.accountMap.has(channel)) this.accountMap.set(channel, "");
    }
  }

  // ---------------------------------------------------------------- 清单

  private renderList(sheetName?: string, pairCount = 0): void {
    this.bodyEl.empty();
    const result = this.result;
    if (!result) return;

    // 摘要
    const sourceLabel = SOURCE_LABEL[result.source ?? ""] ?? result.source ?? "";
    const summary = createSection(this.bodyEl, {}).createDiv({ cls: "cashlog-import-summary" });
    summary.setText(
      tp("import.summary", { source: sourceLabel, count: this.drafts.length }) +
        (sheetName ? ` · ${sheetName}` : "") +
        (pairCount > 0 ? ` · ${pairCount} 对疑似转账` : ""),
    );

    if (result.skipped.length > 0) {
      summary.createDiv({
        cls: "cashlog-import-skip",
        text: `跳过 ${result.skipped.length} 行：${result.skipped
          .slice(0, 3)
          .map((s) => `R${s.rowIndex}`)
          .join("、")}`,
      });
    }

    // 目标笔记
    new Setting(this.bodyEl)
      .setName(t("import.targetNote"))
      .setDesc(t("import.targetNoteDesc"))
      .addText((text) =>
        text.setPlaceholder("账本/流水.md").setValue(this.targetPath).onChange((v) => {
          this.targetPath = v.trim();
        }),
      );

    // 分组清单
    const listBody = createSection(this.bodyEl, {
      title: `${t("import.title")} · ${this.groups.length} 组`,
    });

    for (const group of this.groups) {
      this.renderGroup(listBody, group);
    }

    // 账户映射
    this.renderAccountMapping();

    // 底部操作
    this.renderFooter();
  }

  private renderGroup(container: HTMLElement, group: ImportGroup): void {
    const state = groupTagState(group);
    const total = group.drafts.reduce((s, d) => s + d.record.amount, 0);
    const isOpen = this.expanded.has(group.key);

    const row = container.createDiv({ cls: "cashlog-import-group" });
    const head = row.createDiv({ cls: "cashlog-import-group-head" });

    const toggle = head.createSpan({
      cls: "cashlog-import-group-toggle",
      text: isOpen ? "▾" : "▸",
    });
    toggle.addEventListener("click", () => {
      if (isOpen) this.expanded.delete(group.key);
      else this.expanded.add(group.key);
      this.refresh();
    });

    head.createSpan({ cls: "cashlog-import-group-name", text: group.key });
    head.createSpan({
      cls: "cashlog-import-group-count",
      text: `${group.drafts.length} 条 · ${total.toFixed(2)}`,
    });

    // 组级标签：显示「空 / 具体值 / 自定义」
    const tagBtn = head.createSpan({
      cls: "cashlog-import-tag-btn",
      text:
        state.kind === "uniform"
          ? (state.tag ?? "").replace(/^#/, "")
          : state.kind === "mixed"
            ? "自定义"
            : "未指定",
    });
    if (state.kind !== "uniform") {
      tagBtn.addClass("cashlog-import-tag-btn-empty");
    }
    tagBtn.addEventListener("click", () => {
      this.openTagPicker(null, (tag) => {
        setGroupTag(group, tag);
        this.refresh();
      }, state.tag);
    });

    if (!isOpen) return;

    // 展开：逐条
    for (const draft of group.drafts) {
      this.renderDraftRow(row, draft);
    }

    // 组内批量栏
    const selected = group.drafts.filter((d) => d.selected);
    if (selected.length > 0) {
      const batch = row.createDiv({ cls: "cashlog-import-batch" });
      batch.createSpan({
        cls: "cashlog-import-batch-label",
        text: `选中 ${selected.length} 条`,
      });
      const applyBtn = batch.createSpan({
        cls: "cashlog-import-batch-apply",
        text: "设标签",
      });
      applyBtn.addEventListener("click", () => {
        this.openTagPicker(null, (tag) => {
          applyBatch(selected, { mainTag: tag });
          this.refresh();
        }, null);
      });
    }
  }

  private renderDraftRow(container: HTMLElement, draft: ImportDraft): void {
    const row = container.createDiv({ cls: "cashlog-import-draft" });

    const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = draft.selected;
    checkbox.addEventListener("change", () => {
      draft.selected = checkbox.checked;
    });

    row.createSpan({
      cls: "cashlog-import-draft-time",
      text: draft.record.tradeTime.slice(5, 16).replace("T", " "),
    });
    row.createSpan({
      cls: "cashlog-import-draft-amount",
      text: (draft.entryType === "income" ? "+" : "-") + draft.record.amount.toFixed(2),
    });
    row.createSpan({ cls: "cashlog-import-draft-desc", text: draft.description });

    const tagBtn = row.createSpan({
      cls: "cashlog-import-tag-btn",
      text: draft.mainTag ? draft.mainTag.replace(/^#/, "") : "未指定",
    });
    if (!draft.mainTag) tagBtn.addClass("cashlog-import-tag-btn-empty");
    tagBtn.addEventListener("click", () => {
      this.openTagPicker(draft, (tag) => {
        draft.mainTag = tag;
        draft.tagSource = "manual";
        this.refresh();
      }, draft.mainTag);
    });

    // 状态标记
    if (draft.status === "suspect-duplicate") {
      row.createSpan({ cls: "cashlog-import-badge", text: `疑似重复×${draft.duplicateCount}` });
    } else if (draft.status === "batch-duplicate") {
      row.createSpan({ cls: "cashlog-import-badge", text: "文件内重复" });
    } else if (draft.status === "needs-direction") {
      row.createSpan({ cls: "cashlog-import-badge cashlog-import-badge-warn", text: "方向未定" });
    }
  }

  private renderAccountMapping(): void {
    if (this.accountMap.size === 0) return;

    const body = createSection(this.bodyEl, {
      title: t("import.accounts"),
      desc: t("import.accountsDesc"),
    });

    const accounts = this.plugin.settings.accounts ?? [];

    for (const [channel] of this.accountMap) {
      new Setting(body)
        .setName(channel)
        .addDropdown((dd) => {
          dd.addOption("", "—");
          for (const acc of accounts) dd.addOption(acc, acc);
          dd.setValue(this.accountMap.get(channel) ?? "");
          dd.onChange((value) => {
            this.accountMap.set(channel, value);
            for (const draft of this.drafts) {
              if ((draft.record.payMethod ?? "").trim() === channel) {
                draft.account = value === "" ? null : value;
              }
            }
          });
        });
    }
  }

  private renderFooter(): void {
    const footer = this.bodyEl.createDiv({ cls: "cashlog-import-footer" });

    const untagged = countUntagged(this.drafts.filter((d) => d.selected));
    if (untagged > 0) {
      footer.createSpan({
        cls: "cashlog-import-warn",
        text: tp("import.untagged", { count: untagged }),
      });
    }

    const cancel = footer.createEl("button", { text: t("import.cancel") });
    cancel.className = "cashlog-settings-btn";
    cancel.addEventListener("click", () => this.close());

    const commit = footer.createEl("button", {
      text: t("import.commit"),
    });
    commit.className = "cashlog-settings-btn cashlog-settings-btn-primary";
    commit.addEventListener("click", () => {
      void this.commit();
    });
  }

  private refresh(): void {
    this.groups = groupDrafts(this.drafts, this.options.groupKeyFn);
    this.renderList(this.result?.source ?? undefined);
  }

  // ---------------------------------------------------------------- 标签选择

  private openTagPicker(
    _draft: ImportDraft | null,
    onPick: (tag: string | null) => void,
    current: string | null,
  ): void {
    // 支出与收入两棵树都传进去，由选择器的第一级决定用哪棵。
    // 之前按「组内有没有收入条目」猜一棵树，混合组会选错。
    const roots = [
      {
        mainTag: this.plugin.settings.expenseTag,
        tree: this.plugin.settings.expenseTagTree ?? [],
      },
      {
        mainTag: this.plugin.settings.incomeTag,
        tree: this.plugin.settings.incomeTagTree ?? [],
      },
    ];

    new TagPickerModal(this.app, { roots, current, onPick }).open();
  }

  // ---------------------------------------------------------------- 写入

  private async commit(): Promise<void> {
    if (this.targetPath.trim() === "") {
      new Notice(t("import.noTarget"));
      return;
    }

    const { lines, skipped } = buildLines(this.drafts);
    if (lines.length === 0) {
      new Notice(t("import.nothingSelected"));
      return;
    }

    try {
      const path = normalizePath(this.targetPath.trim());
      const existing = this.plugin.app.vault.getAbstractFileByPath(path);

      if (existing instanceof TFile) {
        const content = await this.plugin.app.vault.read(existing);
        const needsNewline = content.length > 0 && !content.endsWith("\n");
        await this.plugin.app.vault.modify(
          existing,
          content + (needsNewline ? "\n" : "") + lines.join("\n") + "\n",
        );
      } else {
        await this.plugin.app.vault.create(path, lines.join("\n") + "\n");
      }

      new Notice(tp("import.done", { count: lines.length }));
      if (skipped.length > 0) {
        new Notice(`${skipped.length} 条未写入：${skipped.slice(0, 3).map((s) => s.reason).join("、")}`);
      }

      this.options.onDone?.(lines.length);
      this.close();
    } catch (e) {
      new Notice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
