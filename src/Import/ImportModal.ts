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
import { TagPickerModal, type TagPickerRoot } from "../ui/TagPicker";
import { TagTreeModal } from "../TagTreeModal";
import { PromptModal } from "../ui/PromptModal";
import { ConfirmModal } from "../ui/ConfirmModal";
import { validateTagSegment, findNode } from "../TagTree";
import { parseImportRows } from "./index";
import { readStatementFile, isStatementFile } from "./ImportFileReader";
import { toDrafts, type ImportDraft } from "./draft";
import { markDuplicates } from "./dedupe";
import { findTransferPairs } from "./pairing";
import {
  groupDrafts,
  groupTagState,
  setGroupTag,
  applyBatch,
  countUntagged,
  sortGroups,
  type GroupKeyFn,
  type GroupSort,
  type ImportGroup,
} from "./grouping";
import { buildLines, formatSkipSummary } from "./writer";
import type { ImportParseResult } from "./types";

/** 账户下拉里「新建」项的哨兵值；账户名不含斜杠，故不会撞名 */
const NEW_ACCOUNT_OPTION = "/__new-account__";

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
  /** 分组排序方式 */
  private sort: GroupSort = "bill";


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

    // 排序 + 组级批量
    this.renderGroupToolbar();

    // 分组清单
    const listBody = createSection(this.bodyEl, {
      title: `${t("import.title")} · ${this.groups.length} 组`,
    });

    for (const group of sortGroups(this.groups, this.sort)) {
      this.renderGroup(listBody, group);
    }

    // 账户映射
    this.renderAccountMapping();

    // 底部操作
    this.renderFooter();
  }

  /** 组是否「全选」：组内所有条目都勾着。直接从草稿推导，不另存状态。 */
  private isGroupSelected(group: ImportGroup): boolean {
    return group.drafts.length > 0 && group.drafts.every((draft) => draft.selected);
  }

  /** 组是否是「部分选中」，用来显示半选框。 */
  private isGroupPartial(group: ImportGroup): boolean {
    return group.drafts.some((draft) => draft.selected) && !this.isGroupSelected(group);
  }

  /** 排序下拉 + 组级批量操作 */
  private renderGroupToolbar(): void {
    const toolbar = createSection(this.bodyEl, {});

    new Setting(toolbar)
      .setName(t("import.sort"))
      .setDesc(t("import.sortDesc"))
      .addDropdown((dd) => {
        dd.addOption("bill", t("import.sort.bill"));
        dd.addOption("pending-first", t("import.sort.pending"));
        dd.addOption("amount-desc", t("import.sort.amountDesc"));
        dd.addOption("amount-asc", t("import.sort.amountAsc"));
        dd.addOption("count-desc", t("import.sort.countDesc"));
        dd.addOption("name", t("import.sort.name"));
        dd.setValue(this.sort);
        dd.onChange((value) => {
          this.sort = value as GroupSort;
          // 排序不用重建整棵树也行，但重建最省心且状态都在 draft 上
          this.refresh();
        });
      });

    const bar = toolbar.createDiv({ cls: "cashlog-import-batch cashlog-import-group-batch" });

    const all = bar.createEl("input", { attr: { type: "checkbox" } });
    const count = this.groups.filter((group) => this.isGroupSelected(group)).length;
    all.checked = this.groups.length > 0 && count === this.groups.length;
    all.indeterminate = count > 0 && count < this.groups.length;
    all.addEventListener("change", () => {
      // 全选/全不选直接作用到条目上，组的状态由条目推导
      const checked = all.checked;
      for (const group of this.groups) {
        for (const draft of group.drafts) draft.selected = checked;
      }
      this.refresh();
    });

    const label = bar.createSpan({ cls: "cashlog-import-batch-label" });
    label.setText(`已选 ${count} 组 / 共 ${this.groups.length} 组`);

    const applyBtn = bar.createSpan({ cls: "cashlog-import-batch-apply" });
    applyBtn.setText(tp("import.batchGroupTag", { count }));
    applyBtn.toggleClass("cashlog-import-batch-disabled", count === 0);
    applyBtn.addEventListener("click", () => {
      const picked = this.groups.filter((g) => this.isGroupSelected(g));
      if (picked.length === 0) return;
      // 与子条目批量同一套选择器：可以只到大类，也可以选到细分
      this.openTagPicker(null, (tag) => {
        if (tag === null) return;
        for (const group of picked) setGroupTag(group, tag);
        this.refresh();
      }, null);
    });
  }

  private renderGroup(container: HTMLElement, group: ImportGroup): void {
    const state = groupTagState(group);
    const total = group.drafts.reduce((s, d) => s + d.record.amount, 0);
    const isOpen = this.expanded.has(group.key);

    const row = container.createDiv({ cls: "cashlog-import-group" });
    const head = row.createDiv({ cls: "cashlog-import-group-head" });

    const groupCheck = head.createEl("input", { attr: { type: "checkbox" } });
    groupCheck.className = "cashlog-import-group-check";
    groupCheck.checked = this.isGroupSelected(group);
    // 部分选中显示半选框，避免看起来像「全选」或「全不选」
    groupCheck.indeterminate = this.isGroupPartial(group);
    groupCheck.addEventListener("change", () => {
      // 勾母类即勾选该组全部条目
      const checked = groupCheck.checked;
      for (const draft of group.drafts) draft.selected = checked;
      this.refresh();
    });

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

    // 勾选变化后要回写批量栏的数字；批量栏在条目之后才创建，
    // 所以先占一个函数位，等批量栏建好再赋真身。
    let syncBatch = (): void => {};

    // 展开：逐条
    for (const draft of group.drafts) {
      this.renderDraftRow(row, draft, () => syncBatch());
    }

    // 组内批量栏。始终渲染，0 条时按钮置灰 ——
    // 否则反选到 0 条时整条栏消失，用户会以为功能坏了。
    const batch = row.createDiv({ cls: "cashlog-import-batch" });
    const batchLabel = batch.createSpan({ cls: "cashlog-import-batch-label" });
    const applyBtn = batch.createSpan({ cls: "cashlog-import-batch-apply" });

    syncBatch = (): void => {
      const count = group.drafts.filter((d) => d.selected).length;
      batchLabel.setText(`选中 ${count} 条`);
      applyBtn.setText(tp("import.batchApply", { count }));
      applyBtn.toggleClass("cashlog-import-batch-disabled", count === 0);
    };

    applyBtn.addEventListener("click", () => {
      // 必须在这里重新过滤：渲染时捕获的数组不会跟着勾选变化
      const picked = group.drafts.filter((d) => d.selected);
      if (picked.length === 0) return;
      this.openTagPicker(null, (tag) => {
        applyBatch(picked, { mainTag: tag });
        this.refresh();
      }, null);
    });

    syncBatch();
  }

  private renderDraftRow(
    container: HTMLElement,
    draft: ImportDraft,
    onSelectedChange?: () => void,
  ): void {
    const row = container.createDiv({ cls: "cashlog-import-draft" });
    // 没设标签的行用左侧色条标出来：展开后默认是勾选状态，
    // 不区分的话看不出哪些还没处理、会在导入时被拦下。
    if (draft.mainTag === null) row.addClass("cashlog-import-draft-untagged");

    const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = draft.selected;
    checkbox.addEventListener("change", () => {
      draft.selected = checkbox.checked;
      // 通知组内批量栏刷新「选中 N 条」
      onSelectedChange?.();
    });

    row.createSpan({
      cls: "cashlog-import-draft-time",
      text: draft.record.tradeTime.slice(5, 16).replace("T", " "),
    });
    row.createSpan({
      cls: "cashlog-import-draft-amount",
      text: (draft.entryType === "income" ? "+" : "-") + draft.record.amount.toFixed(2),
    });
    // 描述可能很长（微信的商品名、转账附言），默认单行省略。
    // title 提供悬停全文，点击可以就地展开/收起。
    const descEl = row.createSpan({
      cls: "cashlog-import-draft-desc",
      text: draft.description,
    });
    descEl.setAttribute("title", draft.description);
    descEl.addEventListener("click", () => {
      const expanded = descEl.hasClass("is-expanded");
      descEl.toggleClass("is-expanded", !expanded);
    });

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
      // 渠道名可能很长（"招商银行储蓄卡(1234)"），独占一行并允许换行，
      // 否则会被 .setting-item-name 的省略号截掉，看不出是哪个账户。
      const affected = this.drafts.filter((d) => (d.record.payMethod ?? "").trim() === channel);
      const total = Math.round(affected.reduce((sum, d) => sum + d.record.amount, 0) * 100) / 100;

      new Setting(body)
        .setName(channel)
        .setDesc(`${affected.length} 条 · ${total}`)
        .setClass("cashlog-import-account")
        .addDropdown((dd) => {
          dd.addOption("", "—");
          for (const acc of accounts) dd.addOption(acc, acc);
          // 和标签选择器一致：新建入口放在列表里
          dd.addOption(NEW_ACCOUNT_OPTION, t("import.picker.newOption"));
          dd.setValue(this.accountMap.get(channel) ?? "");
          dd.onChange((value) => {
            if (value === NEW_ACCOUNT_OPTION) {
              this.promptNewAccount(channel);
              // 退回到「未指定」，等用户建完再选
              dd.setValue("");
              return;
            }
            this.assignAccount(channel, value);
          });
        });
    }
  }

  /** 把某个资金渠道映射到账户，并同步到对应草稿上。 */
  private assignAccount(channel: string, account: string): void {
    this.accountMap.set(channel, account);
    for (const draft of this.drafts) {
      if ((draft.record.payMethod ?? "").trim() === channel) {
        draft.account = account === "" ? null : account;
      }
    }
  }

  /** 就地为某个资金渠道新建账户，建完立即落盘并选上。 */
  private promptNewAccount(channel: string): void {
    new PromptModal(this.app, {
      title: t("import.account.newTitle"),
      placeholder: t("import.account.newPlaceholder"),
      validate: (value) => (value.trim() === "" ? t("import.account.emptyName") : null),
      onConfirm: async (name) => {
        const settings = this.plugin.settings;
        if (!settings.accounts) settings.accounts = [];

        if (settings.accounts.includes(name)) {
          // 已存在就当选中它，不必报错
          this.assignAccount(channel, name);
          this.refresh();
          return;
        }

        settings.accounts.push(name);
        // 立即保存，避免关掉弹窗后新建的账户丢失
        await this.plugin.saveSettings();
        this.assignAccount(channel, name);
        this.refresh();
      },
    }).open();
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
    // 重建会把容器的 scrollTop 归零；保存并还原，
    // 否则展开/勾选后视口会跳回顶部，表现为「内容上下漂移」。
    const scroll = this.bodyEl.scrollTop;
    this.groups = groupDrafts(this.drafts, this.options.groupKeyFn);
    this.renderList(this.result?.source ?? undefined);
    this.bodyEl.scrollTop = scroll;
  }

  // ---------------------------------------------------------------- 标签选择

  private openTagPicker(
    _draft: ImportDraft | null,
    onPick: (tag: string | null) => void,
    current: string | null,
  ): void {
    // 支出与收入两棵树都传进去，由选择器的第一级决定用哪棵。
    // 传的是设置对象的引用，因此就地新建能直接写回并保存。
    // 必须取设置里那棵树本身的引用。写成 `?? []` 时，
    // 字段为空会造出临时数组，新建的标签 push 进去后 saveSettings 存不下来。
    const settings = this.plugin.settings;
    settings.expenseTagTree ??= [];
    settings.incomeTagTree ??= [];

    const roots: TagPickerRoot[] = [
      { mainTag: settings.expenseTag, tree: settings.expenseTagTree },
      { mainTag: settings.incomeTag, tree: settings.incomeTagTree },
    ];

    new TagPickerModal(this.app, {
      roots,
      current,
      onPick,
      onCreate: async (root, parentPath, name) => {
        const check = validateTagSegment(name);
        if (!check.valid) {
          new Notice(t(check.message ?? "tag.segment.invalidChars"));
          return "invalid";
        }

        const parent = parentPath.length === 0 ? null : findNode(root.tree, parentPath);
        const siblings = parent ? (parent.children ?? []) : root.tree;
        if (siblings.some((node) => node.name === name)) return "exists";

        if (parent) {
          if (!parent.children) parent.children = [];
          parent.children.push({ name });
        } else {
          root.tree.push({ name });
        }

        // 立即落盘：新建的标签必须进设置，否则关掉弹窗就丢了
        await this.plugin.saveSettings();
        return "created";
      },
      onManage: () => {
        const s = this.plugin.settings;
        new TagTreeModal(
          this.app,
          [
            { key: "expense", title: s.expenseTag, nodes: s.expenseTagTree ?? [] },
            { key: "income", title: s.incomeTag, nodes: s.incomeTagTree ?? [] },
            {
              key: "extra",
              title: t("panelSettings.extraTagDimensions"),
              nodes: s.extraTagTrees ?? [],
            },
          ],
          async () => {
            await this.plugin.saveSettings();
          },
        ).open();
      },
    }).open();
  }

  // ---------------------------------------------------------------- 写入

  private async commit(discardUntagged = false): Promise<void> {
    if (this.targetPath.trim() === "") {
      new Notice(t("import.noTarget"));
      return;
    }

    // 至少要有一个大类（#支出 / #收入）。缺的不能静默丢掉，也不能静默写入，
    // 所以先问一次：舍弃它们继续，还是回去补设。
    if (!discardUntagged) {
      const missing = this.drafts.filter(
        (draft) => draft.selected && draft.entryType !== null && draft.mainTag === null,
      );
      if (missing.length > 0) {
        new ConfirmModal(this.app, {
          title: t("import.noCategory.title"),
          body: tp("import.noCategory.body", { count: missing.length }),
          confirmText: t("import.noCategory.discard"),
          cancelText: t("import.noCategory.back"),
          onConfirm: () => {
            // 舍弃这些条目后再走一遍，这次不再询问
            for (const draft of missing) draft.selected = false;
            void this.commit(true);
          },
        }).open();
        return;
      }
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
        new Notice(`${skipped.length} 条未写入：${formatSkipSummary(skipped)}`);
      }

      this.options.onDone?.(lines.length);
      this.close();
    } catch (e) {
      new Notice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
