// 测试桩：Obsidian 给 HTMLElement 扩展了 createEl / createSpan / createDiv / empty 等 API。
// Renderer 的渲染逻辑依赖这些扩展，这里提供最小可用替身，
// 让「渲染结果」可以在 Node 下被断言，而不需要真实 DOM。
export class FakeElement {
  tag: string;
  cls: string[] = [];
  children: FakeElement[] = [];
  // 属于本元素自身的文本片段（按写入顺序）
  own: string[] = [];
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  parent: FakeElement | null = null;
  // 滚动状态：真实容器在内容塌陷时会被浏览器把 scrollTop 钳到 0，
  // 这里显式建模该行为，否则「先清空再重建导致面板跳顶」这类缺陷测不出来。
  scrollTop = 0;

  constructor(tag = "div") {
    this.tag = tag;
  }

  empty(): void {
    this.children = [];
    this.own = [];
    // 内容清空 → 高度塌陷 → 浏览器把 scrollTop 归零
    this.scrollTop = 0;
  }

  addClass(c: string): void {
    if (!this.cls.includes(c)) this.cls.push(c);
  }

  removeClass(c: string): void {
    this.cls = this.cls.filter((x) => x !== c);
  }

  hasClass(c: string): boolean {
    return this.cls.includes(c);
  }

  createEl(tag: string, opts: { cls?: string; text?: string; attr?: Record<string, string> } = {}): FakeElement {
    const el = new FakeElement(tag);
    if (opts.cls) el.addClass(opts.cls);
    if (opts.text !== undefined) el.own.push(String(opts.text));
    if (opts.attr) el.attrs = { ...opts.attr };
    el.parent = this;
    this.children.push(el);
    return el;
  }

  createDiv(opts: { cls?: string; text?: string } = {}): FakeElement {
    return this.createEl("div", opts);
  }

  createSpan(opts: { cls?: string; text?: string } = {}): FakeElement {
    return this.createEl("span", opts);
  }

  // 原生 DOM 属性：代码里大量使用 el.className = "a b"，需要与 cls 数组保持同步
  get className(): string {
    return this.cls.join(" ");
  }

  set className(value: string) {
    this.cls = String(value).split(/\s+/).filter(Boolean);
  }

  appendChild(node: FakeElement): FakeElement {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  // Element.append(...nodes)：字符串并入自身文本，元素挂为子节点
  append(...nodes: (string | FakeElement)[]): void {
    for (const n of nodes) {
      if (typeof n === "string") this.own.push(n);
      else this.appendChild(n);
    }
  }

  // 沿 parent 链向上查找（renderAccountList 用 closest 定位面板容器以触发整面板刷新）
  closest(cls: string): FakeElement | null {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.cls.includes(cls)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  setText(value: string): void {
    this.own = [String(value)];
  }

  // 与真实 DOM 行为一致：读取返回整棵子树的文本，写入会清空子节点。
  // 代码里存在 `el.textContent = "..."` 的直接赋值，缺少该 setter 会导致断言读不到文本。
  get textContent(): string {
    const parts = [...this.own];
    for (const child of this.children) parts.push(child.textContent);
    return parts.join("");
  }

  set textContent(value: string) {
    this.own = [String(value)];
    this.children = [];
  }

  // 事件绑定在断言中不需要
  addEventListener(): void {}

  // Obsidian 的 appendText：追加纯文本到元素末尾
  appendText(text: string): void {
    this.own.push(String(text));
  }

  // Obsidian 的 insertAdjacentText：记录到自身，供文本收集使用
  insertAdjacentText(_where: string, value: string): void {
    this.own.push(String(value));
  }
}

// 按渲染顺序递归收集整棵元素树的文本
export function collectText(el: FakeElement): string {
  const parts = [...el.own];
  for (const child of el.children) parts.push(collectText(child));
  return parts.join("");
}

// 收集所有带指定 class 的元素文本（用于精确断言某一类节点的输出）
export function textsWithClass(el: FakeElement, cls: string): string[] {
  const out: string[] = [];
  if (el.hasClass(cls)) out.push(collectText(el));
  for (const child of el.children) out.push(...textsWithClass(child, cls));
  return out;
}
