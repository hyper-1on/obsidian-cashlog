// 标签树：一个标签节点可以带任意深度的子标签。
//
// 为什么要用树而不是扁平字符串数组（旧版 expenseSubTags: ["餐饮/午餐"]）：
// - 加子标签 = 往 children 里 push，不用拼字符串
// - 改名 = 改一处 name，不用遍历改掉所有 "餐饮/*"
// - 删除父标签 = 删节点，不用扫前缀
// - 渲染树 / 级联下拉可以直接遍历
//
// 笔记里的标签仍然是 "#支出/餐饮/午餐" 这种字符串，树只存在于设置里。
export interface TagNode {
  name: string;
  children?: TagNode[];
}

// 标签的显示形式：去掉 Obsidian 的 "#" 前缀。
//
// "#" 属于笔记的序列化格式 —— 写盘时必须带上，否则 Obsidian 不认它是标签。
// 但它不是界面语言：用户在列表、图例、勾选项里应该只看到词条本身。
// 所以「值」一律保持带 "#"，「呈现给用户的文字」一律经过这里。
export function parseTagText(tag: string): string {
  return tag.replace(/^#/, "");
}

// 标签路径匹配：target 是否命中 entryTag 所在的这一支。
// 按 "/" 边界判断，命中三种位置：等于自身、开头（下级）、中间层级、结尾。
// 查询过滤器与预算/目标的标签筛选共用这一套规则，
// 否则 "支出/餐饮" 会把 "支出/餐饮娱乐" 也算进来。
export function tagPathMatches(entryTag: string, target: string): boolean {
  const t = parseTagText(entryTag).toLowerCase();
  const g = parseTagText(target).toLowerCase();
  if (t === g || t.startsWith(g + "/")) return true;
  return t.includes("/" + g + "/") || t.endsWith("/" + g);
}

// 单段名称校验（不含 "/"：层级由树表达）
export function validateTagSegment(name: string): { valid: boolean; message?: string } {
  if (!name || !name.trim()) return { valid: false, message: "tag.segment.empty" };
  if (name.includes(" ")) return { valid: false, message: "tag.segment.hasSpace" };
  if (name.includes("/")) return { valid: false, message: "tag.segment.hasSlash" };
  if (!/^[\p{L}\p{N}_-]+$/u.test(name)) return { valid: false, message: "tag.segment.invalidChars" };
  return { valid: true };
}

// 完整路径校验（"餐饮/午餐"）
// 空段一律拒绝：a//b、/a、a/ 都会拼出坏标签
export function validateTagPath(path: string): { valid: boolean; message?: string } {
  const segs = path.split("/");
  if (segs.some((s) => s.trim() === "")) return { valid: false, message: "tag.path.emptySegment" };
  for (const seg of segs) {
    const r = validateTagSegment(seg);
    if (!r.valid) return r;
  }
  return { valid: true };
}

// 旧扁平格式 → 树
// ["餐饮", "餐饮/午餐", "交通"] → [{name:"餐饮",children:[{name:"午餐"}]}, {name:"交通"}]
export function legacyToTree(flat: string[]): TagNode[] {
  const roots: TagNode[] = [];

  for (const item of flat) {
    const path = item.split("/").map((s) => s.trim()).filter((s) => s !== "");
    if (path.length === 0) continue;

    let level = roots;
    for (let i = 0; i < path.length; i++) {
      const name = path[i];
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = { name };
        level.push(node);
      }
      if (i < path.length - 1) {
        node.children ??= [];
        level = node.children;
      }
    }
  }

  return pruneEmptyNodes(roots);
}

// 清理空节点：空名、以及"清理后 children 变成空数组"的节点
export function pruneEmptyNodes(nodes: TagNode[]): TagNode[] {
  const out: TagNode[] = [];
  for (const node of nodes) {
    const name = node.name.trim();
    if (name === "") continue;
    const children = node.children ? pruneEmptyNodes(node.children) : undefined;
    out.push(children && children.length > 0 ? { name, children } : { name });
  }
  return out;
}

// 树 → 扁平路径（用于导出、调试、和旧字段对照）
export function flattenTree(nodes: TagNode[], prefix = ""): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    out.push(path);
    if (node.children && node.children.length > 0) {
      out.push(...flattenTree(node.children, path));
    }
  }
  return out;
}

