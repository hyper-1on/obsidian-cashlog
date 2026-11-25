// 通用 · 单行输入弹窗
//
// 用在「就地新建」这类场景：要一个名字，拿到就走。
// 用独立 Modal 而不是往表单里插输入框，是因为调用方的表单会整块重建
// （记账表单切换类型时就是这样），插进去的输入框会被连带销毁。

import { App, Modal, Setting, TextComponent } from "obsidian";
import { t } from "../i18n";
import { createModalButton, createModalButtonRow } from "../ModalHelpers";

export interface PromptModalOptions {
  title: string;
  placeholder?: string;
  value?: string;
  /** 返回错误文案表示校验失败，弹窗不关闭；返回 null 表示通过 */
  validate?: (value: string) => string | null;
  /** 确认回调；抛错时弹窗保持打开 */
  onConfirm: (value: string) => void | Promise<void>;
}

export class PromptModal extends Modal {
  private readonly options: PromptModalOptions;
  /** 用 Obsidian 的 TextComponent，样式与设置页里的输入框一致 */
  private textComponent: TextComponent | null = null;
  private errorEl!: HTMLElement;

  constructor(app: App, options: PromptModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cashlog-prompt-modal");
    this.titleEl.setText(this.options.title);

    // 用 Setting 包一层：Obsidian 的输入框样式依附在 .setting-item-control 上，
    // 直接 createEl("input") 出来的是裸样式，和插件其它输入框不一致。
    new Setting(contentEl)
      .setClass("cashlog-prompt-setting")
      .addText((text) => {
        this.textComponent = text;
        text.setPlaceholder(this.options.placeholder ?? "").setValue(this.options.value ?? "");
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void this.submit();
          }
        });
      });

    this.errorEl = contentEl.createDiv({ cls: "cashlog-tag-modal-error" });
    this.errorEl.addClass("is-hidden");

    const btnRow = createModalButtonRow(contentEl);
    btnRow.appendChild(createModalButton(t("modal.button.cancel"), "secondary", () => this.close()));
    btnRow.appendChild(
      createModalButton(t("import.picker.confirm"), "primary", () => void this.submit()),
    );

    // 打开即可输入
    window.setTimeout(() => this.textComponent?.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const value = this.textComponent?.getValue().trim() ?? "";
    const error = this.options.validate?.(value) ?? null;
    if (error) {
      this.errorEl.setText(error);
      this.errorEl.removeClass("is-hidden");
      return;
    }

    try {
      await this.options.onConfirm(value);
      this.close();
    } catch (e) {
      this.errorEl.setText(e instanceof Error ? e.message : String(e));
      this.errorEl.removeClass("is-hidden");
    }
  }
}
