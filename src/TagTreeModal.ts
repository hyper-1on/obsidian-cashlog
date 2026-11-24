import { App, Modal, Notice, Setting } from "obsidian";
import { t, tp } from "./i18n";
import { createSection } from "./ui/Section";
import { addChild, pruneEmptyNodes, removeNode, validateTagSegment } from "./TagTree";
import type { TagNode } from "./TagTree";

interface TreeSection {
  key: string;
  title: string;
  nodes: TagNode[];
}

// 标签总览：一个较大的弹窗，用树形把「支出 / 收入 / 附加维度」下的所有标签
// 一次展示出来，可在任意节点上增删改。
//
// 为什么不再用「逐层进入」的弹窗：逐层进入看不到全貌，也无法一眼看到某个标签
// 在第几层。树形平铺 + 缩进能直接表达层级，深度不限。
export class TagTreeModal extends Modal {
  private readonly sections: TreeSection[];
  private readonly onChange: () => Promise<void> | void;

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
    contentEl.empty();
    contentEl.addClass("cashlog-tag-tree-modal");
    this.titleEl.setText(t("tagTree.title"));

    // 顶部说明
    contentEl.createDiv({ cls: "cashlog-tag-tree-hint", text: t("tagTree.hint") });

    for (const section of this.sections) {
      // 与其它弹窗共用同一套分区卡片
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

      // 该分区的根级新增
      new Setting(body).addText((text) => {
        text.setPlaceholder(t("tagTree.addPlaceholder"));
        text.onChange((v) => {
          this.pending[section.key] = v;
        });
      }).addButton((btn) => {
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
  }

  // 递归渲染一个节点
  private renderNode(
    parent: HTMLElement,
    section: TreeSection,
    node: TagNode,
    path: string[],
    depth: number,
  ): void {
    const row = parent.createDiv({ cls: "cashlog-tag-tree-row" });
    // 缩进表达层级，深度不限
    row.style.paddingLeft = `${depth * 18}px`;

    const nameEl = row.createSpan({ cls: "cashlog-tag-tree-name", text: node.name });
    nameEl.setAttribute("title", path.join("/"));

    const actions = row.createDiv({ cls: "cashlog-tag-tree-actions" });

    // 改：就地输入
    const editBtn = actions.createSpan({ cls: "cashlog-tag-tree-btn", text: "✏" });
    editBtn.setAttribute("aria-label", t("tagTree.rename"));
    editBtn.addEventListener("click", () => {
      // 内联输入：Electron 里 window.prompt 不可用
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

    // 加子节点
    const addBtn = actions.createSpan({ cls: "cashlog-tag-tree-btn", text: "+" });
    addBtn.setAttribute("aria-label", t("tagTree.addChild"));
    addBtn.addEventListener("click", () => {
      this.inlineInput(row, "", (value) => {
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
        void this.onChange();
      });
    });

    // 删（连带子树）
    const delBtn = actions.createSpan({ cls: "cashlog-tag-tree-btn cashlog-tag-tree-btn-danger", text: "✕" });
    delBtn.setAttribute("aria-label", t("tagTree.remove"));
    let armed = false;
    delBtn.addEventListener("click", () => {
      if (!armed) {
        // 第一次点击：进入待确认状态（3 秒后复位），避免误删整棵子树
        armed = true;
        delBtn.addClass("cashlog-tag-tree-btn-armed");
        delBtn.setText("?");
        window.setTimeout(() => {
          armed = false;
          delBtn.classList.remove("cashlog-tag-tree-btn-armed");
          delBtn.setText("✕");
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

    // 子节点递归
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        this.renderNode(parent, section, child, [...path, child.name], depth + 1);
      }
    }
  }

  // 行内输入：把整行替换成输入框，回车提交、Esc 取消
  private inlineInput(row: HTMLElement, initial: string, onDone: (value: string) => void): void {
    row.empty();
    row.addClass("cashlog-tag-tree-row-editing");

    const input = activeDocument.createElement("input");
    input.type = "text";
    input.value = initial;
    input.className = "cashlog-tag-tree-input";
    row.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) onDone(input.value);
      void this.render();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(false));
  }

  private countNodes(nodes: TagNode[]): number {
    let n = 0;
    for (const node of nodes) {
      n += 1;
      if (node.children) n += this.countNodes(node.children);
    }
    return n;
  }

  private pending: Record<string, string> = {};
}
