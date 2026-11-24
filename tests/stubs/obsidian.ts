// 测试桩：提供 src 逻辑层所 import 的 Obsidian API 符号。
// 只有类型层面被引用的符号无需真实实现；这里给出最小可用替身，
// 让 Query / FilterParser / CashlogSerializer / EntryEditor 等纯逻辑可在 Node 下运行。
import momentLib from "moment";
import { FakeElement } from "./dom";

export const moment = momentLib;

// ---- 事件总线 ----
export class Events {
  private handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  on(name: string, cb: (...args: unknown[]) => void): { name: string; cb: (...args: unknown[]) => void } {
    (this.handlers[name] ??= []).push(cb);
    return { name, cb };
  }

  off(name: string, cb: (...args: unknown[]) => void): void {
    this.handlers[name] = (this.handlers[name] ?? []).filter((h) => h !== cb);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const h of this.handlers[name] ?? []) h(...args);
  }
}

// ---- 占位类（仅类型断言用） ----
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export class Vault {}
export class MetadataCache {}
export class Notice {}
// Modal 的最小替身：open() 会触发 onOpen()，与真实行为一致，
// 这样弹窗的渲染逻辑（TagTreeModal.render 等）能在 Node 下真正跑一遍并被断言。
export class Modal {
  modalEl: FakeElement;
  titleEl: FakeElement;
  contentEl: FakeElement;

  constructor(public app?: unknown) {
    this.modalEl = new FakeElement("div");
    this.titleEl = new FakeElement("div");
    this.contentEl = new FakeElement("div");
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
  }

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}
// Obsidian 的 UI 组件类：仅在类型标注处被引用，测试中不实例化
export class SliderComponent {}
// TextComponent：真实实现会在宿主元素里建一个 <input>，并把 inputEl 暴露出来。
// 这里用 FakeElement 模拟，focus / blur / keydown 都能被 dispatch 复现。
export class TextComponent {
  inputEl: FakeElement;
  private value = "";
  private changeCb: ((v: string) => void) | null = null;

  constructor(parent?: unknown) {
    const host = parent as { createEl?: (t: string, o?: unknown) => FakeElement } | null;
    this.inputEl =
      host && typeof host.createEl === "function"
        ? host.createEl("input", { cls: "text-component-input" })
        : new FakeElement("input");
  }

  setValue(v: string): this {
    this.value = String(v);
    this.inputEl.value = this.value;
    return this;
  }

  getValue(): string {
    return this.value;
  }

  setPlaceholder(p: string): this {
    this.inputEl.setAttribute("placeholder", p);
    return this;
  }

  onChange(cb: (v: string) => void): this {
    this.changeCb = cb;
    return this;
  }

  // 供测试模拟输入
  type(v: string): void {
    this.setValue(v);
    this.changeCb?.(this.value);
  }
}
export class TextAreaComponent {}
export class DropdownComponent {}
export class ButtonComponent {}
export class ToggleComponent {}
export class ExtraButtonComponent {}
// Obsidian Setting 的最小可链式替身。
// 设置页大量使用 new Setting(...).setName(...).addText(...) 的链式调用；
// 没有它既无法在 Node 下跑通 display()，也无法断言某个设置项是否真的渲染出来。
export class Setting {
  settingEl: unknown = null;
  nameEl: unknown = null;
  descEl: unknown = null;
  controlEl: unknown = null;

  constructor(public containerEl?: unknown) {
    this.settingEl = stubEl(containerEl, { cls: "setting-item" }) ?? containerEl ?? null;
    // 真实 Setting 构造时就建好 name / desc 两个槽位（内容是空的），
    // 调用方会直接对 setting.descEl.remove() 或往 nameEl 里填字。
    // 桩里若留 null，这类「先建后删」的写法会在 Node 下炸，而真实环境不会。
    this.nameEl = stubEl(this.settingEl, { cls: "setting-item-name" });
    this.descEl = stubEl(this.settingEl, { cls: "setting-item-description" });
    this.controlEl = stubEl(this.settingEl, { cls: "setting-item-control" }) ?? this.settingEl;
  }

