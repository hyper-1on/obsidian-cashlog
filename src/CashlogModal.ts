/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { App, Menu, MenuItem, Modal, Notice, Setting } from "obsidian";
import { CashlogEntry } from "./CashlogEntry";
import type { CashlogSettings } from "./Settings";
import type CashlogPlugin from "./main";
import { AttachmentManager } from "./AttachmentManager";
import { AccountManager } from "./AccountManager";
import { validateEntryData } from "./EntryEditor";
import { t, tp, getCurrencySymbol } from "./i18n";
import { createSection } from "./ui/Section";
import type { TagNode } from "./TagTree";
import { addChild, findNode, validateTagSegment } from "./TagTree";
import { PromptModal } from "./ui/PromptModal";

/** 下拉里「新建」项的哨兵值；标签名不允许含斜杠，因此不会与真实名冲突 */
const NEW_TAG_OPTION = "\u0000new";
import { moment } from "./types";

// 账户行数据（UI 用）
export interface AccountAmountItem {
  account: string; // "" = 无账户
  amount: string;  // 正数字符串，符号由 tagType 决定
}

// Modal 中可编辑的条目数据
export interface EditableEntryData {
  tagType: "income" | "expense" | "transfer" | "balanceChange";
  subTag: string;
  /** 附加标签（副标签），如 #地点/食堂。编辑时必须原样保留，否则会丢数据 */
  extraTags: string[];
  description: string;
  date: string;
  time: string;
  // 收入/支出的账户行（含无账户行）
  accounts: AccountAmountItem[];
  // 转账的转出/转入账户
  fromAccounts: AccountAmountItem[];
  toAccounts: AccountAmountItem[];
  // 余额变更的账户行（存储目标余额）
  balanceChangeAccounts: AccountAmountItem[];
  attachments: string[];
}

// 提取附加标签：不属于任何主标签（收入/支出/转账/余额变更）的标签都算副标签。
// 编辑时这些标签必须原样保留，否则用户手写的 #地点/食堂 会在保存后消失。
function extractExtraTags(entry: CashlogEntry, settings: CashlogSettings): string[] {
  const mainTags = [
    settings.incomeTag,
    settings.expenseTag,
    settings.transferTag,
    settings.balanceChangeTag,
  ]
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());

  return entry.tags.filter((tag) => {
    const lower = tag.toLowerCase();
    return !mainTags.some((main) => lower === main || lower.startsWith(main + "/"));
  });
}

// 从 CashlogEntry 创建默认 EditableEntryData
export function createDefaultData(settings: CashlogSettings, entry: CashlogEntry | null): EditableEntryData {
  const base = {
    description: entry?.description || "",
    date: entry?.date ? entry.date.format("YYYY-MM-DD") : moment().format("YYYY-MM-DD"),
    time: entry?.time || "",
    accounts: [] as AccountAmountItem[],
    fromAccounts: [] as AccountAmountItem[],
    toAccounts: [] as AccountAmountItem[],
    balanceChangeAccounts: [] as AccountAmountItem[],
    attachments: entry?.attachments ? [...entry.attachments] : [],
    // 附加标签：除主标签外的全部标签，编辑时必须原样保留
    extraTags: entry ? extractExtraTags(entry, settings) : [],
  };

  if (!entry || entry.tags.length === 0) {
    return {
      ...base,
      tagType: "expense",
      subTag: "",
      accounts: [{ account: "", amount: "" }],
    };
  }

  if (entry.isBalanceChange) {
    return {
      ...base,
      tagType: "balanceChange",
      subTag: "",
      balanceChangeAccounts: entry.accountAmounts.length > 0
        ? entry.accountAmounts.map((aa) => ({ account: aa.account, amount: "" }))
        : [{ account: settings.accounts[0] || "", amount: "" }],
    };
  }

  if (entry.isTransfer) {
    const fromAccs = entry.accountAmounts.filter((aa) => aa.amount < 0);
    const toAccs = entry.accountAmounts.filter((aa) => aa.amount > 0);
    return {
      ...base,
      tagType: "transfer",
      subTag: "",
      accounts: [],
      fromAccounts: fromAccs.length > 0
        ? fromAccs.map((aa) => ({ account: aa.account, amount: Math.abs(aa.amount).toString() }))
        : [{ account: settings.accounts[0] || "", amount: "" }],
      toAccounts: toAccs.length > 0
        ? toAccs.map((aa) => ({ account: aa.account, amount: aa.amount.toString() }))
        : [{ account: settings.accounts[1] || settings.accounts[0] || "", amount: "" }],
    };
  }

  const primaryTag = entry.tags[0];
  const incomeBase = settings.incomeTag;
  const expenseBase = settings.expenseTag;

  let tagType: "income" | "expense" = "expense";
  let subTag = "";

  if (primaryTag.toLowerCase().startsWith(incomeBase.toLowerCase())) {
    tagType = "income";
    subTag = primaryTag.length > incomeBase.length ? primaryTag.substring(incomeBase.length + 1) : "";
  } else if (primaryTag.toLowerCase().startsWith(expenseBase.toLowerCase())) {
    tagType = "expense";
    subTag = primaryTag.length > expenseBase.length ? primaryTag.substring(expenseBase.length + 1) : "";
  }

  // 构建账户行列表
  const accounts: AccountAmountItem[] = [];
  const noAccountAmt = entry.noAccountAmount;
  if (noAccountAmt !== 0) {
    accounts.push({ account: "", amount: Math.abs(noAccountAmt).toString() });
  }
  for (const aa of entry.accountAmounts) {
    accounts.push({ account: aa.account, amount: Math.abs(aa.amount).toString() });
  }
  if (accounts.length === 0) {
    accounts.push({ account: "", amount: Math.abs(entry.amount).toString() || "" });
  }

  return { ...base, tagType, subTag, accounts };
}

