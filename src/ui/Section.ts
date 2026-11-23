// 统一的分区卡片组件。
//
// 面板设置、弹窗、dashboard 三处原本各写一套卡片结构（.cashlog-settings-section /
// .cashlog-modal-group / .cashlog-section），间距、圆角、标题下划线都不一致。
// 这里把结构收拢到一处，视觉由 styles.css 的 --cashlog-sect-* token 控制，
// 各调用方只负责往返回的 body 里填内容。
//
// 扩展点：
// - options.cls     追加自定义类，便于局部微调而不复制整套样式
// - options.render  自定义 body 渲染，便于插入任意内容
// - 返回值是 body   调用方可直接在 body 上继续追加控件
export interface SectionOptions {
  /** 分区标题（可选） */
  title?: string;
  /** 标题下方的一句说明（可选） */
  desc?: string;
  /** 追加到 .cashlog-section 上的自定义类 */
  cls?: string;
  /** 自定义 body 渲染 */
  render?: (body: HTMLElement) => void;
}

export function createSection(
  parent: HTMLElement,
  options: SectionOptions = {},
): HTMLElement {
  const section = parent.createDiv({ cls: "cashlog-section" });
  if (options.cls) section.addClass(options.cls);

  if (options.title) {
    section.createDiv({ cls: "cashlog-section-title", text: options.title });
  }
  if (options.desc) {
    section.createDiv({ cls: "cashlog-section-desc", text: options.desc });
  }

  const body = section.createDiv({ cls: "cashlog-section-body" });
  if (options.render) options.render(body);
  return body;
}
