/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { Events, MarkdownRenderChild, Plugin, TFile } from "obsidian";
import { CashlogSettings, createDefaultSettings } from "./Settings";
import { CashlogSettingsTab } from "./SettingsTab";
import { addCommands, createOrEdit } from "./Commands";
import { ChartModal } from "./ChartModal";
import { Cache } from "./Cache";
import { resolveEntryLine } from "./EntryLocator";
import { Query, withGlobalQuery } from "./Query/Query";
import { renderQueryResult } from "./Renderer";
import { CashlogChartRenderChild } from "./ChartRenderer";
import { AttachmentManager } from "./AttachmentManager";
import { AccountManager } from "./AccountManager";
import { BudgetManager } from "./BudgetManager";
import { CashlogView, CASHLOG_VIEW_TYPE } from "./CashlogView";
import { initI18n, t, tp, setCurrencyOverride } from "./i18n";

export default class CashlogPlugin extends Plugin {
  settings: CashlogSettings = createDefaultSettings();
  cache!: Cache;
  events = new Events();
  attachmentManager!: AttachmentManager;
  accountManager!: AccountManager;
  budgetManager!: BudgetManager;
  // 渲染刷新防抖定时器
  private refreshTimer: number | null = null;
  // 设置保存防抖定时器
  private saveTimer: number | null = null;