export class CashlogModal extends Modal {
  private entry: CashlogEntry | null;
  private onSubmit: (data: EditableEntryData) => void;
  private onChange: ((data: EditableEntryData) => void) | null;
  private settings: CashlogSettings;
  private data: EditableEntryData;
  private fileInputEl: HTMLInputElement | null = null;
  private plugin: CashlogPlugin | null;
  private pendingUploads: { file: File; tempId: string }[] = [];
  private pendingDeletions: string[] = [];
  private pendingIdCounter = 0;

  constructor(
    app: App,
    settings: CashlogSettings,
    entry: CashlogEntry | null,
    onSubmit: (data: EditableEntryData) => void,
    onChange?: (data: EditableEntryData) => void,
    plugin?: CashlogPlugin,
  ) {
    super(app);
    this.settings = settings;
    this.entry = entry;
    this.onSubmit = onSubmit;
    this.onChange = onChange || null;
    this.plugin = plugin || null;
    this.data = createDefaultData(settings, entry);
  }

  onOpen() {
    this.titleEl.setText(t("cashlogModal.title"));
    this.buildForm();
  }

  onClose() {
    this.contentEl.empty();
  }

  // 保存描述字段引用（用于增量更新时恢复）
  private descInputEl: HTMLInputElement | null = null;

  // 构建表单（优化版：类型变化时只重建条件字段区域，保留已填写内容）
  private buildForm(): void {
    const { contentEl } = this;
    contentEl.addClass("cashlog-modal");

    // 保存当前用户输入内容（用于重建后恢复）
    const savedDescription = this.data.description;
    const savedTime = this.data.time;
    const savedDate = this.data.date;
    const savedSubTag = this.data.subTag;
    const savedAccounts = [...this.data.accounts];
    const savedFromAccounts = [...this.data.fromAccounts];
    const savedToAccounts = [...this.data.toAccounts];
    const savedBalanceChangeAccounts = [...this.data.balanceChangeAccounts];
    const savedAttachments = [...this.data.attachments];

    // 检查是否需要完全重建（首次渲染）
    const needsFullRebuild = !contentEl.querySelector(".cashlog-modal-form");

    if (needsFullRebuild) {
      contentEl.empty();
      // 渲染类型选择器（稳定字段，永不重建）
      const typeBody = createSection(contentEl, { title: t("cashlogModal.group.type") });

      this.renderTypeFieldStable(typeBody);
    }

    // 获取或创建条件字段区域容器
    let conditionalArea = contentEl.querySelector(".cashlog-conditional-area") as HTMLElement;
    if (!conditionalArea) {
      const detailBody = createSection(contentEl, { title: t("cashlogModal.group.detail") });

      conditionalArea = detailBody.createDiv({ cls: "cashlog-conditional-area" });
    }
    conditionalArea.empty();

    // 根据当前类型渲染条件字段
    if (this.data.tagType === "transfer") {
      this.renderConditionalDescription(conditionalArea);
      if (this.settings.enableAccounts) {
        this.renderTransferFields(conditionalArea);
      }
    } else if (this.data.tagType === "balanceChange") {
      this.renderConditionalDescription(conditionalArea);
      if (this.settings.enableAccounts) {
        this.renderBalanceChangeFields(conditionalArea);
      }
    } else {
      this.renderSubTagField(conditionalArea);
      this.renderConditionalDescription(conditionalArea);
      if (this.settings.enableAccounts) {
        this.renderAccountRows(conditionalArea);
      } else {
        this.renderAmountField(conditionalArea);
      }
    }

    // 附加标签（地点、必要性这类独立维度）与记账类型无关：
    // 转账和余额变更同样可能带附加标签，编辑时必须看得见，否则保存就会丢。
    this.renderExtraTagsField(conditionalArea);

    // 组 3、4：附件与时间；按钮不进组，贴在最后
    if (needsFullRebuild) {
      if (this.settings.enableAttachments) {
        const attachBody = createSection(contentEl, { title: t("cashlogModal.group.attachment") });
        this.renderAttachmentSection(attachBody);
      }
      const timeBody = createSection(contentEl, { title: t("cashlogModal.group.time") });
      this.renderDateField(timeBody);
      this.renderTimeField(timeBody);
      this.renderButtons(contentEl);
    }

    // 恢复保存的内容到 data 和 UI
    this.data.description = savedDescription;
    this.data.time = savedTime;
    this.data.date = savedDate;
    this.data.subTag = savedSubTag;
    this.data.accounts = savedAccounts;
    this.data.fromAccounts = savedFromAccounts;
    this.data.toAccounts = savedToAccounts;
    this.data.balanceChangeAccounts = savedBalanceChangeAccounts;
    this.data.attachments = savedAttachments;

    // 恢复描述输入框的值
    if (this.descInputEl) {
      this.descInputEl.value = savedDescription;
    }

    // 自动聚焦描述字段（仅首次渲染）
    if (needsFullRebuild) {
      window.setTimeout(() => {
        const descInput = contentEl.querySelector(".cashlog-desc-input") as HTMLElement;
        if (descInput) descInput.focus();
      }, 10);
    }
  }

