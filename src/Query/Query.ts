/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { CashlogEntry } from "../EntryLocation";
import { FilterFunction, Sorter, Grouper, QueryResult, EntryGroup, Summary } from "./Filter";
import { parseFilter } from "./FilterParser";
import type { CashlogSettings } from "../Settings";
import { round2 } from "../MoneyUtils";
import { tagToGroupKey } from "../TagTree";
import { t, tp } from "../i18n";

// 表格列配置
export interface TableColConfig {
  field: "date" | "amount" | "description" | "link" | "account" | "attachment" | "type" | "tag" | "time";
  header: string;
  align: "left" | "center" | "right";
}

// 表格配置（独立于 Query 类）
export interface TableConfig {
  colCount: number;
  cols: TableColConfig[];
  // 是否使用顺序式 column 语法：首次出现时清空默认列，
  // 并与 colN / table columns 互斥（混用会让列序无法预测，直接报错）
  usesColumnSyntax?: boolean;
  // 是否使用 colN / table columns 语法
  usesIndexedSyntax?: boolean;
}

// 默认表格配置
export function createDefaultTableConfig(): TableConfig {
  return {
    colCount: 6,
    cols: [
      { field: "date", header: "", align: "left" },
      { field: "amount", header: "", align: "left" },
      { field: "account", header: "", align: "left" },
      { field: "description", header: "", align: "left" },
      { field: "attachment", header: "", align: "left" },
      { field: "link", header: "", align: "left" },
    ],
  };
}

// 表格列数上限（column 顺序式与 colN 下标式共用）
export const MAX_TABLE_COLS = 12;

// 把完整标签折叠到一级：#支出/餐饮/午餐 → #支出/餐饮；#支出 → #支出。
// 用于「按标签分组」的默认行为（group by tag），二级细分仍保留在明细里。
function topLevelTag(fullTag: string): string {
  const parts = fullTag.split("/");
  return parts.length <= 2 ? fullTag : `${parts[0]}/${parts[1]}`;
}

// 图表 / 面板共用调色板。
// 分两个常量是因为：图表默认用 10 色、面板饼图用满 20 色，且两者历史顺序不同
// （此处保持各自原有顺序以免配色变化），但定义集中于此，避免各处复制导致漂移。
export const CHART_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

export const PANEL_PIE_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#84cc16", "#6366f1",
  "#14b8a6", "#e11d48", "#a855f7", "#eab308", "#0ea5e9",
  "#d946ef", "#22c55e", "#fb923c", "#64748b", "#7c3aed",
];

// colN / column 可用的列字段
export const TABLE_COL_FIELDS: TableColConfig["field"][] = [
  "date",
  "amount",
  "account",
  "description",
  "attachment",
  "link",
  "type",
  "tag",
  "time",
];

// 单条表格指令（table columns / colN / column）的解析结果
export interface TableDirective {
  kind: "columns" | "col" | "column";
  colCount?: number;
  colIndex?: number;
  field?: TableColConfig["field"];
  header?: string;
  align?: TableColConfig["align"];
  error?: string;
}