// 按路径数组查找节点
export function findNode(nodes: TagNode[], path: string[]): TagNode | null {
  if (path.length === 0) return null;
  const [head, ...rest] = path;
  const node = nodes.find((n) => n.name === head);
  if (!node) return null;
  if (rest.length === 0) return node;
  return findNode(node.children ?? [], rest);
}

// 在 parentPath 下添加子节点；已存在则返回 false
export function addChild(nodes: TagNode[], parentPath: string[], name: string): boolean {
  const clean = name.trim();
  if (clean === "") return false;

  if (parentPath.length === 0) {
    if (nodes.some((n) => n.name === clean)) return false;
    nodes.push({ name: clean });
    return true;
  }

  const parent = findNode(nodes, parentPath);
  if (!parent) return false;
  parent.children ??= [];
  if (parent.children.some((n) => n.name === clean)) return false;
  parent.children.push({ name: clean });
  return true;
}

// 删除某个路径的节点（同时删除其子树）
export function removeNode(nodes: TagNode[], path: string[]): boolean {
  if (path.length === 0) return false;
  const [head, ...rest] = path;

  const idx = nodes.findIndex((n) => n.name === head);
  if (idx === -1) return false;

  if (rest.length === 0) {
    nodes.splice(idx, 1);
    return true;
  }

  const node = nodes[idx];
  if (!node.children) return false;
  const removed = removeNode(node.children, rest);
  // 子节点全部删完后清掉空 children，保持树整洁
  if (removed && node.children.length === 0) delete node.children;
  return removed;
}

// 把完整标签转成显示用的分组键：
// - 去掉开头的 "#"（Markdown 语法标记，放在表格/图例里只是噪音）
// - 按 level 截断子标签深度（level 1 = 一级子标签）
// 主标签本身保留，公共前缀的省略由 stripCommonPrefix 负责。
export function tagToGroupKey(
  fullTag: string,
  mainTag: string,
  level: number | undefined,
): string {
  const withoutHash = parseTagText(fullTag);
  const mainNoHash = parseTagText(mainTag);
  const segs = withoutHash.split("/");

  // 主标签占第一段，子标签从第二段开始
  const subSegs = segs[0] === mainNoHash ? segs.slice(1) : segs;
  const depth = level && level > 0 ? level : 1;
  const kept = subSegs.slice(0, depth);
  return kept.length > 0 ? `${mainNoHash}/${kept.join("/")}` : mainNoHash;
}

// 计算一组分组键的公共前缀（按 "/" 分段），并去掉它。
// 全是支出时 "支出/餐饮"、"支出/交通" → "餐饮"、"交通"；
// 混排时 "支出/餐饮"、"收入/工资" 公共前缀为空 → 原样返回。
// 至少保留一段：如果所有键都只有一段且完全相同，则不做压缩。
export function stripCommonPrefix(keys: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (keys.length === 0) return result;

  // 先去掉 "#"：Markdown 语法标记放在标题/图例里只是噪音
  const cleaned = new Map<string, string>();
  for (const k of keys) cleaned.set(k, parseTagText(k));

  if (keys.length === 1) {
    result.set(keys[0], cleaned.get(keys[0])!);
    return result;
  }

  const split = keys.map((k) => cleaned.get(k)!.split("/"));

  // 找公共前缀长度
  let common = 0;
  while (
    split.every((segs) => segs.length > common + 1) &&
    split.every((segs) => segs[common] === split[0][common])
  ) {
    common += 1;
  }

  for (const key of keys) {
    const plain = cleaned.get(key)!;
    const segs = plain.split("/");
    result.set(key, common > 0 ? segs.slice(common).join("/") : plain);
  }
  return result;
}

/**
 * 把一条选择路径裁剪成「树里真实存在的前缀」。
 *
 * 用途：选择器要把当前值回显成逐级下拉，而当前值可能来自旧数据或已删掉的标签。
 * 不裁剪的话，找不到对应选项的那一级会渲染成空白下拉，而且还会继续往下长出更多空行。
 *
 * 返回第一个断点之前的连续有效段；全部无效返回空数组。
 */
export function trimPathToTree(path: string[], nodes: TagNode[]): string[] {
  const out: string[] = [];
  let level = nodes;

  for (const name of path) {
    const node = level.find((n) => n.name === name);
    if (!node) break;
    out.push(name);
    level = node.children ?? [];
  }

  return out;
}
