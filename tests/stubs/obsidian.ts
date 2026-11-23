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
export class Modal {
  constructor(public app?: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}
// Obsidian 的 UI 组件类：仅在类型标注处被引用，测试中不实例化
export class SliderComponent {}
export class TextComponent {}
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
    this.controlEl = stubEl(this.settingEl, { cls: "setting-item-control" }) ?? this.settingEl;
  }

  setName(name: string): this {
    this.nameEl = stubEl(this.settingEl, { cls: "setting-item-name", text: name });
    return this;
  }

  setDesc(desc: string): this {
    this.descEl = stubEl(this.settingEl, { cls: "setting-item-description", text: desc });
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

export function setIcon(): void {}
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
