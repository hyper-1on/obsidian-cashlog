// 通用 · 级联标签选择器
//
// 结构：先选大类别（支出 / 收入），再逐级选子标签，任意深度都可以停；
// 只选大类别也有效（记成 #支出），与记账表单一致。
//
// 两个可选的扩展点，由调用方决定是否提供：
// - onCreate：每级右侧出现「＋」，就地新建标签。传了才显示。
// - onManage：底部出现「管理所有标签…」，打开完整的树管理。传了才显示。
//   两者都不传时，选择器就是纯只读的选值控件。
//
// 按钮语义：
//   清除 = 只清空当前选择，窗口留着
//   取消 = 关闭且不改变原值
//   确定 = 应用当前选择并关闭

import { App, Modal, Notice } from "obsidian";
import { t, tp } from "../i18n";
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
      createModalButton(t("modal.button.cancel"), "secondary", () => {
        this.close();
      }),
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
    const rootSelect = this.createSelect(
      rootRow,
      [
        { value: "", label: "—" },
        ...this.options.roots.map((root, i) => ({
          value: String(i),
          label: root.label ?? parseTagText(root.mainTag),
        })),
      ],
      this.rootIndex === NO_ROOT ? "" : String(this.rootIndex),
    );
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
    let level: TagNode[] = root.tree ?? [];
    let index = 0;

    while (level.length > 0 || this.addingAt === index) {
      const nodes = level;
      const levelIndex = index;
      const row = this.createRow("");

      if (this.addingAt === levelIndex) {
        this.renderInlineAdd(row, root, this.selections.slice(0, levelIndex), nodes);
        this.pickerHost.createDiv({
          cls: "cashlog-tag-picker-current",
          text: this.currentTag() ?? t("import.picker.unset"),
        });
        return;
      }

      const select = this.createSelect(
        row,
        [{ value: "", label: "—" }, ...nodes.map((n) => ({ value: n.name, label: n.name }))],
        this.selections[levelIndex] ?? "",
      );
      select.addEventListener("change", () => {
        this.selections = this.selections.slice(0, levelIndex);
        if (select.value !== "") this.selections.push(select.value);
        this.addingAt = null;
        this.renderLevels();
      });

      // 每级右侧一个「＋」：新建的是这一级的下一层
      if (this.options.onCreate) {
        const addBtn = row.createSpan({ cls: "cashlog-tag-picker-add", text: "+" });
        addBtn.setAttribute("aria-label", t("import.picker.addChild"));
        addBtn.addEventListener("click", () => {
          this.addingAt = levelIndex + 1;
          this.renderLevels();
        });
      }

      const chosen = this.selections[levelIndex];
      const node = nodes.find((n) => n.name === chosen);
      if (!node?.children?.length) break;

      level = node.children;
      index++;
    }

    // 末端还有一个「＋」，用于在第一级为空时也能建
    if (this.options.onCreate && this.addingAt === null) {
      const tailRow = this.createRow("");
      const addBtn = tailRow.createSpan({ cls: "cashlog-tag-picker-add", text: "+" });
      addBtn.setAttribute("aria-label", t("import.picker.addChild"));
      addBtn.addEventListener("click", () => {
        this.addingAt = this.selections.length;
        this.renderLevels();
      });
    }

    this.pickerHost.createDiv({
      cls: "cashlog-tag-picker-current",
      text: this.currentTag() ?? t("import.picker.unset"),
    });
  }

  /** 行内新建：输入框 + 确定/取消，不另开弹窗。 */
  private renderInlineAdd(
    row: HTMLElement,
    root: TagPickerRoot,
    parentPath: string[],
    siblings: TagNode[],
  ): void {
    const input = row.createEl("input", { cls: "cashlog-tag-picker-input" });
    input.setAttribute("placeholder", t("import.picker.newTagPlaceholder"));
    input.focus();

    const commit = async (): Promise<void> => {
      const name = input.value.trim();
      if (name === "") {
        this.addingAt = null;
        this.renderLevels();
        return;
      }

      const result = await this.options.onCreate?.(root, parentPath, name);
      this.addingAt = null;

      if (result === "invalid") {
        this.renderLevels();
        return;
      }
      if (result === "exists") {
        // 已存在：提示一句并跳到那个已有节点，而不是报错让人重来
        new Notice(t("import.picker.exists"));
        this.selections = [...parentPath, name];
        this.renderLevels();
        return;
      }

      // 新建成功：自动选中它，因为建它就是为了用它
      this.selections = [...parentPath, name];
      this.renderLevels();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.addingAt = null;
        this.renderLevels();
      }
    });

    const ok = row.createSpan({ cls: "cashlog-tag-picker-add", text: "✓" });
    ok.addEventListener("click", () => void commit());
    const cancel = row.createSpan({ cls: "cashlog-tag-picker-add", text: "×" });
    cancel.addEventListener("click", () => {
      this.addingAt = null;
      this.renderLevels();
    });

    // 避免 siblings 未使用告警，同时为将来「重名时高亮已有节点」留引用
    void siblings;
  }

  private createRow(label: string): HTMLElement {
    const row = this.pickerHost.createDiv({ cls: "cashlog-tag-picker-row" });
    row.createSpan({ cls: "cashlog-tag-picker-label", text: label });
    return row;
  }

  private createSelect(
    host: HTMLElement,
    options: Array<{ value: string; label: string }>,
    current: string,
  ): HTMLSelectElement {
    const select = host.createEl("select", { cls: "dropdown cashlog-tag-picker-select" });
    for (const opt of options) {
      const el = select.createEl("option", { text: opt.label });
      el.value = opt.value;
    }
    select.value = current;
    return select;
  }
}