  async onload() {
    initI18n();
    await this.loadSettings();

    // 初始化管理器
    this.attachmentManager = new AttachmentManager(this.app, this.app.vault, this.settings);
    this.accountManager = new AccountManager();
    this.budgetManager = new BudgetManager();

    // 初始化缓存
    this.cache = new Cache(this.app.vault, this.app.metadataCache, this.events, this.settings);

    // 注册命令
    addCommands(this);

    // 左侧栏图标：一键打开面板（复用已有的 activateCashlogPanel）
    this.addRibbonIcon("coins", t("commands.openPanel"), () => {
      void this.activateCashlogPanel();
    });

    // 编辑器右键菜单。
    // 一级保留「创建/编辑记账」；「账目图表」优先挂进 Obsidian 内置的「插入」
    // 子菜单（与插入链接/表格/Callout 等并列），拿不到内置子菜单时回退到一级。
    // 两个动作都依赖「光标所在行」，所以放右键而不是 ribbon：
    // 右键不移动焦点，editor.getCursor() 才是用户真正想操作的那一行。
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((item) =>
          item
            .setTitle(t("commands.createOrEdit"))
            .setIcon("square-pen")
            .onClick(() => {
              createOrEdit(false, editor, view, this);
            }),
        );

        // Obsidian 的「插入」「段落格式」等分组并不是 MenuItem 的子菜单，
        // 而是由 MenuItem.setSection 指定同一 section 前缀后，由 Obsidian 在渲染时
        // 合并成一个可展开菜单。实测「插入」组分为 selection.insert.basic 与
        // selection.insert.advanced 两段；账目图表本质是代码块，因此归入 advanced，
        // 与「代码块 / 数学块 / 新建数据库」并列。
        menu.addItem((item) =>
          item
            .setTitle(t("menu.chart"))
            .setIcon("chart-column")
            .setSection("selection.insert.advanced")
            .onClick(() => {
              new ChartModal(this.app, this, editor).open();
            }),
        );
      }),
    );

    // 注册 Cashlog 面板视图
    this.registerView(CASHLOG_VIEW_TYPE, (leaf) => new CashlogView(leaf, this));

    // 注册设置页
    this.addSettingTab(new CashlogSettingsTab(this.app, this));

    // 注册 cashlog 代码块处理器
    this.registerMarkdownCodeBlockProcessor("cashlog", (source, el, ctx) => {
      this.app.workspace.onLayoutReady(() => {
        const child = new CashlogRenderChild(el, source, this);
        ctx.addChild(child);
      });
    });

    // 注册 cashlog-chart 代码块处理器（动态表格）
    this.registerMarkdownCodeBlockProcessor("cashlog-chart", (source, el, ctx) => {
      this.app.workspace.onLayoutReady(() => {
        const child = new CashlogChartRenderChild(el, source, this);
        ctx.addChild(child);
      });
    });

    // 监听缓存更新事件，触发重渲染（带防抖：一次编辑可能触发多次 cache 更新，
    // 每次都全量重建代码块与图表实例会造成明显卡顿）
    this.events.on("cashlog-cache-update", () => this.scheduleRenderRefresh());

    // 监听文件变更以更新缓存
    this.app.workspace.onLayoutReady(async () => {
      await this.cache.initialize();

      this.registerEvent(
        this.app.vault.on("modify", async (file) => {
          if (file instanceof TFile && file.extension === "md") {
            await this.cache.onFileChanged(file);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on("create", async (file) => {
          if (file instanceof TFile && file.extension === "md") {
            await this.cache.onFileCreated(file);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (file instanceof TFile) {
            this.cache.onFileDeleted(file);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on("rename", async (file, oldPath) => {
          if (file instanceof TFile && file.extension === "md") {
            await this.cache.onFileRenamed(file, oldPath);
          }
        }),
      );
    });
  }

  // 合并短时间内的多次缓存更新，只触发一次重渲染：
  // 一次编辑可能引发多份文件写入，逐次全量重建代码块与图表实例会明显卡顿。
  private scheduleRenderRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.events.trigger("cashlog-render-refresh");
    }, 150);
  }

  // 文本输入框专用：连续输入时只在停顿后写一次磁盘。
  // 直接 saveSettings() 会在每个字符上写 data.json，
  // 全局查询、附件目录这类长文本尤其明显。
  saveSettingsDebounced(delay = 300): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveSettings();
    }, delay);
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<CashlogSettings> | null;
    // 用深拷贝的默认值兜底：浅拷贝会让 settings 与 DEFAULT_SETTINGS 共享数组/对象，
    // 就地修改（例如新增账户）会永久污染默认值，使「恢复默认」失效。
    this.settings = Object.assign(createDefaultSettings(), loaded ?? {});
    this.cache?.updateSettings(this.settings);
    // 应用货币符号设置（空表示跟随当前语言默认）
    setCurrencyOverride(this.settings.currencySymbol);
  }

  async saveSettings() {
    // 设置变更后立即生效：货币符号不需要等下次重载
    setCurrencyOverride(this.settings.currencySymbol);
    await this.saveData(this.settings);
    this.events.trigger("cashlog-render-refresh");
  }

  // 保存设置并重建缓存（路径设置变更时调用）
  async saveSettingsAndReindex() {
    await this.saveData(this.settings);
    this.cache.updateSettings(this.settings);
    await this.cache.reindex();
  }

  // 将行替换写入对应文件（migrateTag / migrateAccount 共用）
  // 行号来自缓存快照，写入前必须在最新文件内容里重新定位，
  // 否则文件被外部改动（同步、其它编辑器）后会改写到别的行上。
  private async applyLineReplacements(
    fileChanges: Map<string, Map<number, { original: string; newLine: string }>>,
  ): Promise<void> {
    for (const [filePath, lineChanges] of fileChanges) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;

      await this.app.vault.process(file, (content) => {
        const lines = content.split("\n");
        // 倒序处理，避免多条重定位之间互相影响
        const changes = [...lineChanges.entries()].sort((a, b) => b[0] - a[0]);
        for (const [lineNumber, change] of changes) {
          const targetLine = resolveEntryLine(lines, change.original, lineNumber);
          if (targetLine === null) continue;
          lines[targetLine] = change.newLine;
        }
        return lines.join("\n");
      });
    }
  }

  // 标签迁移：将缓存中所有旧标签替换为新标签，保留子标签
  async migrateTag(oldTag: string, newTag: string): Promise<number> {
    const entries = this.cache.getEntries();
    const fileChanges = new Map<string, Map<number, { original: string; newLine: string }>>();
    let migrationCount = 0;

    for (const entry of entries) {
      if (!entry.location) continue;

      let changed = false;
      const newTags = entry.tags.map((t) => {
        // 精确匹配旧标签（不区分大小写）
        if (t.toLowerCase() === oldTag.toLowerCase()) {
          changed = true;
          return newTag;
        }
        // 前缀匹配：旧标签/子标签 → 新标签/子标签
        if (t.toLowerCase().startsWith(oldTag.toLowerCase() + "/")) {
          changed = true;
          return newTag + t.substring(oldTag.length);
        }
        return t;
      });

      if (!changed) continue;

      const updatedEntry = entry.clone({ tags: newTags });
      const newLine = updatedEntry.toFileLineString();

      if (!fileChanges.has(entry.location.path)) {
        fileChanges.set(entry.location.path, new Map());
      }
      fileChanges.get(entry.location.path)!.set(entry.location.lineNumber, {
        original: entry.originalMarkdown,
        newLine,
      });
      migrationCount++;
    }

    if (migrationCount === 0) return 0;

    await this.applyLineReplacements(fileChanges);
    await this.cache.reindex();
    return migrationCount;
  }

  // 按标签删除所有关联的记账条目
  async deleteEntriesByTag(tag: string): Promise<number> {
    const entries = this.cache.getEntries();
    const fileTargets = new Map<string, { line: number; original: string }[]>();

    for (const entry of entries) {
      if (!entry.location) continue;
      const hasTag = entry.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
      if (!hasTag) continue;

      if (!fileTargets.has(entry.location.path)) {
        fileTargets.set(entry.location.path, []);
      }
      fileTargets.get(entry.location.path)!.push({
        line: entry.location.lineNumber,
        original: entry.originalMarkdown,
      });
    }

    if (fileTargets.size === 0) return 0;

    let deletedCount = 0;

    // 逐个文件删除行；删除前重新定位，定位不到的行跳过（宁可少删，也不能删错行）
    for (const [filePath, targets] of fileTargets) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;

      await this.app.vault.process(file, (content) => {
        const lines = content.split("\n");
        const resolved = targets
          .map((target) => resolveEntryLine(lines, target.original, target.line))
          .filter((line): line is number => line !== null);
        // 倒序删除，避免行号偏移
        resolved.sort((a, b) => b - a);
        for (const lineNumber of resolved) {
          lines.splice(lineNumber, 1);
        }
        deletedCount += resolved.length;
        return lines.join("\n");
      });
    }

    await this.cache.reindex();
    return deletedCount;
  }

  // 账户迁移：将缓存中所有旧账户名替换为新账户名
  async migrateAccount(oldName: string, newName: string): Promise<number> {
    const entries = this.cache.getEntries();
    const fileChanges = new Map<string, Map<number, { original: string; newLine: string }>>();
    let count = 0;

    for (const entry of entries) {
      if (!entry.location) continue;

      const hasOld = entry.accountAmounts.some((aa) => aa.account === oldName);
      if (!hasOld) continue;

      const newAccountAmounts = entry.accountAmounts.map((aa) => ({
        ...aa,
        account: aa.account === oldName ? newName : aa.account,
      }));

      const newLine = entry.clone({ accountAmounts: newAccountAmounts }).toFileLineString();

      if (!fileChanges.has(entry.location.path)) {
        fileChanges.set(entry.location.path, new Map());
      }
      fileChanges.get(entry.location.path)!.set(entry.location.lineNumber, {
        original: entry.originalMarkdown,
        newLine: newLine,
      });
      count++;
    }

    if (count === 0) return 0;

    await this.applyLineReplacements(fileChanges);
    await this.cache.reindex();
    return count;
  }

  // 打开 Cashlog 面板
  async activateCashlogPanel(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(CASHLOG_VIEW_TYPE);
    if (leaves.length > 0) {
      await this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: CASHLOG_VIEW_TYPE,
        active: true,
      });
    }
  }
}

// 代码块渲染子组件，支持自动刷新
class CashlogRenderChild extends MarkdownRenderChild {
  private source: string;
  private plugin: CashlogPlugin;

  constructor(containerEl: HTMLElement, source: string, plugin: CashlogPlugin) {
    super(containerEl);
    this.source = source;
    this.plugin = plugin;
  }

  onload() {
    // 等索引就绪再首次渲染，避免首屏读到空缓存而短暂显示「暂无数据」。
    // 索引完成后会触发 cache-update → render-refresh，届时还会再刷新一次。
    void this.plugin.cache.whenReady().then(() => this.render());
    this.registerEvent(
      this.plugin.events.on("cashlog-render-refresh", () => {
        this.render();
      }),
    );
  }

  private render() {
    const query = new Query(
      withGlobalQuery(this.source, this.plugin.settings.globalQuery),
      this.plugin.settings,
    );
    const error = query.getError();

    if (error) {
      this.containerEl.empty();
      this.containerEl.createDiv({
        cls: "cashlog-error",
        text: tp("error.queryError", { error }),
      });
      return;
    }

    const entries = this.plugin.cache.getEntries();
    const result = query.apply(entries);
    renderQueryResult(this.containerEl, result, query, this.plugin);
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
