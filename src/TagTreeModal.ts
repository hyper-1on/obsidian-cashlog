import { App, Modal, Notice, Setting, TextComponent, setIcon } from "obsidian";
import { t, tp } from "./i18n";
import { addChild, pruneEmptyNodes, removeNode, validateTagSegment } from "./TagTree";
import type { TagNode } from "./TagTree";
import { createSection } from "./ui/Section";

export interface TreeSection {
  key: string;
  title: string;
  nodes: TagNode[];
}

// 标签总览：树形展示「支出 / 收入 / 附加维度」下的全部标签，可在任意节点增删改。
//
// 只有一个弹窗：此前还有逐层进入的 SubTagManagerModal，两套交互（▸ 展开 vs 缩进、
// × vs ✕）容易让人以为功能不同。树形平铺能一次看到全貌，也就不需要"返回上一级"。
export class TagTreeModal extends Modal {
  private readonly sections: TreeSection[];
  private readonly onChange: () => Promise<void> | void;

  /** 正在给哪个路径新增子标签（null = 不在新增状态） */
  private addingUnder: string | null = null;
  /** 各分区根级新增框的当前输入 */
  private pending: Record<string, string> = {};

  constructor(app: App, sections: TreeSection[], onChange: () => Promise<void> | void) {
    super(app);
    this.sections = sections;
    this.onChange = onChange;
  }

  onOpen(): void {
    void this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;

    // 重建会重置内部滚动位置，先存后还，避免新增标签后视图跳回顶部
    const scrollTop = contentEl.scrollTop;

    contentEl.empty();
    contentEl.addClass("cashlog-tag-tree-modal");
    this.titleEl.setText(t("tagTree.title"));

    contentEl.createDiv({ cls: "cashlog-tag-tree-hint", text: t("tagTree.hint") });

    for (const section of this.sections) {
      const body = createSection(contentEl, {
        title: `${section.title}（${this.countNodes(section.nodes)}）`,
        cls: "cashlog-tag-tree-section",
      });

      if (section.nodes.length === 0) {
        body.createDiv({ cls: "cashlog-tag-tree-empty", text: t("tagTree.empty") });
      }

      for (const node of section.nodes) {
        this.renderNode(body, section, node, [node.name], 0);
      }

      // 该分区根级新增
      new Setting(body)
        .addText((text) => {
          text.setPlaceholder(t("tagTree.addPlaceholder"));
          text.onChange((v) => {
            this.pending[section.key] = v;
          });
        })
        .addButton((btn) => {
          btn.setButtonText(t("tagTree.addButton")).onClick(() => {
            void (async () => {
              const raw = (this.pending[section.key] ?? "").trim();
              if (raw === "") return;
              const check = validateTagSegment(raw);
              if (!check.valid) {
                new Notice(tp("tagTree.invalid", { reason: check.message ?? "" }));
                return;
              }
              if (!addChild(section.nodes, [], raw)) {
                new Notice(tp("tagTree.exists", { name: raw }));
                return;
              }
              this.pending[section.key] = "";
              await this.onChange();
              await this.render();
            })();
          });
        });
    }

    // 恢复滚动位置（等一帧，避免被后续布局覆盖）
    window.requestAnimationFrame(() => {
      contentEl.scrollTop = scrollTop;
    });
  }

  private renderNode(
    parent: HTMLElement,
    section: TreeSection,
    node: TagNode,
    path: string[],
    depth: number,
  ): void {
    const row = parent.createDiv({ cls: "cashlog-tag-tree-row" });
    row.style.paddingLeft = `${depth * 18}px`;

    const nameEl = row.createSpan({ cls: "cashlog-tag-tree-name", text: node.name });
    nameEl.setAttribute("title", path.join("/"));

    const actions = row.createDiv({ cls: "cashlog-tag-tree-actions" });

    // 改名
    this.iconButton(actions, "pencil", t("tagTree.rename"), () => {
      // 改名复用本行：这一行原本就只显示名称，替换成输入框不会"盖住"别的东西
      this.inlineInput(row, node.name, (value) => {
        const trimmed = value.trim();
        if (trimmed === "" || trimmed === node.name) return;
        const check = validateTagSegment(trimmed);
        if (!check.valid) {
          new Notice(tp("tagTree.invalid", { reason: check.message ?? "" }));
          return;
        }
        node.name = trimmed;
        void this.onChange();
      });
    });

    // 加子标签：进入"新增态"，渲染时会在该节点子树末尾插入一行输入框
    this.iconButton(actions, "plus", t("tagTree.addChild"), () => {
      this.addingUnder = path.join("/");
      void this.render();
    });

    // 删除：两次点击确认（会连带整棵子树）
    let armed = false;
    const delBtn = this.iconButton(actions, "x", t("tagTree.remove"), () => {
      if (!armed) {
        armed = true;
        delBtn.addClass("cashlog-tag-tree-btn-armed");
        setIcon(delBtn, "check");
        window.setTimeout(() => {
          armed = false;
          delBtn.classList.remove("cashlog-tag-tree-btn-armed");
          setIcon(delBtn, "x");
        }, 3000);
        return;
      }
      void (async () => {
        removeNode(section.nodes, path);
        pruneEmptyNodes(section.nodes);
        await this.onChange();
        await this.render();
        new Notice(tp("tagTree.removed", { name: node.name }));
      })();
    });
    delBtn.addClass("cashlog-tag-tree-btn-danger");

    // 子节点
    for (const child of node.children ?? []) {
      this.renderNode(parent, section, child, [...path, child.name], depth + 1);
    }

    // 新增输入行：放在该节点的子树之后，而不是替换节点本身那一行
    if (this.addingUnder === path.join("/")) {
      const inputRow = parent.createDiv({ cls: "cashlog-tag-tree-row cashlog-tag-tree-row-editing" });
      inputRow.style.paddingLeft = `${(depth + 1) * 18}px`;
      this.inlineInput(
        inputRow,
        "",
        (value) => {
          const trimmed = value.trim();
          if (trimmed === "") return;
          const check = validateTagSegment(trimmed);
          if (!check.valid) {
            new Notice(tp("tagTree.invalid", { reason: check.message ?? "" }));
            return;
          }
          if (!addChild(section.nodes, path, trimmed)) {
            new Notice(tp("tagTree.exists", { name: trimmed }));
            return;
          }
          this.addingUnder = null;
          void this.onChange();
        },
        () => {
          this.addingUnder = null;
        },
      );
    }
  }

  // 统一的图标按钮：同一尺寸、同一套 lucide 图标
  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const btn = parent.createSpan({ cls: "cashlog-tag-tree-btn" });
    setIcon(btn, icon);
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  // 行内输入：用 Obsidian TextComponent，回车提交、Esc 取消
  private inlineInput(
    row: HTMLElement,
    initial: string,
    onDone: (value: string) => void,
    onCancel?: () => void,
  ): void {
    row.empty();
    row.addClass("cashlog-tag-tree-row-editing");

    const text = new TextComponent(row);
    text.setValue(initial);
    text.inputEl.addClass("cashlog-tag-tree-input");
    text.inputEl.focus();
    text.inputEl.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) onDone(text.getValue());
      else onCancel?.();
      void this.render();
    };

    text.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    text.inputEl.addEventListener("blur", () => finish(false));
  }

  private countNodes(nodes: TagNode[]): number {
    let n = 0;
    for (const node of nodes) {
      n += 1;
      if (node.children) n += this.countNodes(node.children);
    }
    return n;
  }
}
