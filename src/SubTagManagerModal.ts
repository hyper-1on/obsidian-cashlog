import { App, Modal, Notice, Setting } from "obsidian";
import { t, tp } from "./i18n";
import { addChild, findNode, removeNode, validateTagSegment, pruneEmptyNodes } from "./TagTree";
import type { TagNode } from "./TagTree";

// 子标签管理弹窗：管理某个标签节点下的子标签。
//
// 为什么用弹窗而不是把树直接展开在面板里：面板是窄侧栏，多层树会把排版撑乱；
// 弹窗里一次只看一层，层级靠"再点进去"表达，深度不限。
export class SubTagManagerModal extends Modal {
  private nodes: TagNode[];
  private path: string[];
  private readonly onChange: () => Promise<void> | void;

  constructor(
    app: App,
    /** 根节点数组（会被就地修改） */
    nodes: TagNode[],
    /** 当前节点路径，如 ["餐饮"] */
    path: string[],
    onChange: () => Promise<void> | void,
  ) {
    super(app);
    this.nodes = nodes;
    this.path = path;
    this.onChange = onChange;
  }

  onOpen(): void {
    void this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private title(): string {
    const label = this.path.join("/");
    return label === "" ? t("subTagManager.rootTitle") : tp("subTagManager.title", { name: label });
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cashlog-subtag-manager");

    this.titleEl.setText(this.title());

    const node = this.path.length > 0 ? findNode(this.nodes, this.path) : null;
    if (!node && this.path.length > 0) {
      contentEl.createDiv({ text: t("subTagManager.nodeMissing") });
      return;
    }

    const children = node ? (node.children ?? []) : this.nodes;

    if (children.length === 0) {
      contentEl.createDiv({ cls: "cashlog-subtag-manager-empty", text: t("subTagManager.empty") });
    }

    const list = contentEl.createDiv({ cls: "cashlog-subtag-manager-list" });

    for (const child of [...children]) {
      const row = list.createDiv({ cls: "cashlog-subtag-manager-row" });

      const nameEl = row.createSpan({ cls: "cashlog-subtag-manager-name", text: child.name });
      // 有子节点时可点进去继续管理
      if (child.children && child.children.length > 0) {
        nameEl.addClass("cashlog-subtag-manager-name-link");
        nameEl.addEventListener("click", () => {
          const next = new SubTagManagerModal(this.app, this.nodes, [...this.path, child.name], this.onChange);
          this.close();
          next.open();
        });
      }

      const actions = row.createDiv({ cls: "cashlog-subtag-manager-actions" });

      const enter = actions.createSpan({ cls: "cashlog-subtag-manager-btn", text: "▸" });
      enter.setAttribute("aria-label", t("subTagManager.enter"));
      enter.addEventListener("click", () => {
        const next = new SubTagManagerModal(this.app, this.nodes, [...this.path, child.name], this.onChange);
        this.close();
        next.open();
      });

      const del = actions.createSpan({ cls: "cashlog-subtag-manager-btn", text: "×" });
      del.setAttribute("aria-label", t("subTagManager.remove"));
      del.addEventListener("click", () => {
        void (async () => {
          const target = [...this.path, child.name];
          removeNode(this.nodes, target);
          pruneEmptyNodes(this.nodes);
          await this.onChange();
          await this.render();
          new Notice(tp("subTagManager.removed", { name: child.name }));
        })();
      });
    }

    // 新增子标签
    new Setting(contentEl)
      .setName(t("subTagManager.addTitle"))
      .addText((text) => {
        text.setPlaceholder(t("subTagManager.addPlaceholder"));
        text.onChange((v) => {
          this.pendingName = v;
        });
      })
      .addButton((btn) => {
        btn.setButtonText(t("subTagManager.addButton")).onClick(() => {
          void (async () => {
            const raw = (this.pendingName ?? "").trim();
            if (raw === "") return;

            const check = validateTagSegment(raw);
            if (!check.valid) {
              new Notice(tp("subTagManager.invalid", { reason: check.message ?? "" }));
              return;
            }

            const ok = addChild(this.nodes, this.path, raw);
            if (!ok) {
              new Notice(tp("subTagManager.exists", { name: raw }));
              return;
            }

            this.pendingName = "";
            await this.onChange();
            await this.render();
          })();
        });
      });
  }

  private pendingName = "";
}
