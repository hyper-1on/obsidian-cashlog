// 通用 · 级联标签选择器
//
// 一个标签树 + 主标签前缀 → 逐级下拉，任意深度都可以停。
// 记账表单、导入清单、以后任何要给条目选标签的地方都用这一份。
//
// 为什么做成独立小弹窗而不是一行下拉：
// 清单里每行都要选标签，行内放下拉会把表格挤变形；
// 弹窗可以只显示「当前值 → 改」，并且能同时展示级联的每一级。

import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import type { TagNode } from "../TagTree";
import { parseTagText } from "../TagTree";
import { createModalButton, createModalButtonRow } from "../ModalHelpers";

export interface TagPickerOptions {
  /** 主标签，如 "#支出"；为空表示标签树本身就是完整路径（附加维度） */
  mainTag: string;
  /** 该主标签下的标签树 */
  tree: TagNode[];
  /** 当前值，形如 "#支出/餐饮/午餐" */
  current: string | null;
  /** 是否允许清空为「未指定」，默认允许 */
  allowClear?: boolean;
  /** 选定后回调；清空时传 null */
  onPick: (tag: string | null) => void;
}

/**
 * 打开级联标签选择器。
 *
 * 继承 Obsidian 的 Modal：清单本身是 Modal，在它上面再叠自绘浮层
 * 容易被父级的点击穿透与 focus 处理搅乱；交给 Obsidian 管层级更稳。
 */
export class TagPickerModal extends Modal {
  private readonly options: TagPickerOptions;

  /** 当前选到第几级：selections[0] 是一级名，依此类推 */
  private selections: string[] = [];
  private pickerHost!: HTMLElement;

  constructor(app: App, options: TagPickerOptions) {
    super(app);
    this.options = options;
    this.selections = this.initSelections();
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
          this.options.onPick(null);
          this.close();
        }),
      );
    }
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
    if (this.selections.length === 0) return null;
    const path = this.selections.join("/");
    return this.options.mainTag ? `${this.options.mainTag}/${path}` : `#${path}`;
  }

  /** 从当前值反推各级选择，方便再次编辑时回显。 */
  private initSelections(): string[] {
    const current = this.options.current;
    if (!current) return [];

    let plain = parseTagText(current);
    const mainPlain = parseTagText(this.options.mainTag);
    if (mainPlain && plain === mainPlain) return [];
    if (mainPlain && plain.startsWith(`${mainPlain}/`)) {
      plain = plain.slice(mainPlain.length + 1);
    }
    return plain.split("/").filter((s) => s !== "");
  }

  /** 渲染每一级下拉；某一级有子标签时自动追加下一级。 */
  private renderLevels(): void {
    this.pickerHost.empty();

    let level: TagNode[] = this.options.tree;
    let index = 0;

    while (level.length > 0) {
      const nodes = level;
      const levelIndex = index;

      new Setting(this.pickerHost)
        .setName(`${levelIndex + 1} 级`)
        .addDropdown((dd) => {
          dd.addOption("", "—");
          for (const node of nodes) dd.addOption(node.name, node.name);
          dd.setValue(this.selections[levelIndex] ?? "");
          dd.onChange((value) => {
            // 改这一级会重置更深的选择
            this.selections = this.selections.slice(0, levelIndex);
            if (value !== "") this.selections.push(value);
            this.renderLevels();
          });
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