  // 渲染类型选择器（稳定字段）
  private renderTypeFieldStable(container: HTMLElement): void {
    const wrapper = container.createDiv({ cls: "cashlog-modal-form" });
    wrapper.addClass("cashlog-type-stable");

    const setting = new Setting(wrapper).setName(t("cashlogModal.type"));
    setting.addDropdown((dropdown) => {
      dropdown.addOption("expense", t("cashlogModal.type.expense"));
      dropdown.addOption("income", t("cashlogModal.type.income"));
      if (this.settings.enableAccounts) {
        dropdown.addOption("transfer", t("cashlogModal.type.transfer"));
        dropdown.addOption("balanceChange", t("cashlogModal.type.balanceChange"));
      }
      dropdown.setValue(this.data.tagType);
      dropdown.onChange((value: "income" | "expense" | "transfer" | "balanceChange") => {
        this.data.tagType = value;
        if (value === "transfer") {
          this.data.subTag = "";
          if (this.data.fromAccounts.length === 0) {
            this.data.fromAccounts.push({ account: this.settings.accounts[0] || "", amount: "" });
          }
          if (this.data.toAccounts.length === 0) {
            this.data.toAccounts.push({ account: this.settings.accounts[1] || this.settings.accounts[0] || "", amount: "" });
          }
        }
        if (value === "balanceChange") {
          this.data.subTag = "";
          if (this.data.balanceChangeAccounts.length === 0) {
            this.data.balanceChangeAccounts.push({ account: this.settings.accounts[0] || "", amount: "" });
          }
        }
        // 增量更新：只重建条件区域
        this.buildForm();
      });
    });
  }

  // 渲染子标签
  // 子标签：按标签树逐级渲染下拉。
  // 选完一级若有子节点，就再出一级；深度不限。
  // 每级变更都重建整个表单（与类型切换一致），这样下一级能立即出现。
  private renderSubTagField(container: HTMLElement): void {
    const tree = this.getTagTree();
    if (tree.length === 0) {
      // 没有任何子标签时保留一个空下拉，避免界面突然少一行
      new Setting(container)
        .setName(t("cashlogModal.category"))
        .addDropdown((dropdown) => {
          dropdown.addOption("", t("cashlogModal.noSubTag"));
        });
      return;
    }

    // 当前路径（去掉空段），如 ["餐饮", "午餐"]
    const selected = this.data.subTag.split("/").filter((s) => s !== "");

    let nodes: TagNode[] = tree;
    let path: string[] = [];

    for (let depth = 0; depth <= selected.length; depth += 1) {
      const current = selected[depth];
      const levelPath = [...path];

      new Setting(container)
        .setName(depth === 0 ? t("cashlogModal.category") : "")
        .addDropdown((dropdown) => {
          dropdown.addOption("", t("cashlogModal.noSubTag"));
          for (const node of nodes) {
            dropdown.addOption(node.name, node.name);
          }
          // 新建入口放在列表里，和导入清单的选择器保持一致
          if (this.plugin) {
            dropdown.addOption(NEW_TAG_OPTION, t("import.picker.newOption"));
          }
          dropdown.setValue(current ?? "");
          dropdown.onChange((value) => {
            if (value === NEW_TAG_OPTION) {
              // 建在「当前这一级已选中的节点」下面；没选就建在同一层
              const parentPath = current ? [...levelPath, current] : levelPath;
              this.promptAddSubTag(parentPath);
              return;
            }
            this.data.subTag = [...levelPath, value].filter((s) => s !== "").join("/");
            // 重建表单：下一级下拉会跟着出现/消失
            this.buildForm();
          });
        });

      const node = nodes.find((n) => n.name === current);
      if (!node?.children?.length) break;
      nodes = node.children;
      path = [...path, current];
    }
  }

  // 附加标签：chips 展示，可增删。
  // 编辑时这些标签原样保留（见 createDefaultData 的 extraTags），
  // 这里只负责让用户增删，不改变已有标签的语义。
  private renderExtraTagsField(container: HTMLElement): void {
    const trees = this.settings.extraTagTrees ?? [];

    const setting = new Setting(container)
      .setName(t("cashlogModal.extraTags"))
      .setDesc(t("cashlogModal.extraTagsDesc"));

    const chips = setting.controlEl.createDiv({ cls: "cashlog-extra-tag-chips" });

    for (const tag of this.data.extraTags) {
      const chip = chips.createSpan({
        cls: "cashlog-extra-tag-chip",
        text: tag.replace(/^#/, ""),
      });
      const remove = chip.createSpan({ cls: "cashlog-extra-tag-remove", text: "×" });
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        this.data.extraTags = this.data.extraTags.filter((x) => x !== tag);
        this.buildForm();
      });
    }

