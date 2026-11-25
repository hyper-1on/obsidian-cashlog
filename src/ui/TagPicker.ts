// 通用 · 级联标签选择器
//
// 结构：先选大类别（支出 / 收入），再逐级选子标签，任意深度都可以停；
// 只选大类别也有效（记成 #支出），与记账表单一致。
//
// 新建标签的方式：每一级的下拉列表底部有一项「＋ 新建…」。
// 之所以不做成旁边的 ＋ 按钮 —— 用户是"在下拉里找标签，没找到才要建"，
// 入口放在下拉里才符合这个顺序；之前做成按钮时还会因为重渲染出现两个 ＋。
//
// 按钮语义：
//   清除 = 只清空当前选择，窗口留着
//   取消 = 关闭且不改变原值
//   确定 = 应用当前选择并关闭

import { App, Modal, Notice } from "obsidian";
import { t } from "../i18n";
import type { TagNode } from "../TagTree";
import { parseTagText } from "../TagTree";
import { createModalButton, createModalButtonRow } from "../ModalHelpers";

/** 一个可选的大类别及其标签树。tree 必须是设置里那棵树的引用，新建才能写回。 */
export interface TagPickerRoot {
  /** 完整主标签，如 "#支出" */
  mainTag: string;
  /** 展示名，如 "支出"；省略时用主标签去掉 # */
  label?: string;
  /** 该主标签下的标签树（引用，就地修改后由调用方保存） */
  tree: TagNode[];
}

/** 新建结果。exists 时选择器会跳到那个已有节点。 */
export type CreateResult = "created" | "exists" | "invalid";

export interface TagPickerOptions {
  roots: TagPickerRoot[];
  current: string | null;
  allowClear?: boolean;
  onPick: (tag: string | null) => void;
  /**
   * 就地新建标签。parentPath 是相对大类别根的子路径，空数组表示建在根下。
   * 返回 created 时自动选中新标签；返回 exists 时提示并跳到已有节点。
   */
  onCreate?: (root: TagPickerRoot, parentPath: string[], name: string) => Promise<CreateResult>;
  /** 打开完整的标签管理界面 */
  onManage?: () => void;
}

const NO_ROOT = -1;
/** 下拉里「新建」那一项的哨兵值，不可能与真实标签名冲突（标签名不许含斜杠） */
const NEW_OPTION = "\u0000new";

export class TagPickerModal extends Modal {
  private readonly options: TagPickerOptions;

  private rootIndex: number = NO_ROOT;
  private selections: string[] = [];

  /** 正在新建的层级下标；null 表示没在新建 */
  private addingAt: number | null = null;

  private pickerHost!: HTMLElement;

