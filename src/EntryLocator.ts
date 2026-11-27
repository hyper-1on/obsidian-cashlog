// 在最新文件内容中定位某个记账条目所在的行号。
//
// 缓存里的 lineNumber 是索引时刻的快照：外部编辑器、同步工具或插件外部的
// 批量改动都会让它失效。直接按旧行号写回会改写别的行，破坏用户数据。
// 定位策略（保守优先，宁可报错也不改错行）：
//   1. 原行号处内容仍与索引时一致 → 直接使用（文件在该行之后变化不影响它）
//   2. 否则在整个文件中寻找唯一的相同行 → 使用它（文件在该行之前插入内容的情况）
//   3. 都无法确定（行内容已变，或存在多行重复）→ 返回 null，由调用方提示用户刷新
export function resolveEntryLine(
  lines: string[],
  originalMarkdown: string,
  preferredLine: number,
): number | null {
  const inRange = preferredLine >= 0 && preferredLine < lines.length;

  if (!originalMarkdown) {
    return inRange ? preferredLine : null;
  }

  if (inRange && lines[preferredLine] === originalMarkdown) {
    return preferredLine;
  }

  let found = -1;
  let matchCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === originalMarkdown) {
      matchCount++;
      found = i;
      if (matchCount > 1) break;
    }
  }

  return matchCount === 1 ? found : null;
}

// 同上，直接接受 CashlogEntry
export function resolveEntryLineForEntry(
  lines: string[],
  entry: CashlogEntry,
): number | null {
  if (!entry.location) return null;
  return resolveEntryLine(lines, entry.originalMarkdown, entry.location.lineNumber);
}
