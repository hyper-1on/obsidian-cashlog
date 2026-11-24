import { App, Menu, Modal, Notice, Setting, TextComponent, setIcon } from "obsidian";
import { t, tp } from "./i18n";
import { addChild, findNode, pruneEmptyNodes, removeNode, validateTagSegment } from "./TagTree";
import type { TagNode } from "./TagTree";
import { createSection } from "./ui/Section";

export interface TreeSection {
  key: string;
  title: string;
  nodes: TagNode[];
}

// 标签总览：树形展示「支出 / 收入 / 附加维度」下的全部标签，可在任意节点增删改。
//
// 层级用 <ul>/<li> 表达（和 Markdown 无序列表一致），不再靠 padding 模拟缩进。
// 指定 focusPath 时只渲染该节点的子树 —— 从某个 chip 点进来时只关心它下面有什么。
export class TagTreeModal extends Modal {
  private readonly sections: TreeSection[];
  private readonly onChange: () => Promise<void> | void;
  /** 只看这一支（undefined = 显示全部） */
  private readonly focusPath: string[] | undefined;

  /** 正在给哪个路径新增子标签（null = 不在新增状态） */
  private addingUnder: string | null = null;
  /** 正在给哪个路径改名（null = 不在改名状态） */
  private renaming: string | null = null;
  /** 各分区根级新增框的当前输入 */
  private pending: Record<string, string> = {};

  constructor(
    app: App,
    sections: TreeSection[],
    onChange: () => Promise<void> | void,
    focusPath?: string[],
  ) {
    super(app);
    this.sections = sections;
    this.onChange = onChange;
    this.focusPath = focusPath;
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
    this.titleEl.setText(
      this.focusPath ? `${this.focusPath.join("/")} · ${t("tagTree.childrenTitle")}` : t("tagTree.title"),
    );

    contentEl.createDiv({ cls: "cashlog-tag-tree-hint", text: t("tagTree.hint") });

    for (const section of this.sections) {
      // focusPath 时只取该节点
      let roots: TagNode[] = section.nodes;
      if (this.focusPath) {
        const node = findNode(section.nodes, this.focusPath);
        roots = node?.children ?? [];
      }

      const body = createSection(contentEl, {
        title: `${section.title}（${this.countNodes(roots)}）`,
        cls: "cashlog-tag-tree-section",
      });

      if (roots.length === 0) {
        body.createDiv({ cls: "cashlog-tag-tree-empty", text: t("tagTree.empty") });
      }

      const ul = body.createEl("ul", { cls: "cashlog-tag-tree-list" });
      for (const node of roots) {
        this.renderNode(ul, section, node, this.focusPath ? [...this.focusPath, node.name] : [node.name]);
      }

      // 该分区的新增框（focusPath 时加到该节点下，否则加到根）
      new Setting(body)
        .addText((text) => {
          text.setPlaceholder(t("tagTree.addPlaceholder"));
          text.onChange((v) => {
            this.pending[section.key] = v;
          });
          // 回车提交，不用去点按钮
          text.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void this.commitRootAdd(section);
            }
          });
        })
        .addButton((btn) => {
          btn.setButtonText(t("tagTree.addButton")).onClick(() => {
            void this.commitRootAdd(section);
          });
        });
    }

    window.requestAnimationFrame(() => {
      contentEl.scrollTop = scrollTop;
    });
  }

  private async commitRootAdd(section: TreeSection): Promise<void> {
    const raw = (this.pending[section.key] ?? "").trim();
    if (raw === "") return;

    const check = validateTagSegment(raw);
    if (!check.valid) {
      new Notice(tp("tagTree.invalid", { reason: check.message ?? "" }));
      return;
    }

    const parentPath = this.focusPath ?? [];
    if (!addChild(section.nodes, parentPath, raw)) {
      new Notice(tp("tagTree.exists", { name: raw }));
      return;
    }

    this.pending[section.key] = "";
    await this.onChange();
    await this.render();
  }

  private renderNode(
    parentUl: HTMLElement,
    section: TreeSection,
    node: TagNode,
    path: string[],
  ): void {
    const li = parentUl.createEl("li", { cls: "cashlog-tag-tree-item" });

    const row = li.createDiv({ cls: "cashlog-tag-tree-row" });

    // 改名时输入框占据名字本身的槽位（覆盖在原名字上），
    // 而不是像新增那样在行下方另起一行 —— 两种操作的语义不同，视觉也应不同。
    if (this.renaming === path.join("/")) {
      const slot = row.createDiv({
        cls: "cashlog-tag-tree-name-editor cashlog-tag-tree-row-editing",
      });
      this.renameInput(slot, node);
    } else {
      const nameEl = row.createSpan({ cls: "cashlog-tag-tree-name", text: node.name });
      nameEl.setAttribute("title", path.join("/"));
    }

    const actions = row.createDiv({ cls: "cashlog-tag-tree-actions" });

    // 改名：进入改名态，输入框会替换这一行的名字
    this.iconButton(actions, "pencil", t("tagTree.rename"), () => {
      this.renaming = path.join("/");
      this.addingUnder = null;
      void this.render();
    });

    // 加子标签：进入新增态，输入行会插在这个 li 的子列表末尾
    this.iconButton(actions, "plus", t("tagTree.addChild"), () => {
      this.addingUnder = path.join("/");
      void this.render();
    });

    // 删除：两次点击确认
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

    // 子节点用嵌套 <ul>
    const children = node.children ?? [];
    const childUl = children.length > 0 ? li.createEl("ul", { cls: "cashlog-tag-tree-list" }) : null;
    for (const child of children) {
      this.renderNode(childUl!, section, child, [...path, child.name]);
    }

    // 新增输入行：放在这个 li 的最后（即子树之后），不覆盖节点本身
    if (this.addingUnder === path.join("/")) {
      // 直接把输入行挂到子列表（或本 li）上，inlineInput 自己会建行
      this.inlineInput(
        childUl ?? li,
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

  // 统一的图标按钮：同尺寸，lucide 图标
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

  // 改名输入框：直接占据标签名字的槽位，预填原名并全选。
  // 回车提交、Esc 或失焦取消；无论哪条路径都要清掉 renaming 再重建，
  // 否则下一次 render 会继续把这一行渲染成输入框。
  private renameInput(host: HTMLElement, node: TagNode): void {
    const text = new TextComponent(host);
    text.setValue(node.name);
    text.inputEl.addClass("cashlog-tag-tree-input");
    text.inputEl.focus();
    text.inputEl.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;

      if (commit) {
        const trimmed = text.getValue().trim();
        if (trimmed !== "" && trimmed !== node.name) {
          const check = validateTagSegment(trimmed);
          if (!check.valid) {
            new Notice(tp("tagTree.invalid", { reason: check.message ?? "" }));
          } else {
            node.name = trimmed;
            void this.onChange();
          }
        }
      }

      this.renaming = null;
      void this.render();
    };

    text.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    text.inputEl.addEventListener("blur", () => finish(false));
  }

  // 新增子标签的输入行：出现在目标节点下方（没有子节点时紧随其行，有子节点时落在子列表末尾）
  private inlineInput(
    host: HTMLElement,
    initial: string,
    onDone: (value: string) => void,
    onCancel?: () => void,
  ): void {
    const row = host.createDiv({ cls: "cashlog-tag-tree-row cashlog-tag-tree-row-editing" });

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