  constructor(app: App, options: TagPickerOptions) {
    super(app);
    this.options = options;
    this.restoreFromCurrent();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cashlog-tag-picker-modal");
    this.titleEl.setText(t("import.picker.title"));

    this.pickerHost = contentEl.createDiv({ cls: "cashlog-tag-picker-body" });
    this.renderLevels();

    const btnRow = createModalButtonRow(contentEl);

    if (this.options.onManage) {
      btnRow.appendChild(
        createModalButton(t("import.picker.manage"), "secondary", () => {
          // 关掉选择器再开管理：两个 Modal 叠着会让层级和焦点混乱
          this.close();
          this.options.onManage?.();
        }),
      );
    }

    if (this.options.allowClear !== false) {
      btnRow.appendChild(
        createModalButton(t("import.picker.clear"), "secondary", () => {
          this.rootIndex = NO_ROOT;
          this.selections = [];
          this.addingAt = null;
          this.renderLevels();
        }),
      );
    }

    btnRow.appendChild(
      createModalButton(t("modal.button.cancel"), "secondary", () => this.close()),
    );

    btnRow.appendChild(
      createModalButton(t("import.picker.confirm"), "primary", () => {
        this.options.onPick(this.currentTag());
        this.close();
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** 当前选中的完整标签；只选大类别时返回主标签本身。 */
  currentTag(): string | null {
    if (this.rootIndex === NO_ROOT) return null;
    const root = this.options.roots[this.rootIndex];
    if (!root) return null;
    if (this.selections.length === 0) return root.mainTag;
    return `${root.mainTag}/${this.selections.join("/")}`;
  }

  private restoreFromCurrent(): void {
    const current = this.options.current;
    if (!current) return;

    const plain = parseTagText(current);
    for (let i = 0; i < this.options.roots.length; i++) {
      const mainPlain = parseTagText(this.options.roots[i].mainTag);
      if (plain === mainPlain) {
        this.rootIndex = i;
        this.selections = [];
        return;
      }
      if (plain.startsWith(`${mainPlain}/`)) {
        this.rootIndex = i;
        this.selections = plain
          .slice(mainPlain.length + 1)
          .split("/")
          .filter((s) => s !== "");
        return;
      }
    }
  }

  private renderLevels(): void {
    this.pickerHost.empty();

    // 第一级：大类别
    const rootRow = this.createRow(t("cashlogModal.category"));
    const rootSelect = rootRow.createEl("select", {
      cls: "dropdown cashlog-tag-picker-select",
    });
    rootSelect.createEl("option", { text: "—" }).value = "";
    this.options.roots.forEach((root, i) => {
      const opt = rootSelect.createEl("option", {
        text: root.label ?? parseTagText(root.mainTag),
      });
      opt.value = String(i);
    });
    rootSelect.value = this.rootIndex === NO_ROOT ? "" : String(this.rootIndex);
    rootSelect.addEventListener("change", () => {
      this.rootIndex = rootSelect.value === "" ? NO_ROOT : Number(rootSelect.value);
      this.selections = [];
      this.addingAt = null;
      this.renderLevels();
    });

    if (this.rootIndex === NO_ROOT) {
      this.pickerHost.createDiv({
        cls: "cashlog-tag-picker-current",
        text: t("import.picker.pickRootFirst"),
      });
      return;
    }

    const root = this.options.roots[this.rootIndex];
    let nodes: TagNode[] = root.tree ?? [];
    let levelIndex = 0;

    // 逐级渲染。即使这一层没有任何节点也要渲染一行 ——
    // 否则空树时整个界面只剩大类别，用户没有地方点「新建」。
    for (;;) {
      const row = this.createRow("");

      if (this.addingAt === levelIndex) {
        this.renderInlineAdd(row, root, this.selections.slice(0, levelIndex));
        break;
      }

      const select = row.createEl("select", {
        cls: "dropdown cashlog-tag-picker-select",
      });
      select.createEl("option", { text: t("cashlogModal.noSubTag") }).value = "";
      for (const node of nodes) {
        select.createEl("option", { text: node.name }).value = node.name;
      }
      // 新建入口就放在列表里：找不着才要建，顺序天然正确
      if (this.options.onCreate) {
        select.createEl("option", { text: t("import.picker.newOption") }).value = NEW_OPTION;
      }
      select.value = this.selections[levelIndex] ?? "";

      select.addEventListener("change", () => {
        if (select.value === NEW_OPTION) {
          // 回到这一层，改成输入框
          this.addingAt = levelIndex;
          this.selections = this.selections.slice(0, levelIndex);
          this.renderLevels();
          return;
        }
        this.selections = this.selections.slice(0, levelIndex);
        if (select.value !== "") this.selections.push(select.value);
        this.addingAt = null;
        this.renderLevels();
      });

      const chosen = this.selections[levelIndex];
      const node = nodes.find((n) => n.name === chosen);
      if (!node?.children?.length) break;

      nodes = node.children;
      levelIndex++;
    }

    this.pickerHost.createDiv({
      cls: "cashlog-tag-picker-current",
      text: this.currentTag() ?? t("import.picker.unset"),
    });
  }

  /** 行内新建：标准文本输入框，回车确认、Esc 取消。 */
  private renderInlineAdd(
    row: HTMLElement,
    root: TagPickerRoot,
    parentPath: string[],
  ): void {
    const input = row.createEl("input", {
      cls: "cashlog-tag-picker-input",
      attr: { type: "text", placeholder: t("import.picker.newTagPlaceholder") },
    });
    input.focus();

    const cancel = (): void => {
      this.addingAt = null;
      this.renderLevels();
    };

    const commit = async (): Promise<void> => {
      const name = input.value.trim();
      if (name === "") {
        cancel();
        return;
      }

      const result = await this.options.onCreate?.(root, parentPath, name);
      this.addingAt = null;

      if (result === "invalid") {
        // onCreate 已经提示过原因，退回下拉让用户重选
        this.renderLevels();
        return;
      }
      if (result === "exists") {
        // 已存在：提示一句并跳到那个已有节点，而不是报错让人重来
        new Notice(t("import.picker.exists"));
      }

      // 新建成功或已存在，都选中它 —— 用户要的是这个标签
      this.selections = [...parentPath, name];
      this.renderLevels();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
  }

  private createRow(label: string): HTMLElement {
    const row = this.pickerHost.createDiv({ cls: "cashlog-tag-picker-row" });
    row.createSpan({ cls: "cashlog-tag-picker-label", text: label });
    return row;
  }
}
