/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { Events, MetadataCache, TFile, Vault } from "obsidian";
import { CashlogEntry, EntryLocation } from "./EntryLocation";
import { parseCashlogLine } from "./CashlogSerializer";
import { isPathAllowed } from "./PathUtils";
import type { CashlogSettings } from "./Settings";

// 缓存系统：索引 Vault 中所有记账条目
export class Cache {
  private entries: CashlogEntry[] = [];
  private vault: Vault;
  private metadataCache: MetadataCache;
  private events: Events;
  private settings: CashlogSettings;
  private initialized = false;

  constructor(vault: Vault, metadataCache: MetadataCache, events: Events, settings: CashlogSettings) {
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.events = events;
    this.settings = settings;
  }

  // 更新设置引用（设置变更后调用）
  updateSettings(settings: CashlogSettings): void {
    this.settings = settings;
  }

  // 获取所有记账条目
  getEntries(): CashlogEntry[] {
    return this.entries;
  }

  // 初始化：索引整个 Vault
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.reindex();
    this.initialized = true;
  }

  // 重新索引整个 Vault
  async reindex(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    const allEntries: CashlogEntry[] = [];

    for (const file of files) {
      if (!isPathAllowed(file.path, this.settings.excludePaths, this.settings.includePaths)) {
        continue;
      }
      const entries = await this.parseFile(file);
      allEntries.push(...entries);
    }

    this.entries = allEntries;
    this.events.trigger("cashlog-cache-update");
  }

  // 解析单个文件
  private async parseFile(file: TFile): Promise<CashlogEntry[]> {
    let content: string;
    try {
      content = await this.vault.cachedRead(file);
    } catch {
      return [];
    }

    const fileCache = this.metadataCache.getFileCache(file);
    return parseFileContent(content, this.settings, file.path, fileCache?.headings);
  }

  // 处理文件修改事件（增量更新）
  async onFileChanged(file: TFile): Promise<void> {
    if (!isPathAllowed(file.path, this.settings.excludePaths, this.settings.includePaths)) {
      return;
    }
    const newEntries = await this.parseFile(file);
    // 移除旧条目，加入新条目
    this.entries = this.entries.filter((e) => e.location?.path !== file.path);
    this.entries.push(...newEntries);
    this.events.trigger("cashlog-cache-update");
  }

  // 处理文件创建事件（增量更新）
  async onFileCreated(file: TFile): Promise<void> {
    if (!isPathAllowed(file.path, this.settings.excludePaths, this.settings.includePaths)) {
      return;
    }
    const newEntries = await this.parseFile(file);
    this.entries.push(...newEntries);
    this.events.trigger("cashlog-cache-update");
  }

  // 处理文件删除事件（增量更新）
  onFileDeleted(file: TFile): void {
    this.entries = this.entries.filter((e) => e.location?.path !== file.path);
    this.events.trigger("cashlog-cache-update");
  }

  // 处理文件重命名事件（重新解析后用新路径替换旧路径条目）
  async onFileRenamed(file: TFile, oldPath: string): Promise<void> {
    if (!isPathAllowed(file.path, this.settings.excludePaths, this.settings.includePaths)) {
      // 新路径不在允许范围内，移除所有旧路径条目
      this.entries = this.entries.filter((e) => e.location?.path !== oldPath);
    } else {
      const newEntries = await this.parseFile(file);
      this.entries = this.entries.filter((e) => e.location?.path !== oldPath);
      this.entries.push(...newEntries);
    }
    this.events.trigger("cashlog-cache-update");
  }
}

// 查找某行之前最近的标题
function findPrecedingHeading(
  headings: { heading: string; position: { start: { line: number } } }[] | undefined,
  lineNumber: number,
): string | null {
  if (!headings) return null;

  let lastHeading: string | null = null;
  for (const h of headings) {
    if (h.position.start.line < lineNumber) {
      lastHeading = h.heading;
    } else {
      break;
    }
  }
  return lastHeading;
}

// 围栏代码块的开始/结束行（支持 ``` 与 ~~~，允许少量缩进与引用前缀）
const FENCE_REGEX = /^\s{0,3}(?:>\s*)*(```+|~~~+)/;

// 解析一份 Markdown 内容里的全部记账条目。
//
// 会跳过围栏代码块内部的行：用户经常把示例条目写进代码块（文档、模板、
// bug 记录、教程），不跳过就会把它们当成真实记账，计入查询、统计与账户余额。
export function parseFileContent(
  content: string,
  settings: CashlogSettings,
  path: string,
  headings?: { heading: string; position: { start: { line: number } } }[],
): CashlogEntry[] {
  const lines = content.split("\n");
  const entries: CashlogEntry[] = [];
  let fenceMarker: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = line.match(FENCE_REGEX);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = null;
      }
      // 不同标记符（``` 与 ~~~）在代码块内部不构成结束行
      continue;
    }
    if (fenceMarker !== null) continue;

    const entry = parseCashlogLine(line, null, settings);
    if (!entry) continue;

    // 只有解析成功才创建 EntryLocation
    const location = new EntryLocation(path, i, i, 0, findPrecedingHeading(headings, i));
    entries.push(entry.clone({ location }));
  }

  return entries;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
