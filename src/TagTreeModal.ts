import { App, Modal, Notice, Setting, TextComponent, setIcon } from "obsidian";
import { t, tp } from "./i18n";
import { addChild, findNode, parseTagText, pruneEmptyNodes, removeNode, validateTagSegment } from "./TagTree";
import type { TagNode } from "./TagTree";
import { createSection } from "./ui/Section";

export interface TreeSection {
  key: string;
  title: string;
  nodes: TagNode[];
}

// 同一时刻只允许一处编辑（改名或新增子标签）。
// 用它把「退出编辑态」变成一次局部还原：只动这一行的 DOM，不重建整棵树。
// 重建会连带销毁其它行的按钮，而真实浏览器不会把随后的 click 送给已被移除的元素 —
// 于是「先点一个 +，再点另一个 +」表现为只收起、不打开。
interface ActiveEditor {
  key: string;
  /** 收起编辑态：只还原这一处的 DOM */
  close: () => void;
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

  /** 正在给哪个节点新增子标签（null = 不在新增状态） */
  private addingUnder: string | null = null;
  /** 正在给哪个节点改名（null = 不在改名状态） */
  private renaming: string | null = null;
  /** 当前打开的编辑器（用于局部收起） */
  private activeEditor: ActiveEditor | null = null;
  /**
   * 刚被按下的那一行按钮所属的 key。
   * 浏览器顺序是 mousedown → 输入框 blur → mouseup → click，
   * 所以失焦先于点击到达。没有这个标记就无法区分
   * 「用户按了本行的按钮」（该由 click 决定开关）和「焦点真的跑掉了」（该关闭）。
   */
  private intentKey: string | null = null;
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

    // 旧 DOM 即将被丢弃，旧的 close 回调指向的元素也随之失效
    this.activeEditor = null;

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
        // 从某个标签点进来时，整块内容都是它下面的子标签，
        // 再写「支出子标签」这种大范围标题就名不副实了。
        title: this.focusPath
          ? `${this.focusPath[this.focusPath.length - 1]}（${this.countNodes(roots)}）`
          : `${parseTagText(section.title)}（${this.countNodes(roots)}）`,
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

  // 编辑态的键必须带上分类：支出/1 与 收入/1 分属两棵树，是两个不同节点。
  // 只记裸路径会让同名节点同时进入编辑态，而多个输入框抢焦点时，
  // 后一个 focus 会让前一个 blur，blur 又清掉编辑态 —— 表现为「怎么点都打不开」。
  private keyOf(section: TreeSection, path: string[]): string {
    return `${section.key}\u0000${path.join("/")}`;
  }

