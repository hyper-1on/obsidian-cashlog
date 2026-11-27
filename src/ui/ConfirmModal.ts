// 通用 · 二选一确认弹窗
//
// 只有两个明确出口，不给「关闭 = 取消」这种含糊语义：
// 用户必须选一边，标题和正文说清后果。

import { App, Modal } from "obsidian";
import { createModalButton, createModalButtonRow } from "../ModalHelpers";

export interface ConfirmModalOptions {
  title: string;
  body: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export class ConfirmModal extends Modal {
  private readonly options: ConfirmModalOptions;

  constructor(app: App, options: ConfirmModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cashlog-confirm-modal");
    this.titleEl.setText(this.options.title);

    contentEl.createDiv({ cls: "cashlog-confirm-body", text: this.options.body });

    const btnRow = createModalButtonRow(contentEl);
    btnRow.appendChild(
      createModalButton(this.options.cancelText, "secondary", () => {
        this.close();
        this.options.onCancel?.();
      }),
    );
    btnRow.appendChild(
      createModalButton(this.options.confirmText, "primary", () => {
        this.close();
        this.options.onConfirm();
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