  setName(name: string): this {
    setText(this.nameEl, name);
    return this;
  }

  setDesc(desc: string): this {
    setText(this.descEl, desc);
    return this;
  }

  setHeading(): this {
    return this;
  }
  setClass(): this {
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
  setVisible(): this {
    return this;
  }

  private component(cb: unknown): this {
    const el = stubEl(this.controlEl, { cls: "setting-component" });
    if (el && typeof cb === "function") (cb as (el: unknown) => void)(el);
    return this;
  }

  addText(cb: unknown): this {
    return this.component(cb);
  }
  addTextArea(cb: unknown): this {
    return this.component(cb);
  }
  addButton(cb: unknown): this {
    return this.component(cb);
  }
  addToggle(cb: unknown): this {
    return this.component(cb);
  }
  addDropdown(cb: unknown): this {
    return this.component(cb);
  }
  addSlider(cb: unknown): this {
    return this.component(cb);
  }
  addExtraButton(cb: unknown): this {
    return this.component(cb);
  }
}

// 往 stubEl 造出来的元素里写文本：优先用 FakeElement.setText，退化为 textContent
function setText(el: unknown, text: string): void {
  const e = el as { setText?: (v: string) => void; textContent?: string } | null;
  if (!e) return;
  if (typeof e.setText === "function") e.setText(text);
  else e.textContent = text;
}

// 在容器上造一个元素，并补齐 Obsidian 组件常用的链式方法，
// 使设置页的构建代码可以原样跑完（不做任何真实交互）。
function stubEl(container: unknown, opts: { cls?: string; text?: string } = {}): Record<string, unknown> | null {
  const c = container as { createDiv?: (o: unknown) => unknown } | null;
  if (!c || typeof c.createDiv !== "function") return null;
  const el = c.createDiv(opts) as Record<string, unknown>;
  const chain = (): unknown => el;
  for (const m of [
    "setValue", "onChange", "setPlaceholder", "setButtonText", "setCta", "setDisabled",
    "setTooltip", "addOption", "addOptions", "setLimits", "setDynamicTooltip",
    "setIcon", "setDesc", "setName", "setWarning",
    "onClick", "setButtonText",
  ]) {
    el[m] = chain;
  }
  el.inputEl = el;
  el.buttonEl = el;
  el.selectEl = el;
  return el;
}
export class Plugin {}
export class PluginSettingTab {}
export class MarkdownRenderChild {}
export class MarkdownView {}
export class ItemView {}
export class Editor {}
export class Menu {}
export class Suggest {}
export class EditorSuggest {}
export class App {}
export class Component {}
export class Keymap {
  static isModEvent(): boolean {
    return false;
  }
}

// 建议类（FolderSuggest 继承 AbstractInputSuggest）
export class AbstractInputSuggest<T> {
  constructor(..._args: unknown[]) {}
  setValue(_value: string): void {}
  close(): void {}
  limit = 100;
  onSelect(_cb: (value: T) => void): void {}
  getSuggestions(_query: string): T[] {
    return [];
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  selectSuggestion(_value: T): void {}
}

export class SuggestModal<T> {
  constructor(..._args: unknown[]) {}
  open(): void {}
  close(): void {}
}

export class WorkspaceLeaf {}
export class ViewStateResult {}
export class RequestUrlResponse {}
export class FileSystemAdapter {}
export class DataAdapter {}

export function normalizePath(p: string): string {
  return String(p).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

// setIcon：真实实现往元素里塞一个 <svg>。测试里只记录图标名，
// 便于按 data-icon 定位「改名 / 加子标签 / 删除」这类只由图标标识的按钮。
export function setIcon(el: unknown, icon: string): void {
  const e = el as { setAttribute?: (k: string, v: string) => void } | null;
  e?.setAttribute?.("data-icon", icon);
}
export function getIcon(): null {
  return null;
}

export const Platform = { isDesktop: true, isMobile: false };
// Obsidian 在运行环境里提供全局 activeDocument；面板设置用它创建节点，
// 这里替换成能产出 FakeElement 的最小实现，使面板渲染可以在 Node 下被断言。
export const activeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
} as unknown as Document;

export default { moment };