// 解析 table columns / colN 行；返回 null 表示该行不是表格指令。
// 越界或非法字段不静默忽略，而是带回错误信息，交由调用方报给用户。
export function parseTableDirective(line: string): TableDirective | null {
  const colCountMatch = line.match(/^table\s+columns\s+(\d+)/i);
  if (colCountMatch) {
    const count = parseInt(colCountMatch[1], 10);
    if (!Number.isFinite(count) || count < 1 || count > MAX_TABLE_COLS) {
      return {
        kind: "columns",
        error: tp("error.tableColumnsOutOfRange", { line, max: MAX_TABLE_COLS }),
      };
    }
    return { kind: "columns", colCount: count };
  }

  // 表头允许 \" 转义：写入侧 ChartModal.escapeQuotes 正是把 " 转成 \" 后写出的
  const colMatch = line.match(/^col(\d+)\s+(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+(left|center|right))?$/i);
  if (colMatch) {
    const colNumber = parseInt(colMatch[1], 10);
    if (!Number.isFinite(colNumber) || colNumber < 1 || colNumber > MAX_TABLE_COLS) {
      return {
        kind: "col",
        error: tp("error.tableColumnIndexOutOfRange", { line, max: MAX_TABLE_COLS }),
      };
    }
    const field = colMatch[2].toLowerCase();
    if (!TABLE_COL_FIELDS.includes(field as TableColConfig["field"])) {
      return {
        kind: "col",
        error: tp("error.tableColumnFieldUnsupported", {
          field,
          options: TABLE_COL_FIELDS.join(", "),
        }),
      };
    }
    return {
      kind: "col",
      colIndex: colNumber - 1,
      field: field as TableColConfig["field"],
      // 还原写入侧写出的 \" 转义
      header: colMatch[3] !== undefined ? colMatch[3].replace(/\\"/g, '"') : undefined,
      align: colMatch[4] as TableColConfig["align"] | undefined,
    };
  }

  // 顺序式 column 指令：出现顺序即列顺序（推荐写法）
  const columnMatch = line.match(/^column\s+(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+(left|center|right))?$/i);
  if (columnMatch) {
    const field = columnMatch[1].toLowerCase();
    if (!TABLE_COL_FIELDS.includes(field as TableColConfig["field"])) {
      return {
        kind: "column",
        error: tp("error.tableColumnFieldUnsupported", {
          field,
          options: TABLE_COL_FIELDS.join(", "),
        }),
      };
    }
    return {
      kind: "column",
      field: field as TableColConfig["field"],
      header: columnMatch[2] !== undefined ? columnMatch[2].replace(/\\"/g, '"') : undefined,
      align: columnMatch[3] as TableColConfig["align"] | undefined,
    };
  }

  return null;
}

// 把一条表格指令应用到配置上；返回错误信息，null 表示成功
export function applyTableDirective(config: TableConfig, directive: TableDirective): string | null {
  if (directive.error) return directive.error;

  // 顺序式 column：与 colN / table columns 互斥。
  // 混用会让列序无法预测（colN 按下标定位、column 按出现顺序追加），因此直接报错。
  if (directive.kind === "column") {
    if (config.usesIndexedSyntax) return tp("error.tableSyntaxMixed", {});
    if (!config.usesColumnSyntax) {
      // 首次使用顺序式语法：丢弃默认列，列序完全由 column 决定
      config.cols = [];
      config.usesColumnSyntax = true;
    }
    if (config.cols.length >= MAX_TABLE_COLS) {
      return tp("error.tableColumnsOutOfRange", {
        line: `column ${directive.field}`,
        max: MAX_TABLE_COLS,
      });
    }
    config.cols.push({
      field: directive.field!,
      header: directive.header ?? "",
      align: directive.align ?? "left",
    });
    config.colCount = config.cols.length;
    return null;
  }

  // colN / table columns：同样与 column 互斥
  if (config.usesColumnSyntax) return tp("error.tableSyntaxMixed", {});
  config.usesIndexedSyntax = true;

  if (directive.kind === "columns") {
    config.colCount = directive.colCount!;
    return null;
  }

  const index = directive.colIndex!;
  while (config.cols.length <= index) {
    config.cols.push({ field: "date", header: "", align: "left" });
  }
  config.cols[index] = {
    field: directive.field!,
    // 未写表头时保留原值；显式写了空表头 "" 则清空
    header: directive.header !== undefined ? directive.header : config.cols[index].header,
    align: directive.align ?? config.cols[index].align,
  };
  return null;
}

// 图表类型
export type ChartDisplayType = "table" | "bar" | "line" | "pie";

// 分组字段类型
export type GroupByField = "tag" | "date" | "week" | "month" | "year" | "account" | "type";

// 子分组依据（条形图/折线图通用）
export type SplitBy = "none" | "valueType" | "tag" | "account" | "type" | "date" | "week" | "month" | "year";

// 扇形图数值类型
export type PieValueType = "income" | "expense" | "balance" | "inflow" | "outflow" | "netflow";

// 将各种大小写形式的 splitBy 归一化为标准值
function normalizeSplitBy(raw: string): SplitBy {
  const lower = raw.toLowerCase().replace(/\s/g, "");
  const map: Record<string, SplitBy> = {
    none: "none",
    valuetype: "valueType",
    tag: "tag",
    account: "account",
    type: "type",
    date: "date",
    week: "week",
    month: "month",
    year: "year",
  };
  return map[lower] || "valueType";
}

// 图表配置接口
export interface ChartConfig {
  type: ChartDisplayType;
  title: string;
  groupBy: GroupByField;
  valueType: PieValueType;
  // 子分组（条形图/折线图通用）
  splitBy?: SplitBy;
  splitItems?: string[];
  width: number;
  height: number;
  showLegend: boolean;
  showLabels: boolean;
  colors: string[];
}

// 默认图表配置
export function createDefaultChartConfig(): ChartConfig {
  return {
    type: "table",
    title: "",
    groupBy: "month",
    valueType: "expense",
    splitBy: undefined,
    splitItems: undefined,
    width: 600,
    height: 400,
    showLegend: true,
    showLabels: false,
    colors: [...CHART_COLORS],
  };
}

// 周分组键（YYYY-WW + 本地化的“周”后缀）。
// ChartRenderer 的 split by week 也用同一格式做匹配，必须共用这一个函数。
export function formatWeekKey(date: { format(pattern: string): string }): string {
  return `${date.format("GGGG-WW")}${t("group.weekSuffix")}`;
}

// 把设置中的全局查询追加到用户查询之后。
// globalQuery 是设置页里可配置的「每次查询都追加的指令」，
// 此前只有 UI 与存储，没有任何地方真正应用它。
export function withGlobalQuery(source: string, globalQuery?: string): string {
  const extra = (globalQuery ?? "").trim();
  return extra ? `${source}\n${extra}` : source;
}

// 从源码解析表格配置（与 Query 共用同一套指令解析，避免两处实现漂移）
export function parseTableConfig(source: string): TableConfig {
  const config = createDefaultTableConfig();
  for (const line of source.split("\n")) {
    const directive = parseTableDirective(line.trim());
    if (!directive) continue;
    // 指令错误由 Query 侧统一呈现给用户，这里只取有效配置
    applyTableDirective(config, directive);
  }
  return config;
}

// 从源码解析图表配置
export function parseChartConfig(source: string): ChartConfig {
  const config = createDefaultChartConfig();
  const lines = source.split("\n");

  for (const line of lines) {
    // chart type
    const typeMatch = line.match(/^chart\s+type\s+(table|bar|line|pie)/i);
    if (typeMatch) {
      config.type = typeMatch[1].toLowerCase() as ChartDisplayType;
      continue;
    }

    // chart title（与 parseLine 保持同一套规则：支持 \" 转义）
    const titleMatch = line.match(/^chart\s+title\s+"((?:[^"\\]|\\.)*)"/i);
    if (titleMatch) {
      config.title = titleMatch[1].replace(/\\"/g, '"');
      continue;
    }

    // chart (bar|line) split by（子分组依据，条形图/折线图通用）
    const splitMatch = line.match(/^chart\s+(bar|line)\s+split\s+by\s+(none|valuetype|tag|account|type|date|week|month|year)/i);
    if (splitMatch) {
      config.splitBy = normalizeSplitBy(splitMatch[2]);
      continue;
    }

    // chart (bar|line) items（子分组具体项，条形图/折线图通用）
    const splitItemsMatch = line.match(/^chart\s+(bar|line)\s+items\s+(.+)/i);
    if (splitItemsMatch) {
      config.splitItems = splitItemsMatch[2].split(/\s+/).filter(Boolean);
      continue;
    }

    // chart value（扇形图用）
    const valueMatch = line.match(/^chart\s+value\s+(income|expense|balance|inflow|outflow|netflow)/i);
    if (valueMatch) {
      config.valueType = valueMatch[1].toLowerCase() as PieValueType;
      continue;
    }

    // chart width
    const widthMatch = line.match(/^chart\s+width\s+(\d+)/i);
    if (widthMatch) {
      config.width = Math.max(200, Math.min(1200, parseInt(widthMatch[1])));
      continue;
    }

    // chart height
    const heightMatch = line.match(/^chart\s+height\s+(\d+)/i);
    if (heightMatch) {
      config.height = Math.max(150, Math.min(800, parseInt(heightMatch[1])));
      continue;
    }

    // chart legend
    const legendMatch = line.match(/^chart\s+legend\s+(true|false)/i);
    if (legendMatch) {
      config.showLegend = legendMatch[1].toLowerCase() === "true";
      continue;
    }

    // chart labels
    const labelsMatch = line.match(/^chart\s+labels\s+(true|false)/i);
    if (labelsMatch) {
      config.showLabels = labelsMatch[1].toLowerCase() === "true";
      continue;
    }

    // chart colors
    const colorsMatch = line.match(/^chart\s+colors\s+(.+)/i);
    if (colorsMatch) {
      const colors = colorsMatch[1].split(",").map((c: string) => c.trim());
      if (colors.length > 0) {
        config.colors = colors;
      }
      continue;
    }
  }

  return config;
}

// 生成所有分组键组合（笛卡尔积，用于多账户转账条目分发到各账户分组）
function combineKeyOptions(options: string[][]): string[] {
  if (options.length === 0) return [t("group.all")];
  let results: string[] = options[0];
  for (let i = 1; i < options.length; i++) {
    const next: string[] = [];
    for (const r of results) {
      for (const o of options[i]) {
        next.push(r + " / " + o);
      }
    }
    results = next;
  }
  return results;
}

export class Query {
  private filters: FilterFunction[] = [];
  private sorters: Sorter[] = [];
  private groupers: Grouper[] = [];
  private limit: number = Infinity;
  private showTotal: boolean = false;
  private showTotalIncome: boolean = false;
  private showTotalExpense: boolean = false;
  private showBalance: boolean = false;
  private showCount: boolean = false;
  private hideDate: boolean = false;
  private hideTime: boolean = false;
  private hideTag: boolean = false;
  private hideAmount: boolean = false;
  private hideAccount: boolean = false;
  private showAccount: boolean = false;
  private showTagInDescription: boolean = false;
  private showChartSummary: boolean = false;
  private showGroupSubtotal: boolean = false;
  // 指令错误累积：写错多处时应把每一条都报出来，而不是只留最后一条
  private errors: string[] = [];
  private settings: CashlogSettings;

  // 表格选项
  private chartTableConfig: TableConfig = createDefaultTableConfig();

  // 图表选项
  private _displayChartType: ChartDisplayType = "table";
  private _chartTitle: string = "";
  private _chartWidth: number = 600;
  private _chartHeight: number = 400;
  private _chartShowLegend: boolean = true;
  private _chartShowLabels: boolean = false;
  private _chartColors: string[] = [...CHART_COLORS];
  // 子分组（条形图/折线图通用）
  private _chartSplitBy: SplitBy | null = null;
  private _chartSplitItems: string[] = [];
  // 数值类型（扇形图用）
  private _chartValueType: PieValueType = "expense";
  // 列表样式
  private _listStyle: "unordered" | "ordered" | "none" = "unordered";

  constructor(source: string, settings: CashlogSettings) {
    this.settings = settings;
    const lines = source.split("\n");
    for (const line of lines) {
      this.parseLine(line.trim());
    }
  }

  getError(): string | null {
    return this.errors.length > 0 ? this.errors.join("\n") : null;
  }

  // 解析查询指令
  private parseLine(line: string): void {
    if (line === "" || line.startsWith("#")) return;
    const trimLine = line.trim().toLowerCase();

    // 表格指令：table columns / colN
    const tableDirective = parseTableDirective(line);
    if (tableDirective) {
      const directiveError = applyTableDirective(this.chartTableConfig, tableDirective);
      if (directiveError) {
        this.errors.push(directiveError);
      }
      return;
    }

    // limit
    const limitMatch = line.match(/^limit\s+to\s+(\d+)/i);
    if (limitMatch) {
      this.limit = parseInt(limitMatch[1]);
      return;
    }

    // sort by
    const sortMatch = line.match(
      /^sort\s+by\s+(date|amount|description|account)\s+(ascending|descending)/i,
    );
    if (sortMatch) {
      this.sorters.push({
        field: sortMatch[1].toLowerCase(),
        direction: sortMatch[2].toLowerCase() as "ascending" | "descending",
      });
      return;
    }

    // group by <字段> [<路径>] [level N]
    //   group by tag                  全局按一级子标签
    //   group by tag level 2          全局按二级
    //   group by tag 餐饮              定位到「餐饮」，按下一级
    //   group by tag 餐饮 level 2      定位到「餐饮」，再往下 2 级
    //   group by tag 地点/学校         定位到副标签「地点/学校」
    const groupMatch = line.match(
      /^group\s+by\s+(tag|date|week|month|year|account|type)\b(.*)$/i,
    );
    if (groupMatch) {
      const field = groupMatch[1].toLowerCase();
      const rest = groupMatch[2].trim();

      let level: number | undefined;
      let tagPath: string[] | undefined;

      if (rest !== "") {
        const levelOnly = rest.match(/^level\s+(\d+)$/i);
        const pathLevel = rest.match(/^(\S+)\s+level\s+(\d+)$/i);
        const levelPath = rest.match(/^level\s+(\d+)\s+(\S+)$/i);
        const pathOnly = rest.match(/^(\S+)$/);

        if (levelOnly) {
          level = Number(levelOnly[1]);
        } else if (pathLevel) {
          tagPath = pathLevel[1].split("/").filter(Boolean);
          level = Number(pathLevel[2]);
        } else if (levelPath) {
          level = Number(levelPath[1]);
          tagPath = levelPath[2].split("/").filter(Boolean);
        } else if (pathOnly) {
          tagPath = pathOnly[1].split("/").filter(Boolean);
        }
      }

      this.groupers.push({ field, level, tagPath });
      return;
    }

    // show
    // list style
    const listStyleMatch = line.match(/^list\s+style\s+(unordered|ordered|none)/i);
    if (listStyleMatch) {
      this._listStyle = listStyleMatch[1].toLowerCase() as "unordered" | "ordered" | "none";
      return;
    }

    if (trimLine === "show tag in description") {
      this.showTagInDescription = true;
      return;
    }
    if (trimLine === "show summary") {
      this.showChartSummary = true;
      return;
    }
    if (trimLine === "show group subtotal") {
      this.showGroupSubtotal = true;
      return;
    }
    const showMatch = line.match(/^show\s+(total income|total expense|total|balance|count)\s*$/i);
    if (showMatch) {
      const what = showMatch[1].toLowerCase();
      switch (what) {
        case "total":
          this.showTotal = true;
          break;
        case "total income":
          this.showTotalIncome = true;
          break;
        case "total expense":
          this.showTotalExpense = true;
          break;
        case "balance":
          this.showBalance = true;
          break;
        case "count":
          this.showCount = true;
          break;
      }
      return;
    }

    // hide
    const hideMatch = line.match(/^hide\s+(date|time|tag|amount|account)/i);
    if (hideMatch) {
      const what = hideMatch[1].toLowerCase();
      switch (what) {
        case "date":
          this.hideDate = true;
          break;
        case "time":
          this.hideTime = true;
          break;
        case "tag":
          this.hideTag = true;
          break;
        case "amount":
          this.hideAmount = true;
          break;
        case "account":
          this.hideAccount = true;
          break;
      }
      return;
    }

    // show account
    if (trimLine === "show account") {
      this.showAccount = true;
      return;
    }

    // chart type
    const chartTypeMatch = line.match(/^chart\s+type\s+(table|bar|line|pie)/i);
    if (chartTypeMatch) {
      this._displayChartType = chartTypeMatch[1].toLowerCase() as ChartDisplayType;
      return;
    }

    // chart title（标题允许 \" 转义：写入侧 ChartModal.escapeQuotes 正是这样转义的）
    const chartTitleMatch = line.match(/^chart\s+title\s+"((?:[^"\\]|\\.)*)"/i);
    if (chartTitleMatch) {
      this._chartTitle = chartTitleMatch[1].replace(/\\"/g, '"');
      return;
    }

    // chart (bar|line) split by（子分组依据，条形图/折线图通用）
    const splitMatch = line.match(/^chart\s+(bar|line)\s+split\s+by\s+(none|valuetype|tag|account|type|date|week|month|year)/i);
    if (splitMatch) {
      this._chartSplitBy = normalizeSplitBy(splitMatch[2]);
      return;
    }

    // chart (bar|line) items（子分组具体项，条形图/折线图通用）
    const splitItemsMatch = line.match(/^chart\s+(bar|line)\s+items\s+(.+)/i);
    if (splitItemsMatch) {
      this._chartSplitItems = splitItemsMatch[2].split(/\s+/).filter(Boolean);
      return;
    }

    // chart value（扇形图用）
    const chartValueMatch = line.match(/^chart\s+value\s+(income|expense|balance|inflow|outflow|netflow)/i);
    if (chartValueMatch) {
      this._chartValueType = chartValueMatch[1].toLowerCase() as PieValueType;
      return;
    }

    // chart width
    const chartWidthMatch = line.match(/^chart\s+width\s+(\d+)/i);
    if (chartWidthMatch) {
      this._chartWidth = Math.max(200, Math.min(1200, parseInt(chartWidthMatch[1])));
      return;
    }

    // chart height
    const chartHeightMatch = line.match(/^chart\s+height\s+(\d+)/i);
    if (chartHeightMatch) {
      this._chartHeight = Math.max(150, Math.min(800, parseInt(chartHeightMatch[1])));
      return;
    }

    // chart legend
    const chartLegendMatch = line.match(/^chart\s+legend\s+(true|false)/i);
    if (chartLegendMatch) {
      this._chartShowLegend = chartLegendMatch[1].toLowerCase() === "true";
      return;
    }

    // chart labels
    const chartLabelsMatch = line.match(/^chart\s+labels\s+(true|false)/i);
    if (chartLabelsMatch) {
      this._chartShowLabels = chartLabelsMatch[1].toLowerCase() === "true";
      return;
    }

    // chart colors
    const chartColorsMatch = line.match(/^chart\s+colors\s+(.+)/i);
    if (chartColorsMatch) {
      const colors = chartColorsMatch[1].split(",").map((c: string) => c.trim());
      if (colors.length > 0) {
        this._chartColors = colors;
      }
      return;
    }

    // 过滤指令
    const result = parseFilter(line, this.settings);
    if (result) {
      if (result.filter) {
        this.filters.push(result.filter);
      } else if (result.error) {
        this.errors.push(result.error);
      }
      return;
    }

    // 未知指令
    this.errors.push(tp("error.unknownDirective", { line }));
  }

  // 执行查询
  apply(entries: CashlogEntry[]): QueryResult {
    // 1. 过滤
    let filtered = entries.filter((e) => this.filters.every((f) => f(e)));

    // 2. 排序
    filtered = this.sort(filtered);

    // 3. 限制
    filtered = filtered.slice(0, this.limit);

    // 4. 分组
    const groups = this.group(filtered);

    // 5. 汇总
    const summary = this.summarize(filtered);

    return { groups, summary };
  }

  // 排序
  private sort(entries: CashlogEntry[]): CashlogEntry[] {
    if (this.sorters.length === 0) return entries;

    return [...entries].sort((a, b) => {
      for (const sorter of this.sorters) {
        let cmp = 0;
        switch (sorter.field) {
          case "date": {
            const aDate = a.date ? a.date.valueOf() : 0;
            const bDate = b.date ? b.date.valueOf() : 0;
            cmp = aDate - bDate;
            break;
          }
          case "amount":
            cmp = Math.abs(a.amount) - Math.abs(b.amount);
            break;
          case "description":
            cmp = a.description.localeCompare(b.description);
            break;
          case "account": {
            const aAcct = (a.accountAmounts[0]?.account || "").toLowerCase();
            const bAcct = (b.accountAmounts[0]?.account || "").toLowerCase();
            cmp = aAcct.localeCompare(bAcct);
            break;
          }
        }
        if (sorter.direction === "descending") cmp = -cmp;
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  // 分组
  private group(entries: CashlogEntry[]): EntryGroup[] {
    if (this.groupers.length === 0) {
      return [{ key: t("group.all"), entries }];
    }

    const isTagGroup = this.groupers.some((g) => g.field === "tag");
    const groupMap = new Map<string, CashlogEntry[]>();

    for (const entry of entries) {
      // 每个 grouper 可能产生多个分组键（如账户分组时转账涉及多个账户）
      const keyOptions: string[][] = [];

      for (const grouper of this.groupers) {
        switch (grouper.field) {
          case "tag": {
            // 带路径：定位到某一支（可以是副标签），分组键 = 路径 + 再下一级
            if (grouper.tagPath && grouper.tagPath.length > 0) {
              const wanted = grouper.tagPath.join("/").toLowerCase();
              const matched = entry.tags.find((tag) => {
                const lower = tag.replace(/^#/, "").toLowerCase();
                // 同 tagMatches：允许开头、中间层级、结尾三种位置
                return (
                  lower === wanted ||
                  lower.startsWith(wanted + "/") ||
                  lower.includes("/" + wanted + "/") ||
                  lower.endsWith("/" + wanted)
                );
              });

              if (!matched) {
                // 指定了路径就只看这一支：不属于它的记录直接跳过，
                // 否则会多出一个「无标签」分组，把无关条目混进统计。
                break;
              }

              const segs = matched.replace(/^#/, "").split("/");
              // 主标签占 1 段 + 路径占 N 段 + 再往下 level 段（默认 1 段）
              const depth = grouper.level
                ? grouper.tagPath.length + 1 + grouper.level
                : grouper.tagPath.length + 2;
              keyOptions.push([segs.slice(0, depth).join("/")]);
              break;
            }

            // 不带路径：按主标签（全局）
            const fullTag = entry.primaryTag;
            if (!fullTag) {
              keyOptions.push([t("group.noTag")]);
              break;
            }

            const level = grouper.level ?? 1;
            const mainTag = "#" + fullTag.replace(/^#/, "").split("/")[0];
            keyOptions.push([tagToGroupKey(fullTag, mainTag, level)]);
            break;
          }
          case "date":
            keyOptions.push([entry.date ? entry.date.format("YYYY-MM-DD") : t("group.noDate")]);
            break;
          case "week":
            keyOptions.push([entry.date ? formatWeekKey(entry.date) : t("group.noDate")]);
            break;
          case "month":
            keyOptions.push([entry.date ? entry.date.format("YYYY-MM") : t("group.noDate")]);
            break;
          case "year":
            keyOptions.push([entry.date ? entry.date.format("YYYY") : t("group.noDate")]);
            break;
          case "account": {
            const accts = entry.accountAmounts.map((aa) => aa.account).filter(Boolean);
            keyOptions.push(accts.length > 0 ? accts : [t("group.noAccount")]);
            break;
          }
          case "type": {
            const typeLabels: Record<string, string> = {
              normal: t("group.typeOther"),
              transfer: t("group.typeTransfer"),
              balanceChange: t("group.typeBalanceChange"),
            };
            let typeKey: string;
            if (entry.entryType !== "normal") {
              typeKey = typeLabels[entry.entryType] || entry.entryType;
            } else if (entry.isIncome) {
              typeKey = t("group.typeIncome");
            } else if (entry.isExpense) {
              typeKey = t("group.typeExpense");
            } else {
              typeKey = t("group.typeOther");
            }
            keyOptions.push([typeKey]);
            break;
          }
        }
      }

      // 生成所有分组键组合（对多账户转账会生成多个分组）
      const combinedKeys = combineKeyOptions(keyOptions);
      for (const key of combinedKeys) {
        if (!groupMap.has(key)) {
          groupMap.set(key, []);
        }
        groupMap.get(key)!.push(entry);
      }
    }

    const groups = Array.from(groupMap.entries()).map(([key, entries]) => ({ key, entries }));

    // 按标签分组时：收入标签在前，支出标签在后
    if (isTagGroup) {
      const incomeBase = this.settings.incomeTag.toLowerCase();
      groups.sort((a, b) => {
        const aIncome = a.key.toLowerCase().startsWith(incomeBase) ? 0 : 1;
        const bIncome = b.key.toLowerCase().startsWith(incomeBase) ? 0 : 1;
        return aIncome - bIncome;
      });
    }

    return groups;
  }

  // 汇总
  private summarize(entries: CashlogEntry[]): Summary {
    const totalIncome = round2(entries
      .filter((e) => e.amount > 0)
      .reduce((sum, e) => sum + e.amount, 0));
    const totalExpense = round2(entries
      .filter((e) => e.amount < 0)
      .reduce((sum, e) => sum + e.amount, 0));

    return {
      totalIncome: this.showTotal || this.showTotalIncome ? totalIncome : 0,
      totalExpense: this.showTotal || this.showTotalExpense ? totalExpense : 0,
      balance: this.showTotal || this.showBalance ? round2(totalIncome + totalExpense) : 0,
      count: this.showTotal || this.showCount ? entries.length : 0,
    };
  }

  // 显示选项的 getter
  get shouldHideDate(): boolean { return this.hideDate; }
  get shouldHideTime(): boolean { return this.hideTime; }
  get shouldHideTag(): boolean { return this.hideTag; }
  get shouldHideAmount(): boolean { return this.hideAmount; }
  get shouldHideAccount(): boolean { return this.hideAccount; }
  get shouldShowAccount(): boolean { return this.showAccount; }
  get shouldShowTotal(): boolean { return this.showTotal; }
  get shouldShowTotalIncome(): boolean { return this.showTotalIncome; }
  get shouldShowTotalExpense(): boolean { return this.showTotalExpense; }
  get shouldShowBalance(): boolean { return this.showBalance; }
  get shouldShowCount(): boolean { return this.showCount; }
  get shouldShowTagInDescription(): boolean { return this.showTagInDescription; }
  get shouldShowChartSummary(): boolean { return this.showChartSummary; }
  get shouldShowGroupSubtotal(): boolean { return this.showGroupSubtotal; }
  get listStyle(): "unordered" | "ordered" | "none" { return this._listStyle; }

  // 表格选项 getter
  get tableColCount(): number { return this.chartTableConfig.colCount; }
  get tableCols(): TableColConfig[] { return this.chartTableConfig.cols; }

  // 图表选项 getter
  get displayChartType(): ChartDisplayType { return this._displayChartType; }
  get chartTitle(): string { return this._chartTitle; }
  get chartWidth(): number { return this._chartWidth; }
  get chartHeight(): number { return this._chartHeight; }
  get chartShowLegend(): boolean { return this._chartShowLegend; }
  get chartShowLabels(): boolean { return this._chartShowLabels; }
  get chartColors(): string[] { return this._chartColors; }
  // 当前数据分组的字段（由 group by 指令决定）
  get groupField(): string | null {
    return this.groupers.length > 0 ? this.groupers[0].field : null;
  }
  // 子分组 getter
  get chartSplitBy(): SplitBy | null { return this._chartSplitBy; }
  get chartSplitItems(): string[] { return this._chartSplitItems; }

  // 获取完整图表配置
  getChartConfig(): ChartConfig {
    return {
      type: this._displayChartType,
      title: this._chartTitle,
      groupBy: this.groupers.length > 0 ? (this.groupers[0].field as GroupByField) : "month",
      valueType: this._chartValueType,
      splitBy: this._chartSplitBy ?? undefined,
      splitItems: this._chartSplitItems.length > 0 ? this._chartSplitItems : undefined,
      width: this._chartWidth,
      height: this._chartHeight,
      showLegend: this._chartShowLegend,
      showLabels: this._chartShowLabels,
      colors: this._chartColors,
    };
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
