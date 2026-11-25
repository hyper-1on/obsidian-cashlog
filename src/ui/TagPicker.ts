// 通用 · 级联标签选择器
//
// 结构：先选大类别（支出 / 收入），再逐级选子标签，任意深度都可以停。
// 之所以把「大类别」也做成第一级，是因为导入清单里的分组可能同时包含
// 收入和支出条目 —— 固定成某一个会悄悄把另一类选错。
//
// 三个按钮的语义要分清：
//   清除 = 只清空当前选择，窗口留着，让你重新选
//   取消 = 关闭且不改变原值
//   确定 = 应用当前选择并关闭
// 之前「清除」和「取消」是同一个行为，用户没法只清空重选。

import { App, Modal } from "obsidian";
import { t, tp } from "../i18n";
import type { TagNode } from "../TagTree";
import { parseTagText } from "../TagTree";
import { createModalButton, createModalButtonRow } from "../ModalHelpers";

/** 一个可选的大类别及其标签树。 */
export interface TagPickerRoot {
  /** 完整主标签，如 "#支出" */
  mainTag: string;
  /** 展示名，如 "支出"；省略时用主标签去掉 # */
  label?: string;
  /** 该主标签下的标签树 */
  tree: TagNode[];
}

export interface TagPickerOptions {
  /** 可选的大类别列表；通常传支出树与收入树两项 */
  roots: TagPickerRoot[];
  /** 当前值，形如 "#支出/餐饮/午餐" */
  current: string | null;
  /** 是否允许清空为「未指定」，默认允许 */
  allowClear?: boolean;
  /** 选定后回调；清空时传 null */
  onPick: (tag: string | null) => void;
}

const NO_ROOT = -1;

export class TagPickerModal extends Modal {
  private readonly options: TagPickerOptions;

  /** 选中的大类别下标；NO_ROOT 表示还没选 */
  private rootIndex: number = NO_ROOT;
  /** 各级子标签名 */
  private selections: string[] = [];

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

    if (this.options.allowClear !== false) {
      btnRow.appendChild(
        createModalButton(t("import.picker.clear"), "secondary", () => {
          // 只清空选择，不关窗：清除之后通常还要重新选一个
          this.rootIndex = NO_ROOT;
          this.selections = [];
          this.renderLevels();
        }),
      );
    }

    btnRow.appendChild(
      createModalButton(t("modal.button.cancel"), "secondary", () => {
        // 不调用 onPick，保持原值
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

  /** 当前选中的完整标签；一级都没选时返回 null。 */
  currentTag(): string | null {
    if (this.rootIndex === NO_ROOT) return null;
    const root = this.options.roots[this.rootIndex];
    if (!root) return null;
    // 只选大类别也是有效值：记账界面允许只写「支出」，这里保持一致
    if (this.selections.length === 0) return root.mainTag;
    return `${root.mainTag}/${this.selections.join("/")}`;
  }

  /** 一行：左侧固定宽标签 + 右侧撑满的下拉。 */
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

  /** 从当前值反推大类别与各级选择，便于再次编辑时回显。 */
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

  /** 渲染大类别下拉 + 各级子标签下拉。 */
  private renderLevels(): void {
    this.pickerHost.empty();

    // 第一级：大类别
    const rootRow = this.createRow(t("cashlogModal.category"));
    const rootSelect = this.createSelect(rootRow, [
      { value: "", label: "—" },
      ...this.options.roots.map((root, i) => ({
        value: String(i),
        label: root.label ?? parseTagText(root.mainTag),
      })),
    ], this.rootIndex === NO_ROOT ? "" : String(this.rootIndex));
    rootSelect.addEventListener("change", () => {
      this.rootIndex = rootSelect.value === "" ? NO_ROOT : Number(rootSelect.value);
      // 换大类别后旧的子标签不再适用
      this.selections = [];
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

    while (level.length > 0) {
      const nodes = level;
      const levelIndex = index;

      // 后续层级不写「2 级 / 3 级」：记账界面也是这样，层级靠下拉顺序表达
      const row = this.createRow("");
      const select = this.createSelect(
        row,
        [{ value: "", label: "—" }, ...nodes.map((n) => ({ value: n.name, label: n.name }))],
        this.selections[levelIndex] ?? "",
      );
      select.addEventListener("change", () => {
        // 改这一级会重置更深的选择
        this.selections = this.selections.slice(0, levelIndex);
        if (select.value !== "") this.selections.push(select.value);
        this.renderLevels();
      });

      const chosen = this.selections[levelIndex];
      const node = nodes.find((n) => n.name === chosen);
      if (!node || !node.children || node.children.length === 0) break;

      level = node.children;
      index++;
    }

    this.pickerHost.createDiv({
      cls: "cashlog-tag-picker-current",
      text: this.currentTag() ?? t("import.picker.unset"),
    });
  }
}