    const add = chips.createSpan({ cls: "cashlog-extra-tag-add", text: "+" });
    add.addEventListener("click", (e) => {
      this.showExtraTagPicker(e, trees);
    });

    // 没有可选的副标签维度时给一句提示，而不是留一块空白
    if (trees.length === 0 && this.data.extraTags.length === 0) {
      chips.createSpan({
        cls: "cashlog-extra-tag-empty",
        text: t("cashlogModal.noExtraTags"),
      });
    }
  }

  // 选附加标签：副标签树一级维度 → 二级值
  private showExtraTagPicker(event: MouseEvent, trees: TagNode[]): void {
    const menu = new Menu();

    for (const dimension of trees) {
      menu.addItem((item) => {
        item.setTitle(dimension.name).setIcon("tag");
        const children = dimension.children ?? [];

        // 没有子标签：点维度本身就是选它，不必再套一层只有一个选项的子菜单
        if (children.length === 0) {
          item.onClick(() => {
            this.addExtraTag(`#${dimension.name}`);
          });
          return;
        }

        // obsidian.d.ts 的 MenuItem 类型未声明 setSubmenu，运行时存在，这里断言补上
        const submenu = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();

        // "/" 表示只用维度本身（#地点），不细分到子标签。
        // 之前这里显示维度名，和上一级菜单标题重复，看着像「地点 → 地点」。
        submenu.addItem((sub: MenuItem) => {
          sub.setTitle("/").onClick(() => {
            this.addExtraTag(`#${dimension.name}`);
          });
        });

        for (const child of children) {
          submenu.addItem((sub: MenuItem) => {
            sub.setTitle(child.name).onClick(() => {
              this.addExtraTag(`#${dimension.name}/${child.name}`);
            });
          });
        }
      });
    }

    if (trees.length === 0) {
      menu.addItem((item) => {
        item.setTitle(t("cashlogModal.noExtraTags")).setDisabled(true);
      });
    }

    menu.showAtMouseEvent(event);
  }

  private addExtraTag(tag: string): void {
    if (!this.data.extraTags.includes(tag)) {
      this.data.extraTags = [...this.data.extraTags, tag];
    }
    this.buildForm();
  }

  // 取当前收支类型对应的标签树
  private getTagTree(): TagNode[] {
    // 返回设置里那棵树本身的引用：写成 `?? []` 时字段为空会返回临时数组，
    // 在里面新建的标签推不进设置，保存时自然就丢了。
    if (this.data.tagType === "income") {
      this.settings.incomeTagTree ??= [];
      return this.settings.incomeTagTree;
    }
    this.settings.expenseTagTree ??= [];
    return this.settings.expenseTagTree;
  }

  /**
   * 就地新建子标签。
   * 已存在时直接跳到它（提示一句），而不是报错让用户重来 ——
   * 用户要的是「用这个标签」，是不是刚建的不重要。
   */
  private promptAddSubTag(parentPath: string[]): void {
    const plugin = this.plugin;
    if (!plugin) return;

    new PromptModal(this.app, {
      title: t("import.picker.newTagTitle"),
      placeholder: t("import.picker.newTagPlaceholder"),
      validate: (value) => {
        const check = validateTagSegment(value);
        return check.valid ? null : t(check.message ?? "tag.segment.invalidChars");
      },
      onConfirm: async (name) => {
        const tree = this.getTagTree();
        const parent = parentPath.length === 0 ? null : findNode(tree, parentPath);
        const siblings = parent ? (parent.children ?? []) : tree;

        if (siblings.some((node) => node.name === name)) {
          new Notice(t("import.picker.exists"));
        } else if (!addChild(tree, parentPath, name)) {
          throw new Error(t("tag.segment.invalidChars"));
        } else {
          // 立即落盘，避免关掉弹窗后新建的标签丢失
          await plugin.saveSettings();
        }

        this.data.subTag = [...parentPath, name].join("/");
        this.buildForm();
      },
    }).open();
  }

  // 渲染描述（条件字段）
  private renderConditionalDescription(container: HTMLElement): void {
    const setting = new Setting(container).setName(t("cashlogModal.description"));
    setting.controlEl.empty();
    setting.descEl.remove();

    this.descInputEl = setting.controlEl.createEl("input", {
      cls: "cashlog-desc-input",
      attr: {
        type: "text",
        placeholder: this.data.tagType === "transfer" ? t("cashlogModal.placeholder.transferDesc") : t("cashlogModal.placeholder.expenseDesc"),
        value: this.data.description,
      },
    });

    this.descInputEl.addEventListener("input", () => {
      if (this.descInputEl) this.data.description = this.descInputEl.value;
    });

    this.descInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        // 与「确认」按钮走同一条提交路径，避免绕过校验与附件处理
        void this.submit();
      }
    });
  }

  // 渲染金额字段
  private renderAmountField(container: HTMLElement): void {
    const amt = this.data.accounts[0]?.amount || "";
    const setting = new Setting(container)
      .setName(t("cashlogModal.amount"))
      .setDesc(t("cashlogModal.amountDesc"));

    setting.controlEl.empty();
    const wrapper = setting.controlEl.createDiv({ cls: "cashlog-field-row" });
    wrapper.createSpan({ cls: "cashlog-amount-icon", text: "💴" });

    const input = wrapper.createEl("input", {
      cls: "cashlog-field-input",
      attr: {
        type: "number",
        placeholder: "100",
        step: "0.01",
        min: "0",
        value: amt,
      },
    });
    input.addEventListener("input", () => {
      if (this.data.accounts.length === 0) {
        this.data.accounts.push({ account: "", amount: "" });
      }
      this.data.accounts[0].amount = input.value;
    });
  }

  // 收入/支出的账户行
  private renderAccountRows(container: HTMLElement): void {
    const section = container.createDiv({ cls: "cashlog-account-section" });
    new Setting(section).setName(t("cashlogModal.account")).setDesc(t("cashlogModal.accountDesc"));

    const listEl = section.createDiv({ cls: "cashlog-account-list" });

    // 渲染所有账户行
    for (let i = 0; i < this.data.accounts.length; i++) {
      this.renderAccountRow(listEl, i);
    }

    // + 添加账户按钮
    const addBtn = section.createEl("button", {
      cls: "cashlog-account-add-btn",
      text: t("cashlogModal.addAccount"),
    });
    addBtn.addEventListener("click", () => {
      // 默认选第一个可用账户
      const usedAccounts = new Set(this.data.accounts.map((a) => a.account));
      const available = this.settings.accounts.find((a) => !usedAccounts.has(a));
      this.data.accounts.push({ account: available || "", amount: "" });
      this.buildForm();
    });
  }

  // 渲染单个账户行
  private renderAccountRow(listEl: HTMLElement, index: number): void {
    const row = listEl.createDiv({ cls: "cashlog-account-row" });
    const item = this.data.accounts[index];

    // 账户下拉
    const select = row.createEl("select", { cls: "cashlog-account-select" });
    const noAcctOpt = select.createEl("option", { text: t("cashlogModal.noAccount"), value: "" });
    for (const acct of this.settings.accounts) {
      const opt = select.createEl("option", { text: acct, value: acct });
      if (item.account === acct) opt.selected = true;
    }
    if (item.account === "") noAcctOpt.selected = true;

    select.addEventListener("change", () => {
      this.data.accounts[index].account = select.value;
    });

    // 金额输入
    const amountInput = row.createEl("input", {
      cls: "cashlog-account-amount",
      attr: {
        type: "number",
        placeholder: t("cashlogModal.amount"),
        step: "0.01",
        min: "0",
        value: item.amount,
      },
    });
    amountInput.addEventListener("input", () => {
      this.data.accounts[index].amount = amountInput.value;
    });

    // - 删除按钮（多于一行时显示）
    if (this.data.accounts.length > 1) {
      const removeBtn = row.createEl("button", {
        cls: "cashlog-account-remove-btn",
        text: t("cashlogModal.remove"),
      });
      removeBtn.addEventListener("click", () => {
        this.data.accounts.splice(index, 1);
        this.buildForm();
      });
    }
  }

  // 转账字段
  private renderTransferFields(container: HTMLElement): void {
    // 转出账户
    const fromSection = container.createDiv({ cls: "cashlog-account-section" });
    new Setting(fromSection).setName(t("cashlogModal.fromAccount"));

    const fromList = fromSection.createDiv({ cls: "cashlog-account-list" });
    for (let i = 0; i < this.data.fromAccounts.length; i++) {
      this.renderTransferRow(fromList, "from", i);
    }

    const addFromBtn = fromSection.createEl("button", {
      cls: "cashlog-account-add-btn",
      text: t("cashlogModal.addFromAccount"),
    });
    addFromBtn.addEventListener("click", () => {
      this.data.fromAccounts.push({ account: this.settings.accounts[0] || "", amount: "" });
      this.buildForm();
    });

    // 转入账户
    const toSection = container.createDiv({ cls: "cashlog-account-section" });
    new Setting(toSection).setName(t("cashlogModal.toAccount"));

    const toList = toSection.createDiv({ cls: "cashlog-account-list cashlog-transfer-to" });
    for (let i = 0; i < this.data.toAccounts.length; i++) {
      this.renderTransferRow(toList, "to", i);
    }

    const addToBtn = toSection.createEl("button", {
      cls: "cashlog-account-add-btn",
      text: t("cashlogModal.addToAccount"),
    });
    addToBtn.addEventListener("click", () => {
      this.data.toAccounts.push({ account: this.settings.accounts[0] || "", amount: "" });
      this.buildForm();
    });
  }

  // 渲染转账账户行
  private renderTransferRow(listEl: HTMLElement, direction: "from" | "to", index: number): void {
    const row = listEl.createDiv({ cls: "cashlog-account-row" });
    const items = direction === "from" ? this.data.fromAccounts : this.data.toAccounts;
    const item = items[index];

    // 账户下拉
    const select = row.createEl("select", { cls: "cashlog-account-select" });
    for (const acct of this.settings.accounts) {
      const opt = select.createEl("option", { text: acct, value: acct });
      if (item.account === acct) opt.selected = true;
    }

    select.addEventListener("change", () => {
      item.account = select.value;
    });

    // 金额输入
    const amountInput = row.createEl("input", {
      cls: "cashlog-account-amount",
      attr: {
        type: "number",
        placeholder: t("cashlogModal.amount"),
        step: "0.01",
        min: "0",
        value: item.amount,
      },
    });
    amountInput.addEventListener("input", () => {
      item.amount = amountInput.value;
    });
    // 失焦时同步转出总额到转入账户（仅一个转入账户时）
    if (direction === "from") {
      amountInput.addEventListener("blur", () => {
        if (this.data.toAccounts.length === 1) {
          const sum = this.data.fromAccounts.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
          const syncValue = sum.toString() || "";
          this.data.toAccounts[0].amount = syncValue;
          // 直接更新转入金额输入框的 DOM
          const toInputs = listEl.closest(".cashlog-modal")?.querySelectorAll(".cashlog-transfer-to .cashlog-account-amount") as NodeListOf<HTMLInputElement>;
          if (toInputs && toInputs.length > 0) {
            toInputs[0].value = syncValue;
          }
        }
      });
    }

    // - 删除按钮
    const list = direction === "from" ? this.data.fromAccounts : this.data.toAccounts;
    if (list.length > 1) {
      const removeBtn = row.createEl("button", {
        cls: "cashlog-account-remove-btn",
        text: t("cashlogModal.remove"),
      });
      removeBtn.addEventListener("click", () => {
        list.splice(index, 1);
        this.buildForm();
      });
    }
  }

  // 余额变更字段
  private renderBalanceChangeFields(container: HTMLElement): void {
    const section = container.createDiv({ cls: "cashlog-account-section" });
    new Setting(section).setName(t("cashlogModal.balanceChange")).setDesc(t("cashlogModal.balanceChangeDesc"));

    const listEl = section.createDiv({ cls: "cashlog-account-list" });

    // 提前计算一次余额，避免每行重复遍历全部条目
    let balances: Record<string, number> = {};
    if (this.plugin?.cache) {
      balances = AccountManager.recomputeBalances(
        this.plugin.cache.getEntries(),
        this.settings.accountBalances,
        this.settings.accounts,
        // 编辑既有条目时排除它自身，否则提示的“当前余额”会把旧 delta 算进去
        this.entry?.location ?? null,
      );
    }

    for (let i = 0; i < this.data.balanceChangeAccounts.length; i++) {
      this.renderBalanceChangeRow(listEl, i, balances);
    }

    const addBtn = section.createEl("button", {
      cls: "cashlog-account-add-btn",
      text: t("cashlogModal.addAccount"),
    });
    addBtn.addEventListener("click", () => {
      const usedAccounts = new Set(this.data.balanceChangeAccounts.map((a) => a.account));
      const available = this.settings.accounts.find((a) => !usedAccounts.has(a));
      this.data.balanceChangeAccounts.push({ account: available || "", amount: "" });
      this.buildForm();
    });
  }

  // 「当前余额」提示文案（货币符号随当前语言变化，避免英文界面显示字面量 {currency}）
  private formatCurrentBalance(balance: number): string {
    return tp("cashlogModal.currentBalance", {
      amount: balance.toFixed(2),
      currency: getCurrencySymbol(),
    });
  }

  // 渲染余额变更单行（balances 由父方法预计算传入）
  private renderBalanceChangeRow(listEl: HTMLElement, index: number, balances: Record<string, number>): void {
    const row = listEl.createDiv({ cls: "cashlog-account-row" });
    const item = this.data.balanceChangeAccounts[index];

    // 账户下拉
    const select = row.createEl("select", { cls: "cashlog-account-select" });
    for (const acct of this.settings.accounts) {
      const opt = select.createEl("option", { text: acct, value: acct });
      if (item.account === acct) opt.selected = true;
    }

    // 当前余额提示（使用预计算的余额）
    const balanceHint = row.createSpan({
      cls: "cashlog-balance-hint",
      text: this.formatCurrentBalance(balances[item.account] || 0),
    });

    select.addEventListener("change", () => {
      this.data.balanceChangeAccounts[index].account = select.value;
      balanceHint.textContent = this.formatCurrentBalance(balances[select.value] || 0);
    });

    // 目标余额输入
    const amountInput = row.createEl("input", {
      cls: "cashlog-account-amount",
      attr: {
        type: "number",
        placeholder: t("cashlogModal.adjustedBalance"),
        step: "0.01",
        value: item.amount,
      },
    });
    amountInput.addEventListener("input", () => {
      this.data.balanceChangeAccounts[index].amount = amountInput.value;
    });

    // 删除按钮（多于一行时显示）
    if (this.data.balanceChangeAccounts.length > 1) {
      const removeBtn = row.createEl("button", {
        cls: "cashlog-account-remove-btn",
        text: t("cashlogModal.remove"),
      });
      removeBtn.addEventListener("click", () => {
        this.data.balanceChangeAccounts.splice(index, 1);
        this.buildForm();
      });
    }
  }

  // 附件区域
  private renderAttachmentSection(container: HTMLElement): void {
    const setting = new Setting(container)
      .setName(t("cashlogModal.attachment"))
      .setDesc(t("cashlogModal.attachmentDesc"));

    setting.controlEl.empty();
    const attContainer = setting.controlEl.createDiv({ cls: "cashlog-attachment-area" });

    const listEl = attContainer.createDiv({ cls: "cashlog-attachment-list" });
    this.renderAttachmentList(listEl);

    const btnRow = attContainer.createDiv({ cls: "cashlog-attachment-btns" });

    const fileInput = attContainer.createEl("input", {
      cls: "cashlog-file-input",
      attr: { type: "file", accept: "image/*", multiple: "multiple" },
    });
    fileInput.addClass("cashlog-hidden");
    this.fileInputEl = fileInput;

    fileInput.addEventListener("change", () => {
      if (fileInput.files) {
        for (let i = 0; i < fileInput.files.length; i++) {
          const file = fileInput.files[i];
          if (!file.type.startsWith("image/")) {
            new Notice(t("notice.imageOnly"));
            continue;
          }
          const tempId = `__pending_${this.pendingIdCounter++}`;
          this.pendingUploads.push({ file, tempId });
          const num = this.data.attachments.length + 1;
          this.data.attachments.push(`${tempId}|${tp("attachment.numberedName", { n: num })}`);
        }
        this.renumberAttachments();
        this.renderAttachmentList(listEl);
        fileInput.value = "";
      }
    });

    const addBtn = btnRow.createEl("button", {
      cls: "cashlog-attachment-add-btn",
      text: t("cashlogModal.addAttachment"),
    });
    addBtn.addEventListener("click", () => {
      fileInput.click();
    });
  }

  // 重排附件的显示名。
  // 只重排「自动生成的编号名」，用户自定义的显示名必须保留 ——
  // 旧实现每次增删都把显示名覆写为「附件N」，自定义名会被无条件丢弃。
  private renumberAttachments(): void {
    const total = this.data.attachments.length;
    const isAutoName = (name: string | undefined): boolean => {
      if (!name) return true;
      for (let n = 1; n <= total + 1; n++) {
        if (name === tp("attachment.numberedName", { n })) return true;
      }
      return false;
    };
    for (let i = 0; i < total; i++) {
      const [fileName, displayName] = this.data.attachments[i].split("|");
      if (isAutoName(displayName)) {
        this.data.attachments[i] = `${fileName}|${tp("attachment.numberedName", { n: i + 1 })}`;
      }
    }
  }

  // 确认时批量处理附件：上传待上传的、删除待删除的
  private async processAttachments(): Promise<void> {
    const attManager = new AttachmentManager(this.app, this.app.vault, this.settings);

    // 上传待上传文件，用真实文件名替换 tempId
    for (const { file, tempId } of this.pendingUploads) {
      try {
        const attStr = await attManager.saveAttachment(file);
        const [realName] = attStr.split("|");
        for (let i = 0; i < this.data.attachments.length; i++) {
          if (this.data.attachments[i].startsWith(tempId + "|")) {
            const displayPart = this.data.attachments[i].split("|")[1] || t("attachment.defaultName");
            this.data.attachments[i] = `${realName}|${displayPart}`;
            break;
          }
        }
      } catch (e) {
        console.error("附件上传失败:", e);
        new Notice(t("notice.uploadFailed"));
        // 上传失败时移除临时引用，避免把 __pending_N 这样的内部 id 写进 Markdown
        this.data.attachments = this.data.attachments.filter(
          (att) => !att.startsWith(`${tempId}|`),
        );
      }
    }

    // 删除标记的已有附件；仍被其它条目引用的文件只解除引用，不删文件本体
    for (const fileName of this.pendingDeletions) {
      if (this.isAttachmentReferencedElsewhere(fileName)) continue;
      try {
        await attManager.deleteAttachment(fileName);
      } catch (e) {
        console.error("附件删除失败:", e);
      }
    }

    this.renumberAttachments();
  }

  // 该附件是否仍被其它条目引用。
  // 删除附件时若直接 trashFile，会破坏其它条目对同一文件的引用（留下坏链），
  // 因此仅在没有任何其它条目引用时才删除文件本体。
  private isAttachmentReferencedElsewhere(fileName: string): boolean {
    const entries = this.plugin?.cache?.getEntries() ?? [];
    const selfLocation = this.entry?.location ?? null;
    return entries.some(
      (entry) =>
        entry.attachments.some((att) => att.split("|")[0] === fileName) &&
        !AccountManager.isSameLocation(entry, selfLocation),
    );
  }

  private renderAttachmentList(listEl: HTMLElement): void {
    listEl.empty();
    for (let i = 0; i < this.data.attachments.length; i++) {
      const att = this.data.attachments[i];
      const item = listEl.createDiv({ cls: "cashlog-attachment-item" });
      const [fileName, displayName] = att.includes("|") ? att.split("|") : [att, att];
      const isPending = fileName.startsWith("__pending_");

      const label = item.createSpan({ text: `🧷 ${displayName}` });
      if (isPending) {
        label.addClass("cashlog-field-disabled");
        label.setAttr("title", t("cashlogModal.pending"));
      }

      const removeBtn = item.createEl("button", {
        cls: "cashlog-attachment-remove",
        text: t("cashlogModal.remove"),
      });
      const idx = i;
      removeBtn.addEventListener("click", () => {
        if (isPending) {
          this.pendingUploads = this.pendingUploads.filter((p) => p.tempId !== fileName);
        } else {
          this.pendingDeletions.push(fileName);
        }
        this.data.attachments.splice(idx, 1);
        this.renumberAttachments();
        this.renderAttachmentList(listEl);
      });
    }
  }

  // 日期
  private renderDateField(container: HTMLElement): void {
    const setting = new Setting(container).setName(t("cashlogModal.date"));
    setting.controlEl.empty();
    const wrapper = setting.controlEl.createDiv({ cls: "cashlog-field-row-icon" });

    const dateInput = wrapper.createEl("input", {
      cls: "cashlog-field-input cashlog-field-input-icon",
      attr: { type: "date", value: this.data.date },
    });

    const calendarBtn = wrapper.createEl("button", {
      cls: "cashlog-icon-btn-inner",
      attr: { type: "button", title: t("cashlogModal.selectDate") },
    });
    calendarBtn.createSvg("svg", { attr: { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } }, (calSvg) => {
      calSvg.createSvg("rect", { attr: { x: "3", y: "4", width: "18", height: "18", rx: "2", ry: "2" } });
      for (const [x1, y1, x2, y2] of [["16","2","16","6"],["8","2","8","6"],["3","10","21","10"]]) {
        calSvg.createSvg("line", { attr: { x1, y1, x2, y2 } });
      }
    });
    calendarBtn.addEventListener("click", () => {
      (dateInput as HTMLInputElement & { showPicker: () => void }).showPicker();
    });
    dateInput.addEventListener("change", () => {
      this.data.date = dateInput.value;
    });
  }

  // 时间
  private renderTimeField(container: HTMLElement): void {
    const setting = new Setting(container).setName(t("cashlogModal.time")).setDesc(t("cashlogModal.timeDesc"));
    setting.controlEl.empty();
    const wrapper = setting.controlEl.createDiv({ cls: "cashlog-field-row-icon" });

    const timeInput = wrapper.createEl("input", {
      cls: "cashlog-field-input cashlog-field-input-icon",
      attr: { type: "time", value: this.data.time || "" },
    });

    const clockBtn = wrapper.createEl("button", {
      cls: "cashlog-icon-btn-inner",
      attr: { type: "button", title: t("cashlogModal.selectTime") },
    });
    clockBtn.createSvg("svg", { attr: { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } }, (clkSvg) => {
      clkSvg.createSvg("circle", { attr: { cx: "12", cy: "12", r: "10" } });
      clkSvg.createSvg("polyline", { attr: { points: "12 6 12 12 16 14" } });
    });
    clockBtn.addEventListener("click", () => {
      (timeInput as HTMLInputElement & { showPicker: () => void }).showPicker();
    });
    timeInput.addEventListener("change", () => {
      this.data.time = timeInput.value;
    });
  }

  // 防止重复提交（回车连按 / 回车与按钮同时触发）
  private submitting = false;

  // 统一提交入口：确认按钮与描述框回车都必须走这里，
  // 否则会绕过校验与附件处理（临时附件 id 会被直接写进 Markdown）。
  private async submit(): Promise<void> {
    if (this.submitting) return;

    const validationError = validateEntryData(this.data);
    if (validationError) {
      new Notice(validationError);
      return;
    }

    this.submitting = true;
    try {
      await this.processAttachments();
    } finally {
      this.submitting = false;
    }

    this.close();
    this.onSubmit(this.data);
  }

  // 渲染按钮
  private renderButtons(container: HTMLElement): void {
    new Setting(container)
      .addButton((btn) =>
        btn.setButtonText(t("modal.button.confirm")).setCta().onClick(async () => {
          await this.submit();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t("modal.button.cancel")).onClick(() => {
          this.close();
        }),
      );
  }

  // 填充子标签（合并 settings 和缓存中发现的子标签）
  private populateSubTags(dropdown: { addOption: (value: string, display: string) => void; setValue: (value: string) => void }): void {
    dropdown.addOption("", t("cashlogModal.noSubTag"));
    const baseTag = this.data.tagType === "income"
      ? this.settings.incomeTag
      : this.settings.expenseTag;
    const subTags = this.data.tagType === "income"
      ? [...this.settings.incomeSubTags]
      : [...this.settings.expenseSubTags];

    // 合并缓存中发现的子标签
    if (this.plugin?.cache) {
      const allEntries = this.plugin.cache.getEntries();
      const baseLower = baseTag.toLowerCase();
      for (const entry of allEntries) {
        for (const tag of entry.tags) {
          if (tag.toLowerCase().startsWith(baseLower + "/")) {
            // 保留完整子标签（含二级，如 "餐饮/午餐"），不再截断到一级
            const sub = tag.substring(baseTag.length + 1);
            if (!subTags.includes(sub)) {
              subTags.push(sub);
            }
          }
        }
      }
    }

    for (const tag of subTags) {
      dropdown.addOption(tag, tag);
    }
    if (this.data.subTag) {
      dropdown.setValue(this.data.subTag);
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