  private renderNode(
    parentUl: HTMLElement,
    section: TreeSection,
    node: TagNode,
    path: string[],
  ): void {
    const li = parentUl.createEl("li", { cls: "cashlog-tag-tree-item" });

    const row = li.createDiv({ cls: "cashlog-tag-tree-row" });

    const key = this.keyOf(section, path);

    const nameEl = row.createSpan({ cls: "cashlog-tag-tree-name", text: node.name });
    nameEl.setAttribute("title", path.join("/"));

    // 改名输入框的槽位常驻、默认隐藏：进出改名态只切换这一处显隐，
    // 输入框因此可以「覆盖在名字上」，而不是在行下方另起一行。
    // 注意不要复用 .cashlog-tag-tree-row-editing：那个类标识「本行是新增输入行」，
    // 每行都有的隐藏槽位若也带上它，按类查找就会把所有行都算成编辑器。
    const editorSlot = row.createDiv({
      cls: "cashlog-tag-tree-name-editor is-hidden",
    });

    const actions = row.createDiv({ cls: "cashlog-tag-tree-actions" });

    // 新增输入行的挂载点：有子标签时落在子列表末尾，否则紧跟本行。
    // 在按钮回调里才求值，所以可以先注册 handler 再赋值。
    let addHost: HTMLElement | null = null;

    // 改名：再次点击同一行等于收起
    const renameBtn = this.iconButton(actions, "pencil", t("tagTree.rename"), () => {
      const wasOpen = this.renaming === key;
      this.stopEditing();
      this.intentKey = null;
      if (wasOpen) return;
      this.renaming = key;
      this.showRenameEditor(key, node, nameEl, editorSlot);
    });
    renameBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.intentKey = key;
    });

    // 加子标签：再次点击同一行等于收起
    const addBtn = this.iconButton(actions, "plus", t("tagTree.addChild"), () => {
      const wasOpen = this.addingUnder === key;
      this.stopEditing();
      this.intentKey = null;
      if (wasOpen) return;
      this.addingUnder = key;
      this.showAddEditor(addHost ?? li, section, path);
    });
    addBtn.addEventListener("mousedown", (e) => {
      // 阻止默认的焦点转移。否则输入框在 mousedown 阶段就失焦、输入行立即被移除，
      // 少掉一行后下方按钮整体上移，mouseup 落到别的元素上，浏览器就不派发 click ——
      // 表现是「点另一行的 + 只收起、不打开」，而且只在被移除的行位于目标上方时发生。
      e.preventDefault();
      this.intentKey = key;
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
        this.stopEditing();
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
    addHost = childUl ?? li;
    for (const child of children) {
      this.renderNode(childUl!, section, child, [...path, child.name]);
    }

    // 重建时若仍处于编辑态，按状态把输入框装回去
    if (this.renaming === key) {
      this.showRenameEditor(key, node, nameEl, editorSlot);
    }
    if (this.addingUnder === key) {
      this.showAddEditor(addHost, section, path);
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

  // 收起当前编辑态：只还原那一处 DOM，不重建整棵树。
  // 先清状态再收 DOM：close 万一抛错，也不会把编辑状态永久卡在「已打开」，
  // 否则之后每次点击都会在同一个位置抛异常，表现为整个对话框都用不了。
  private stopEditing(): void {
    const editor = this.activeEditor;
    this.activeEditor = null;
    this.renaming = null;
    this.addingUnder = null;
    editor?.close();
  }

  // 改名：输入框占据名字的槽位。取消时只把名字换回来，
  // 提交才重建（名字变了，分组/计数都要跟着更新）。
  private showRenameEditor(
    key: string,
    node: TagNode,
    nameEl: HTMLElement,
    slot: HTMLElement,
  ): void {
    nameEl.addClass("is-hidden");
    slot.removeClass("is-hidden");

    const close = (): void => {
      slot.addClass("is-hidden");
      // 幂等：槽位已空时再 empty() 会重复派发 blur、引发连锁
      if (slot.children.length > 0) slot.empty();
      nameEl.removeClass("is-hidden");
    };
    this.activeEditor = { key, close };

    const text = new TextComponent(slot);
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
            // 输入本身有问题：保持打开，让用户就地改
            done = false;
            return;
          }
          node.name = trimmed;
          this.renaming = null;
          this.activeEditor = null;
          void this.onChange();
          void this.render();
          return;
        }
      }

      // 取消 / 没改动：就地收起，不重建
      this.renaming = null;
      this.activeEditor = null;
      close();
    };

    text.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    text.inputEl.addEventListener("blur", () => {
      // 失焦是本行按钮被按下造成的：交给那次 click 决定是收起还是切换。
      // 这里抢先关掉，后面的 click 又会打开一次，「点同一个 + 想关掉」就变成关不掉。
      if (this.intentKey !== null && this.intentKey === this.activeEditor?.key) {
        this.intentKey = null; // 只豁免这一次，避免拖拽后标记残留导致再也关不掉
        return;
      }
      finish(false);
    });
  }

  // 新增子标签：输入行出现在目标节点下方（有子节点时落在子列表末尾）。
  private showAddEditor(parent: HTMLElement, section: TreeSection, path: string[]): void {
    const row = parent.createDiv({ cls: "cashlog-tag-tree-row cashlog-tag-tree-row-editing" });

    const close = (): void => {
      // 幂等：blur 与 click 都可能来收同一行，第二次移除会抛 NotFoundError，
      // 那个异常会打断 click handler 里「打开新编辑器」的后半段，
      // 表现就是「点别行的 + 只收起、不打开」，而且成功/失败会交替出现。
      if (row.isConnected) row.remove();
    };
    const editorKey = this.keyOf(section, path);
    this.activeEditor = { key: editorKey, close };

    const text = new TextComponent(row);
    text.inputEl.addClass("cashlog-tag-tree-input");
    text.inputEl.focus();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;

      if (commit) {
        const trimmed = text.getValue().trim();

        // 空输入等同取消
        if (trimmed === "") {
          this.addingUnder = null;
          this.activeEditor = null;
          close();
          return;
        }

        const check = validateTagSegment(trimmed);
        if (!check.valid) {
          new Notice(tp("tagTree.invalid", { reason: check.message ?? "" }));
          done = false;
          return;
        }
        if (!addChild(section.nodes, path, trimmed)) {
          new Notice(tp("tagTree.exists", { name: trimmed }));
          done = false;
          return;
        }

        this.addingUnder = null;
        this.activeEditor = null;
        void this.onChange();
        void this.render();
        return;
      }

      this.addingUnder = null;
      this.activeEditor = null;
      close();
    };

    text.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    text.inputEl.addEventListener("blur", () => {
      const exempt = this.intentKey !== null && this.intentKey === this.activeEditor?.key;
      // 失焦是本行按钮被按下造成的：交给那次 click 决定是收起还是切换
      if (exempt) {
        this.intentKey = null; // 只豁免这一次，避免拖拽后标记残留导致再也关不掉
        return;
      }
      // 不在 blur 里立刻收起：移除输入行会让下方整排上移，mouseup 落到别的元素上，
      // 浏览器就不再派发 click（表现是「点别行的 + 只收起、不打开」）。
      // 推迟到下一轮事件循环，让这次点击先完整走完。
      window.setTimeout(() => {
        if (this.activeEditor?.key !== editorKey) return; // 已被别的编辑器接管
        finish(false);
      }, 0);
    });
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
