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
  // 事件监听按类型登记，供 dispatch() 触发。真实 DOM 里 listener 随元素一起被丢弃，
  // 这里也只在元素本身上存，重建 DOM 后旧监听自然不再被派发到。
  listeners: Record<string, ((evt?: unknown) => void)[]> = {};
  // 模拟 input/textarea 的当前值：TextComponent 桩会用，断言「输入框里是什么」时要读
  value = "";
  // 是否被聚焦（focus()/blur() 记账，用来断言输入框抢到焦点）
  focused = false;

  constructor(tag = "div") {
    this.tag = tag;
  }

  // 元素是否仍挂在某棵树上。真实浏览器里元素被移除后不再收到后续 click，
  // 「点一下没反应」类缺陷要靠它区分「逻辑没连上」和「元素已被重建」。
  detached = false;

  isAttached(): boolean {
    return !this.detached;
  }

  // 与真实 DOM 一致：只有仍连着父节点时才算连接在文档里
  get isConnected(): boolean {
    return !this.detached && this.parent !== null;
  }

  // 元素被移出文档：把它和整棵子树标记为 detached
  markDetached(): void {
    this.detached = true;
    for (const child of this.children) child.markDetached();
  }

  // 从父节点移除自身，并让整棵子树失效（真实 DOM 里后续事件不会再到达）
  remove(): void {
    if (!this.parent) {
      // 真实 Obsidian 的 remove() 内部走 parentNode.removeChild，
      // 节点已脱离时会抛 NotFoundError —— 「同一个元素被移除两次」正是靠它暴露的。
      throw new Error(
        "NotFoundError: The node to be removed is no longer a child of this node",
      );
    }

    // 真实浏览器移除仍持有焦点的元素时会先派发 blur，浏览器报错信息里
    // 「Perhaps it was moved in a 'blur' event handler?」说的就是这条连锁。
    // 先落焦点再派发，避免回调里再次找到同一个元素而无限递归。
    for (const focused of this.collectFocused()) {
      focused.focused = false;
      focused.dispatch("blur", {});
    }

    // blur 回调可能已经把整棵子树移除了
    if (!this.parent) {
      this.markDetached();
      return;
    }

    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
    this.markDetached();
  }

  focus(): void {
    this.focused = true;
  }

  blur(): void {
    this.focused = false;
  }

  select(): void {}

  dispatch(type: string, evt: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(evt);
  }

  empty(): void {
    // 真实浏览器在移除一个仍有焦点的元素时会先派发 blur。
    // 很多「点了没反应 / 状态错乱」就来自这条连锁（blur 回调又改了状态或再次渲染），
    // 所以桩必须如实建模；否则重建导致的失焦后果永远测不出来。
    // 每个 blur 回调自己负责防重入（done 标志），递归会在那里终止。
    for (const focused of this.collectFocused()) focused.dispatch("blur", {});
    // 真实 DOM 移除子树后，这些元素不会再收到事件
    for (const child of this.children) child.markDetached();
    this.children = [];
    this.own = [];
    // 内容清空 → 高度塌陷 → 浏览器把 scrollTop 归零
    this.scrollTop = 0;
  }

  // 收集本子树里当前持有焦点的元素（按先序）
  private collectFocused(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      if (el.focused) out.push(el);
      for (const child of el.children) walk(child);
    };
    walk(this);
    return out;
  }

  // 与真实 DOM 的 classList 一致：允许一次传入多个类名（"a b" 拆成两个）。
  // 不拆的话 hasClass("b") 永远为 false，选择器断言会整片失效。
  addClass(...names: string[]): void {
    for (const name of names) {
      for (const c of String(name).split(/\s+/).filter(Boolean)) {
        if (!this.cls.includes(c)) this.cls.push(c);
      }
    }
  }

  removeClass(...names: string[]): void {
    const drop = new Set(names.flatMap((n) => String(n).split(/\s+/).filter(Boolean)));
    this.cls = this.cls.filter((x) => !drop.has(x));
  }

  hasClass(c: string): boolean {
    return this.cls.includes(c);
  }

  // Obsidian 的 toggleClass(cls, on?)：on 省略时按当前状态取反
  toggleClass(c: string, on?: boolean): void {
    const shouldAdd = on ?? !this.hasClass(c);
    if (shouldAdd) this.addClass(c);
    else this.removeClass(c);
  }

  // 真实 DOM 的 classList：ModalHelpers 等代码会直接用它
  get classList(): {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
    toggle: (name: string, force?: boolean) => void;
  } {
    return {
      add: (...names: string[]) => this.addClass(...names),
      remove: (...names: string[]) => this.removeClass(...names),
      contains: (name: string) => this.hasClass(name),
      toggle: (name: string, force?: boolean) => this.toggleClass(name, force),
    };
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

  // Obsidian 的 createSvg：在元素内建一个 svg 子节点（图标、日历按钮都走它）
  createSvg(tag: string, opts: { cls?: string; attr?: Record<string, string> } = {}): FakeElement {
    return this.createEl(tag, opts);
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

  // 选择器：只支持本次代码实际用到的形态 —— ".class" 与裸 tag。
  // 真实 DOM 的 querySelector 支持完整 CSS，桩不做无谓的兼容。
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (el: FakeElement): boolean =>
      selector.startsWith(".") ? el.hasClass(selector.slice(1)) : el.tag === selector;

    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (matches(child)) out.push(child);
        if (child.isAttached()) walk(child);
      }
    };
    walk(this);
    return out;
  }

  // 事件监听：真实 DOM 里 listener 由元素持有，元素被移除则不再触发。
  // 这里照样存在元素上，配合 dispatch() 就能在 Node 下复现点击路径。
  addEventListener(type: string, fn: (evt?: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  // 属性读写：真实 DOM 有 setAttribute/getAttribute，桩里记录到 attrs
  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

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
