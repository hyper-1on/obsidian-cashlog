// cashlog 缺陷回归测试。
// 每条用例描述“修复后应满足的行为”，因此在本轮修复之前，
// 与已复现缺陷对应的用例会失败 —— 失败即复现。
import { test } from "node:test";
import assert from "node:assert/strict";

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { Query, parseTableConfig, parseTableDirective, parseChartConfig, CHART_COLORS, PANEL_PIE_COLORS, MAX_TABLE_COLS, TABLE_COL_FIELDS, withGlobalQuery } from "../src/Query/Query";
import { parseFilter } from "../src/Query/FilterParser";
import {
  parseCashlogLine,
  parseCashlogLineLenient,
} from "../src/CashlogSerializer";
import { buildEntryFromModalData, validateEntryData } from "../src/EntryEditor";
import { validateSubTagName } from "../src/TagValidation";
import { createDefaultData } from "../src/CashlogModal";
import { legacyToTree, pruneEmptyNodes, flattenTree, validateTagPath, stripCommonPrefix, tagToGroupKey, addChild, removeNode } from "../src/TagTree";
import { resolveEntryLine } from "../src/EntryLocator";
import { t, tp, initI18n, getLocale, getCurrencySymbol, setCurrencyOverride } from "../src/i18n";
import { computeIntegerPercentages, renderChartTable } from "../src/ChartRenderer";
import { computePeriodRange, BudgetManager } from "../src/BudgetManager";
import { AttachmentManager } from "../src/AttachmentManager";
import { moment } from "../src/types";
import zhLocale from "../src/i18n/locales/zh-CN.json";
import enLocale from "../src/i18n/locales/en.json";
import { parseFileContent } from "../src/Cache";
import { buildEntryLocationForCursor } from "../src/Commands";
import { EntryLocation } from "../src/EntryLocation";
import { CashlogEntry } from "../src/CashlogEntry";
import { DEFAULT_SETTINGS } from "../src/Settings";
import type { CashlogSettings } from "../src/Settings";
import type { EditableEntryData } from "../src/CashlogModal";
import { renderQueryResult } from "../src/Renderer";
import { FakeElement, collectText } from "./stubs/dom";
import { CashlogSettingsTab } from "../src/SettingsTab";
import { CashlogView } from "../src/CashlogView";
import { renderPanelSettings } from "../src/PanelSettings";
import CashlogPlugin from "../src/main";
import { TagTreeModal } from "../src/TagTreeModal";
import type { TagNode } from "../src/TagTree";

// Obsidian 把 activeDocument 作为全局提供（src 里直接引用，并非模块 import）。
// 这里挂到 globalThis，使面板设置的渲染逻辑可以在 Node 下运行并断言其 DOM 结构。
(globalThis as unknown as { activeDocument?: unknown }).activeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
};

// 面板设置用 window.requestAnimationFrame 恢复滚动位置；Node 里没有 window，
// 这里同步执行回调（两帧语义对断言无影响）。
(globalThis as unknown as { window?: unknown }).window = {
  requestAnimationFrame: (cb: () => void): number => {
    cb();
    return 0;
  },
  setTimeout: (cb: () => void): number => {
    cb();
    return 0;
  },
  clearTimeout: (): void => {},
};

// 每个用例拿到独立的 settings 副本，避免污染 DEFAULT_SETTINGS
function makeSettings(over: Partial<CashlogSettings> = {}): CashlogSettings {
  return { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...over } as CashlogSettings;
}

function parse(line: string, settings = makeSettings(), path = "账本.md"): CashlogEntry | null {
  return parseCashlogLine(line, new EntryLocation(path, 0), settings);
}

// 构造一个只暴露 EntryEditor 所需接口的假插件
function fakePlugin(settings: CashlogSettings, entries: CashlogEntry[]) {
  return { settings, cache: { getEntries: () => entries } } as never;
}

// ---------------------------------------------------------------- 查询指令

test("[卡2] show total income 只应启用总收入汇总", () => {
  const q = new Query("show total income", makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.shouldShowTotalIncome, true);
  assert.equal(q.shouldShowTotal, false, "show total income 不应被当成 show total");
});

test("[卡2] show total expense 只应启用总支出汇总", () => {
  const q = new Query("show total expense", makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.shouldShowTotalExpense, true);
  assert.equal(q.shouldShowTotal, false, "show total expense 不应被当成 show total");
});

test("[对照] show total 仍应启用全部四项汇总", () => {
  const q = new Query("show total", makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.shouldShowTotal, true);
});

// ---------------------------------------------------------------- 图表指令

test("chart type table 应可显式指定（当前只能靠缺省）", () => {
  const q = new Query("chart type table", makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.displayChartType, "table");
});

test("chart type bar 仍应正常工作", () => {
  const q = new Query("chart type bar", makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.displayChartType, "bar");
});

// ---------------------------------------------------------------- 表格列配置

test("[卡1] colN 应支持 type 字段", () => {
  const q = new Query('col6 type "类型"', makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.tableCols[5].field, "type");
  assert.equal(q.tableCols[5].header, "类型");
});

test("[卡1] 超出列号上限的 colN 应给出明确错误，而不是静默丢弃", () => {
  // 跟随 MAX_TABLE_COLS 变化，避免调整上限时测试失效
  const over = MAX_TABLE_COLS + 1;
  const q = new Query(`col${over} link "链接"`, makeSettings());
  const err = q.getError();
  assert.ok(err, `col${over} 不应被静默忽略`);
  assert.ok(err.includes(`col${over}`), `错误信息应指出 col${over}：${err}`);
  assert.ok(err.includes(String(MAX_TABLE_COLS)), `错误信息应说明当前上限为 ${MAX_TABLE_COLS}：${err}`);
});

test("[卡1] table columns 超出上限应给出明确错误，而不是静默截断", () => {
  const over = MAX_TABLE_COLS + 1;
  const q = new Query(`table columns ${over}`, makeSettings());
  const err = q.getError();
  assert.ok(err, `table columns ${over} 不应被静默截断`);
  assert.ok(err.includes(String(over)), `错误信息应指出请求的列数 ${over}：${err}`);
});

test("[卡1] 合法列配置仍应被接受", () => {
  const src = [
    "table columns 3",
    'col1 date "时间" center',
    'col2 amount "金额" right',
    'col3 description "描述" left',
  ].join("\n");
  const q = new Query(src, makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.tableColCount, 3);
  assert.equal(q.tableCols[0].align, "center");
  assert.equal(q.tableCols[1].align, "right");
  assert.equal(q.tableCols[2].field, "description");
});

test("[一致性] parseTableConfig 与 Query 对同一源码应得到相同列配置", () => {
  const src = ['table columns 6', 'col1 date "时间" left', 'col6 type "类型" left'].join("\n");
  const viaHelper = parseTableConfig(src);
  const q = new Query(src, makeSettings());
  assert.deepEqual(
    q.tableCols.map((c) => c.field),
    viaHelper.cols.map((c) => c.field),
  );
  assert.equal(viaHelper.colCount, q.tableColCount);
});

// ---------------------------------------------------------------- 过滤器

test("[卡5] account is not 应排除指定账户", () => {
  const settings = makeSettings({ enableAccounts: true });
  const wechat = parse("- #支出/购物 测试 💳微信💴-10 ➕2026-09-22", settings)!;
  const alipay = parse("- #支出/购物 测试 💳支付宝💴-10 ➕2026-09-22", settings)!;
  assert.ok(wechat && alipay, "前置条件：两条带账户条目应能解析");

  const res = parseFilter("account is not 微信", settings);
  assert.ok(res?.filter, "account is not 应解析出过滤器");
  assert.equal(res.filter(alipay), true, "支付宝条目应被保留");
  assert.equal(res.filter(wechat), false, "微信条目应被排除");
});

test("[对照] account is 仍应命中指定账户", () => {
  const settings = makeSettings({ enableAccounts: true });
  const wechat = parse("- #支出/购物 测试 💳微信💴-10 ➕2026-09-22", settings)!;
  const res = parseFilter("account is 微信", settings);
  assert.ok(res?.filter);
  assert.equal(res.filter(wechat), true);
});

test("[卡8] path includes 与包含路径设置不应误报冲突", () => {
  const settings = makeSettings({ includePaths: ["cashlog-test"] });
  const res = parseFilter("path includes cashlog-test/", settings);
  assert.equal(res?.error, undefined, `不应报冲突：${res?.error}`);
  assert.ok(res?.filter, "应解析出过滤器");
});

// ---------------------------------------------------------------- 余额变更

test("[卡6] 编辑余额变更条目时不应把自身旧 delta 重复计入", () => {
  const settings = makeSettings({
    enableAccounts: true,
    accounts: ["测试A"],
    accountBalances: { 测试A: 0 },
  });
  const existing = parse(
    "- #余额变更 初始化 💳测试A💴100 ➕2026-09-22",
    settings,
  )!;
  assert.ok(existing?.isBalanceChange, "前置条件：应识别为余额变更条目");

  const data: EditableEntryData = {
    tagType: "balanceChange",
    subTag: "",
    description: "初始化",
    date: "2026-09-22",
    time: "",
    accounts: [],
    fromAccounts: [],
    toAccounts: [],
    balanceChangeAccounts: [{ account: "测试A", amount: "200" }],
    attachments: [],
  };

  const built = buildEntryFromModalData(
    data,
    fakePlugin(settings, [existing]),
    { indentation: "", listMarker: "-", location: existing.location },
  );

  // 目标余额 200、外部余额 0 → delta 应为 +200；旧实现会得到 +100
  assert.equal(built.accountAmounts.length, 1);
  assert.equal(built.accountAmounts[0].amount, 200, "delta 应为 200（旧 delta 不应再次计入）");
});

test("[卡6] 新建余额变更条目仍应正确计算 delta", () => {
  const settings = makeSettings({
    enableAccounts: true,
    accounts: ["测试A"],
    accountBalances: { 测试A: 0 },
  });
  const built = buildEntryFromModalData(
    {
      tagType: "balanceChange",
      subTag: "",
      description: "初始化",
      date: "2026-09-22",
      time: "",
      accounts: [],
      fromAccounts: [],
      toAccounts: [],
      balanceChangeAccounts: [{ account: "测试A", amount: "100" }],
      attachments: [],
    },
    fakePlugin(settings, []),
    { indentation: "", listMarker: "-", location: null },
  );
  assert.equal(built.accountAmounts[0].amount, 100);
});

// ---------------------------------------------------------------- 解析设计

test("[卡3-设计] 严格模式下无金额条目不被识别（写回时需拦截，避免“记了但查不到”）", () => {
  assert.equal(parse("- #支出 测试无金额 ➕2026-09-22"), null);
  assert.equal(parseCashlogLineLenient("- #支出 测试无金额 ➕2026-09-22", null, makeSettings()) !== null, true);
});

test("[基线] 正常条目解析不受影响", () => {
  const e = parse("- #支出/交通 坐高铁 💴-100 ➕2026-04-25 ⏰17:30")!;
  assert.equal(e.amount, -100);
  assert.deepEqual(e.tags, ["#支出/交通"]);
  assert.equal(e.description, "坐高铁");
  assert.equal(e.time, "17:30");
});

// ---------------------------------------------------------------- 行号重定位

test("[卡9] 写入前应在最新文件内容中重新定位条目行", () => {
  const lines = ["# 标题", "- a 💴-1", "- b 💴-2"];
  // 行号仍然准确
  assert.equal(resolveEntryLine(lines, "- b 💴-2", 2), 2);

  // 前面插入了内容 → 行号失效，应全局唯一匹配
  const shifted = ["# 新标题", "# 标题", "- a 💴-1", "- b 💴-2"];
  assert.equal(resolveEntryLine(shifted, "- b 💴-2", 2), 3);

  // 行内容已变且无法唯一确定 → 返回 null（应提示刷新，而不是改错行）
  assert.equal(resolveEntryLine(shifted, "- c 💴-3", 2), null);

  // 文件中存在多行相同内容时不猜测
  assert.equal(resolveEntryLine(["- a 💴-1", "- a 💴-1"], "- a 💴-1", 9), null);
});

// ---------------------------------------------------------------- 提交校验

test("[卡3] 无金额的普通条目应被提交校验拦下", () => {
  const base: EditableEntryData = {
    tagType: "expense",
    subTag: "",
    description: "测试",
    date: "2026-09-22",
    time: "",
    accounts: [{ account: "", amount: "" }],
    fromAccounts: [],
    toAccounts: [],
    balanceChangeAccounts: [],
    attachments: [],
  };

  assert.ok(validateEntryData(base), "金额为空时应拒绝提交");
  assert.equal(
    validateEntryData({ ...base, accounts: [{ account: "", amount: "10" }] }),
    null,
  );
  assert.ok(
    validateEntryData({ ...base, accounts: [{ account: "微信", amount: "0" }] }),
    "零金额同样应被拒绝",
  );
});

test("[卡6配套] 余额变更允许目标余额为 0（表示清空账户）", () => {
  const data: EditableEntryData = {
    tagType: "balanceChange",
    subTag: "",
    description: "清空",
    date: "2026-09-22",
    time: "",
    accounts: [],
    fromAccounts: [],
    toAccounts: [],
    balanceChangeAccounts: [{ account: "测试A", amount: "0" }],
    attachments: [],
  };
  assert.equal(validateEntryData(data), null);
});

test("转账需转出与转入金额都大于 0", () => {
  const base: EditableEntryData = {
    tagType: "transfer",
    subTag: "",
    description: "转账",
    date: "2026-09-22",
    time: "",
    accounts: [],
    fromAccounts: [{ account: "A", amount: "10" }],
    toAccounts: [{ account: "B", amount: "" }],
    balanceChangeAccounts: [],
    attachments: [],
  };
  assert.ok(validateEntryData(base), "转入金额为空时应拒绝");
  assert.equal(
    validateEntryData({ ...base, toAccounts: [{ account: "B", amount: "10" }] }),
    null,
  );
});

// ---------------------------------------------------------------- i18n

test("新增的 type 列与类型标签在语言包中都存在", () => {
  for (const key of ["chart.field.type", "cashlogModal.type.income", "validation.amountRequired"]) {
    assert.notEqual(t(key), key, `缺少语言包条目: ${key}`);
  }
});

// ---------------------------------------------------------------- 第二批修复

test("globalQuery 应被追加到用户查询之后并真正生效", () => {
  assert.equal(withGlobalQuery("is expense", ""), "is expense");
  assert.equal(withGlobalQuery("is expense", "   "), "is expense");
  assert.equal(withGlobalQuery("is expense", "limit to 5"), "is expense\nlimit to 5");

  assert.equal(new Query(withGlobalQuery("is expense", "limit to 5"), makeSettings()).getError(), null);
  assert.ok(
    new Query(withGlobalQuery("is expense", "no such directive"), makeSettings()).getError(),
    "全局查询里的错误指令应被暴露出来",
  );
});

test("月度统计起始日在上月的短月份中不应溢出到下个月", () => {
  // 2026-03-05 + 起始日 31：上一个月是 2 月，没有 31 日。
  // 旧实现会因 moment 的 date(31) 溢出到 3 月 3 日。
  const range = computePeriodRange("month", 1, 31, undefined, undefined, moment("2026-03-05"))!;
  assert.ok(range.isValid());
  assert.equal(
    range.start.format("YYYY-MM-DD"),
    "2026-02-28",
    "应夹取到上月最后一天，而不是溢出到下个月",
  );
});

test("月度统计起始日常规情形不受影响", () => {
  const range = computePeriodRange("month", 1, 1, undefined, undefined, moment("2026-03-15"))!;
  assert.equal(range.start.format("YYYY-MM-DD"), "2026-03-01");

  const later = computePeriodRange("month", 1, 10, undefined, undefined, moment("2026-03-15"))!;
  assert.equal(later.start.format("YYYY-MM-DD"), "2026-03-10");

  const previous = computePeriodRange("month", 1, 20, undefined, undefined, moment("2026-03-15"))!;
  assert.equal(previous.start.format("YYYY-MM-DD"), "2026-02-20");
});

test("附件文件名冲突时应追加序号，避免同一时刻上传互相覆盖", () => {
  const existing = new Set<string>();
  const vault = {
    getAbstractFileByPath: (p: string) => (existing.has(p) ? {} : null),
  } as never;
  const manager = new AttachmentManager({} as never, vault, makeSettings());

  // 固定时刻：三次调用必须落在同一"毫秒"，否则 base 不同、不会进入冲突分支，
  // 测试会随真实时钟跨毫秒而偶发失败（flaky）。
  const fixedNow = moment("2026-09-22T10:00:00.123");

  const first = manager.generateFileName("png", fixedNow);
  existing.add(`cashlog-attachments/${first}`);
  const second = manager.generateFileName("png", fixedNow);
  existing.add(`cashlog-attachments/${second}`);
  const third = manager.generateFileName("png", fixedNow);

  assert.notEqual(second, first);
  assert.notEqual(third, second);
  assert.ok(third.includes("-2."), `应追加递增序号，实际: ${third}`);
});

// ---------------------------------------------------------------- 用户验收反馈

test("[反馈] 围栏代码块内的示例条目不应被索引", () => {
  const content = [
    "# 标题",
    "- #支出/餐饮 真实一 💴-100 ➕2026-09-22",
    "```markdown",
    "- #支出/餐饮 示例一 💴-200 ➕2026-09-22",
    "```",
    "~~~",
    "- #收入 示例二 💴300 ➕2026-09-22",
    "~~~",
    "- #收入 真实二 💴500 ➕2026-09-22",
  ].join("\n");

  const entries = parseFileContent(content, makeSettings(), "账本.md");
  assert.deepEqual(
    entries.map((e) => e.description),
    ["真实一", "真实二"],
    "代码块内的示例不应被当成记账条目",
  );
  assert.equal(entries[0].location?.lineNumber, 1);
  assert.equal(entries[1].location?.lineNumber, 8);
});

test("[反馈] 未闭合代码块之后的内容仍不应被索引", () => {
  const content = [
    "- #支出 真实 💴-1 ➕2026-09-22",
    "```",
    "- #支出 示例 💴-2 ➕2026-09-22",
  ].join("\n");
  assert.equal(parseFileContent(content, makeSettings(), "账本.md").length, 1);
});

test("[反馈] 引用块内的代码块同样应被跳过", () => {
  const content = [
    "> ```markdown",
    "> - #支出 示例 💴-2 ➕2026-09-22",
    "> ```",
    "- #支出 真实 💴-1 ➕2026-09-22",
  ].join("\n");
  const entries = parseFileContent(content, makeSettings(), "账本.md");
  assert.deepEqual(entries.map((e) => e.description), ["真实"]);
});

test("[卡6-命令路径] 光标所在行位置应作为条目位置传递", () => {
  const loc = buildEntryLocationForCursor({ path: "账本.md" }, 7);
  assert.ok(loc, "有文件时应生成位置");
  assert.equal(loc.path, "账本.md");
  assert.equal(loc.lineNumber, 7);

  assert.equal(buildEntryLocationForCursor(null, 7), null);
  assert.equal(buildEntryLocationForCursor(undefined, 7), null);
  assert.equal(buildEntryLocationForCursor({ path: "" }, 7), null);
});

// ---------------------------------------------------------------- 英文界面 / 数值显示

test("[英文] 查询错误信息应由 i18n 提供，而不是硬编码中文", () => {
  const unknown = new Query("this is not a directive", makeSettings());
  assert.equal(
    unknown.getError(),
    tp("error.unknownDirective", { line: "this is not a directive" }),
  );

  const badColumn = new Query(`col${MAX_TABLE_COLS + 1} link "x"`, makeSettings());
  assert.equal(
    badColumn.getError(),
    tp("error.tableColumnIndexOutOfRange", { line: `col${MAX_TABLE_COLS + 1} link "x"`, max: MAX_TABLE_COLS }),
  );

  const badCount = new Query(`table columns ${MAX_TABLE_COLS + 1}`, makeSettings());
  assert.equal(
    badCount.getError(),
    tp("error.tableColumnsOutOfRange", { line: `table columns ${MAX_TABLE_COLS + 1}`, max: MAX_TABLE_COLS }),
  );

  const badField = new Query('col1 nope "x"', makeSettings());
  assert.ok(badField.getError()?.startsWith("不支持的列字段") || badField.getError()?.includes("nope"));

  const badDate = parseFilter("date 这不是一个日期", makeSettings());
  assert.equal(
    badDate?.error,
    tp("error.dateParseFailed", { line: "date 这不是一个日期" }),
  );
});

test("[英文] 分组标题与错误信息的语言包条目齐全", () => {
  const keys = [
    "group.all",
    "group.noTag",
    "group.noDate",
    "group.noAccount",
    "group.weekSuffix",
    "group.typeIncome",
    "group.typeExpense",
    "group.typeTransfer",
    "group.typeBalanceChange",
    "group.typeOther",
    "error.unknownDirective",
    "error.tableColumnsOutOfRange",
    "error.tableColumnIndexOutOfRange",
    "error.tableColumnFieldUnsupported",
    "error.dateParseFailed",
  ];
  for (const key of keys) {
    assert.notEqual(t(key), key, `缺少语言包条目: ${key}`);
  }
});

test("[英文] 分组键应使用本地化文案", () => {
  const entries = [
    parse("- #支出/餐饮 有标签 💴-10 ➕2026-09-22")!,
    parse("- 💴-20 ➕2026-09-22")!, // 无标签、有日期
  ];
  const grouped = new Query("group by tag", makeSettings()).apply(entries);
  assert.ok(
    grouped.groups.some((g) => g.key === t("group.noTag")),
    `无标签分组应使用本地化文案：${grouped.groups.map((g) => g.key).join(",")}`,
  );

  const byType = new Query("group by type", makeSettings()).apply(entries);
  assert.ok(byType.groups.some((g) => g.key === t("group.typeExpense")));
  // 分组键必须来自语言包（换语言时会跟着变），而不是源码里的字面量
  assert.notEqual(t("group.typeExpense"), "group.typeExpense");
});

test("[百分比] 饼图切片整数百分比之和应恰为 100%", () => {  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

  assert.equal(sum(computeIntegerPercentages([1, 1, 1])), 100);
  assert.deepEqual(computeIntegerPercentages([1, 1, 1]), [34, 33, 33]);

  // 用户报的场景：逐项四舍五入会得到 102%
  const reported = [20.5, 20.5, 20.5, 20.5, 18];
  assert.equal(sum(computeIntegerPercentages(reported)), 100);

  // 极端分布
  assert.deepEqual(computeIntegerPercentages([1, 0, 0]), [100, 0, 0]);
  assert.deepEqual(computeIntegerPercentages([0, 0]), [0, 0]);
  assert.deepEqual(computeIntegerPercentages([]), []);

  // 任意随机分布都应为 100
  for (const values of [
    [3, 3, 3, 3, 3, 3, 3],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    [0.1, 0.2, 0.3, 0.4],
  ]) {
    assert.equal(sum(computeIntegerPercentages(values)), 100, `分布 ${values.join(",")} 之和应为 100`);
  }
});

// ---------------------------------------------------------------- 语言包完整性

test("[英文] 中英语言包的 key 集合应完全一致", () => {
  const zh = zhLocale as Record<string, string>;
  const en = enLocale as Record<string, string>;

  const missingInEn = Object.keys(zh).filter((k) => !(k in en)).sort();
  const missingInZh = Object.keys(en).filter((k) => !(k in zh)).sort();

  assert.deepEqual(missingInEn, [], `英文包缺失: ${missingInEn.join(", ")}`);
  assert.deepEqual(missingInZh, [], `中文包缺失: ${missingInZh.join(", ")}`);
});

test("[英文] 同一 key 的占位符在两个语言包里应一致（否则界面会显示 {xxx}）", () => {
  const zh = zhLocale as Record<string, string>;
  const en = enLocale as Record<string, string>;
  const placeholders = (text: string) => (text.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(",");

  const mismatched = Object.keys(zh)
    .filter((key) => placeholders(zh[key]) !== placeholders(en[key] ?? ""))
    .map((key) => `${key}: zh[${placeholders(zh[key])}] en[${placeholders(en[key] ?? "")}]`);

  assert.deepEqual(mismatched, [], `占位符不一致:\n${mismatched.join("\n")}`);
});

test("[文案] 本轮新增的语言包条目存在且占位符可替换", () => {
  for (const key of [
    "panelSettings.cacheAccountHint",
    "panelSettings.cacheAccountNotice",
    "notice.accountRegistered",
    "attachment.defaultName",
    "attachment.numberedName",
    "dashboard.categoryRankHint",
  ]) {
    assert.notEqual(t(key), key, `缺少语言包条目: ${key}`);
  }

  assert.ok(tp("attachment.numberedName", { n: 3 }).includes("3"), "附件编号占位符应被替换");
  assert.ok(!tp("notice.accountRegistered", { name: "微信" }).includes("{name}"));
});

// ------------------------------------------- 第 5 轮：隐私开关接线 / 错误累积 / 表头转义

// 源码目录定位（用于语言包引用完整性与静态检查用例）。
// 从打包产物 dist/ 出发回溯到仓库，兼容从不同目录运行。
const SRC_DIR: string | undefined = [
  // 迁移进仓库后：打包产物在 tests/dist/，上一级是仓库根
  resolve(__dirname, "..", "..", "src"),
  // 从仓库根运行（npm test）
  resolve(process.cwd(), "src"),
  // 兼容旧的「测试基建在仓库外」布局
  resolve(__dirname, "..", "..", "..", "obsidian-cashlog-main", "src"),
  resolve(process.cwd(), "obsidian-cashlog-main", "src"),
].find((p) => existsSync(p));

// 渲染一组条目并返回容器，供下面各用例断言。
// 关掉编辑按钮与笔记链接，避免无关节点干扰文本断言。
function renderEntries(source: string, markdownLines: string[], hideAmounts = false): FakeElement {
  const settings = makeSettings({ showEditButton: false, showNoteLink: false });
  const entries = markdownLines
    .map((line) => parse(line, settings))
    .filter((e): e is CashlogEntry => e !== null);
  const query = new Query(source, settings);
  const result = query.apply(entries);
  const container = new FakeElement("div");
  renderQueryResult(
    container as unknown as HTMLElement,
    result,
    query,
    fakePlugin(settings, entries),
    hideAmounts,
  );
  return container;
}

const WITH_ACCOUNT = "- #支出/购物 买衣服 💳微信💴-200 ➕2026-04-25";
const WITHOUT_ACCOUNT = "- #支出/购物 买衣服 💴-200 ➕2026-04-25";
const TRANSFER = "- #转账 还信用卡 💳支付宝💴-500 💳工行💴500 ➕2026-04-25";

test("[对照] 无隐私指令时应渲染出账户与账户金额", () => {
  const text = collectText(renderEntries("is expense", [WITH_ACCOUNT]));
  assert.ok(text.includes("💳微信💴-200"), `应渲染账户与金额，实际: ${text}`);
});

test("[Bug2] hide amount 应省略金额、保留账户名", () => {
  const text = collectText(renderEntries("is expense\nhide amount", [WITH_ACCOUNT]));
  assert.ok(text.includes("💳微信"), `应保留账户名，实际: ${text}`);
  assert.ok(!text.includes("-200"), `不应出现金额，实际: ${text}`);
  assert.ok(!text.includes("💴"), `金额整段都应省略（不留 💴 占位），实际: ${text}`);
  assert.ok(!text.includes("***"), `不应出现打码占位，实际: ${text}`);
});

test("[对照] hide amount 对无账户条目原本就生效", () => {
  const text = collectText(renderEntries("is expense\nhide amount", [WITHOUT_ACCOUNT]));
  assert.ok(!text.includes("-200"), `无账户金额应被隐藏，实际: ${text}`);
});

test("[Bug1] hide account 应省略账户名、保留金额", () => {
  const text = collectText(renderEntries("is expense\nhide account", [WITH_ACCOUNT]));
  assert.ok(text.includes("💴-200"), `应保留金额，实际: ${text}`);
  assert.ok(!text.includes("微信"), `不应出现账户名，实际: ${text}`);
  assert.ok(!text.includes("💳"), `账户名整段都应省略（不留 💳 占位），实际: ${text}`);
  assert.ok(!text.includes("***"), `不应出现打码占位，实际: ${text}`);
});

test("[Bug1] show account 应覆盖 hide account", () => {
  const text = collectText(renderEntries("is expense\nhide account\nshow account", [WITH_ACCOUNT]));
  assert.ok(text.includes("💳微信💴-200"), `show account 应完全恢复账户项，实际: ${text}`);
});

test("[Bug1] 未写 show account 时 hide account 仍应生效（确认不是恒真）", () => {
  const text = collectText(renderEntries("is expense\nhide account", [WITH_ACCOUNT]));
  assert.ok(text.includes("💴-200"), `hide account 应生效并保留金额，实际: ${text}`);
  assert.ok(!text.includes("微信"), `不应出现账户名，实际: ${text}`);
});

test("[Bug1/Bug2] 两个开关同时使用时账户项无内容可显示，不渲染占位", () => {
  const text = collectText(renderEntries("is expense\nhide account\nhide amount", [WITH_ACCOUNT]));
  assert.ok(!text.includes("微信"), `不应出现账户名，实际: ${text}`);
  assert.ok(!text.includes("-200"), `不应出现金额，实际: ${text}`);
  assert.ok(!text.includes("💳") && !text.includes("💴"), `不应残留任何占位，实际: ${text}`);
  assert.ok(text.includes("买衣服"), `条目本身仍应渲染，实际: ${text}`);
});

test("[问题1] hide amount 在两种条目上的表现应一致（都省略金额）", () => {
  const withAcct = collectText(renderEntries("is expense\nhide amount", [WITH_ACCOUNT]));
  const withoutAcct = collectText(renderEntries("is expense\nhide amount", [WITHOUT_ACCOUNT]));
  assert.ok(!withAcct.includes("💴") && !withAcct.includes("-200"), `账户条目不应残留金额，实际: ${withAcct}`);
  assert.ok(!withoutAcct.includes("💴") && !withoutAcct.includes("-200"), `无账户条目不应残留金额，实际: ${withoutAcct}`);
  assert.ok(withAcct.includes("买衣服") && withoutAcct.includes("买衣服"), "两者的条目本身都应照常渲染");
});

test("[Bug1/Bug2] 转账条目的账户金额同样受两个开关约束", () => {
  const plain = collectText(renderEntries("is transfer", [TRANSFER]));
  assert.ok(plain.includes("💳支付宝💴-500"), `对照应显示转出账户与金额，实际: ${plain}`);
  assert.ok(plain.includes("💳工行💴500"), `对照应显示转入账户与金额，实际: ${plain}`);

  const noAmount = collectText(renderEntries("is transfer\nhide amount", [TRANSFER]));
  assert.ok(!noAmount.includes("-500") && !noAmount.includes("💴"), `转账金额应被省略，实际: ${noAmount}`);
  assert.ok(noAmount.includes("支付宝") && noAmount.includes("工行"), `应保留两个账户名，实际: ${noAmount}`);

  const noAccount = collectText(renderEntries("is transfer\nhide account", [TRANSFER]));
  assert.ok(!noAccount.includes("支付宝") && !noAccount.includes("工行"), `不应出现账户名，实际: ${noAccount}`);
  assert.ok(noAccount.includes("💴-500"), `转出金额应保留，实际: ${noAccount}`);
  assert.ok(noAccount.includes("💴500"), `转入金额应保留，实际: ${noAccount}`);
});

test("[Bug2] 面板隐私开关应覆盖条目列表里的账户金额（打码，而非省略）", () => {
  const text = collectText(renderEntries("is expense", [WITH_ACCOUNT], true));
  assert.ok(!text.includes("-200"), `面板开关开启后不应出现账户金额，实际: ${text}`);
  assert.ok(text.includes("💳微信💴***"), `面板开关应打码为 ***，实际: ${text}`);
});

test("[Bug3] 多条非法指令应全部报出，而不是只留最后一条", () => {
  const q = new Query("foo bar\nbaz qux", makeSettings());
  const err = q.getError();
  assert.ok(err, "非法指令应报错");
  assert.ok(err!.includes("foo bar"), `错误信息应包含第一条，实际: ${err}`);
  assert.ok(err!.includes("baz qux"), `错误信息应包含第二条，实际: ${err}`);
  assert.equal(err!.split("\n").length, 2, `两条错误应各占一行，实际: ${JSON.stringify(err)}`);
});

test("[对照] 单条非法指令仍只报一条", () => {
  const q = new Query("foo bar", makeSettings());
  assert.equal(q.getError(), tp("error.unknownDirective", { line: "foo bar" }));
});

test("[Bug4] colN 表头含转义双引号时应能解析并还原", () => {
  const d = parseTableDirective('col1 description "a\\"b"');
  assert.ok(d !== null, "含转义引号的 colN 行不应被丢弃");
  assert.equal(d!.error, undefined, `不应报错，实际: ${d!.error}`);
  assert.equal(d!.header, 'a"b', "表头应还原为用户输入");
});

test("[Bug4] 含转义引号的 colN 不再被当成未知指令（端到端）", () => {
  const source = 'col1 date "他说\\"好\\"" center';
  const q = new Query(source, makeSettings());
  assert.equal(q.getError(), null, `不应报未知指令，实际: ${q.getError()}`);

  const cfg = parseTableConfig(source);
  assert.equal(cfg.cols[0].header, '他说"好"');
  assert.equal(cfg.cols[0].align, "center");
});

test("[对照] colN 普通表头与对齐解析不受影响", () => {
  const d = parseTableDirective('col3 account "账户" left');
  assert.equal(d!.header, "账户");
  assert.equal(d!.align, "left");
  assert.equal(d!.colIndex, 2);
});

test("[Bug5] chart title 含转义双引号时应还原，而不是被截断", () => {
  const q = new Query('chart title "A\\"B"', makeSettings());
  assert.equal(q.getChartConfig().title, 'A"B');
});

test("[Bug5] 向导生成的标题（含转义引号）应能完整还原", () => {
  const q = new Query('chart title "他说\\"好\\""', makeSettings());
  assert.equal(q.getChartConfig().title, '他说"好"');
});

test("[对照] chart title 普通标题解析不受影响", () => {
  const q = new Query('chart title "月度收支对比"', makeSettings());
  assert.equal(q.getChartConfig().title, "月度收支对比");
});

test("[一致性] parseChartConfig 与 Query 的 chart title 解析必须一致", () => {
  // 两处曾各自持有一份正则，容易再次漂移
  for (const source of [
    'chart title "A\\"B"',
    'chart title "他说\\"好\\""',
    'chart title "月度收支对比"',
  ]) {
    const viaConfig = parseChartConfig(source).title;
    const viaQuery = new Query(source, makeSettings()).getChartConfig().title;
    assert.equal(viaConfig, viaQuery, `同一 source 两处解析结果应一致（${source}）`);
  }
  assert.equal(parseChartConfig('chart title "A\\"B"').title, 'A"B');
});

test("[发现6] chartModal.field.type 必须存在于语言包（否则向导显示原始 key）", () => {
  assert.notEqual(
    t("chartModal.field.type"),
    "chartModal.field.type",
    "列字段下拉不应裸露 i18n key",
  );
  assert.notEqual(t("chartModal.field.type"), t("chartModal.field.link"));
});

test("[发现6] 源码里静态引用的 t()/tp() key 都应存在于语言包", () => {
  assert.ok(SRC_DIR, "未能定位 obsidian-cashlog-main/src，无法执行语言包引用完整性检查");
  const zh = zhLocale as Record<string, string>;
  const en = enLocale as Record<string, string>;

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  };

  const missing: string[] = [];
  for (const file of walk(SRC_DIR!)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\btp?\(\s*"([^"]+)"/g)) {
      const key = m[1];
      if (!(key in zh) || !(key in en)) {
        missing.push(`${file.split(/[\\/]/).pop()}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], `以下 i18n key 被代码引用但语言包缺失:\n${missing.join("\n")}`);
});

// 说明：列编辑器的占位符映射位于 ChartModal 内部（依赖 Obsidian Setting/DOM），
// 无法在 Node 下运行时调用，因此这里做源码级静态检查，防止 type 分支被误删。
test("[发现7] 列编辑器占位符应按字段动态取文案，且全部字段都有对应文案", () => {
  assert.ok(SRC_DIR, "未能定位 obsidian-cashlog-main/src，无法执行静态检查");
  const chartModal = readFileSync(join(SRC_DIR!, "ChartModal.ts"), "utf8");
  // 旧实现用三元链硬编码字段，漏一个分支就会错标；
  // 现改为按字段动态拼 key，因此只需确认该写法存在。
  assert.ok(
    /chartModal\.field\.\$\{col\.field\}/.test(chartModal),
    "列编辑器占位符应使用 `chartModal.field.${col.field}` 动态取文案",
  );
  // 动态 key 无法被静态扫描覆盖，这里逐个字段验证语言包里确实有文案
  for (const field of TABLE_COL_FIELDS) {
    const key = `chartModal.field.${field}`;
    assert.notEqual(t(key), key, `语言包缺少列字段文案：${key}`);
  }
});

// ------------------------------------------- 2026-11 修复批：图表指令 / 色板 / 预算滚存

const TABLE_SRC = [
  "is expense",
  "table columns 3",
  'col1 date "日期"',
  'col2 amount "金额"',
  'col3 account "账户"',
].join("\n");

function renderTable(source: string): string {
  const settings = makeSettings({ showEditButton: false, showNoteLink: false });
  const entries = [parse("- #支出/购物 买衣服 💳微信💴-200 ➕2026-04-25", settings)]
    .filter((e): e is CashlogEntry => e !== null);
  const query = new Query(source, settings);
  assert.equal(query.getError(), null, `查询不应报错: ${query.getError()}`);
  const container = new FakeElement("div");
  renderChartTable(
    container as unknown as HTMLElement,
    query.apply(entries),
    query,
    parseTableConfig(source),
    fakePlugin(settings, entries),
  );
  return collectText(container);
}

test("[FIX-6] 对照：不写 hide 指令时表格应有 日期/金额/账户 三列", () => {
  const text = renderTable(TABLE_SRC);
  assert.ok(text.includes("日期"), `应有日期列，实际: ${text}`);
  assert.ok(text.includes("金额"), `应有金额列，实际: ${text}`);
  assert.ok(text.includes("账户"), `应有账户列，实际: ${text}`);
});

test("[FIX-6] hide amount 应移除表格的金额列", () => {
  const text = renderTable(`${TABLE_SRC}\nhide amount`);
  assert.ok(!text.includes("金额"), `金额列应被移除，实际: ${text}`);
  assert.ok(text.includes("日期") && text.includes("账户"), `其余列应保留，实际: ${text}`);
});

test("[FIX-6] hide account 应移除账户列，show account 应抵消它", () => {
  const hidden = renderTable(`${TABLE_SRC}\nhide account`);
  assert.ok(!hidden.includes("账户"), `账户列应被移除，实际: ${hidden}`);

  const restored = renderTable(`${TABLE_SRC}\nhide account\nshow account`);
  assert.ok(restored.includes("账户"), `show account 应恢复账户列，实际: ${restored}`);
});

test("[FIX-6] hide date 应移除日期列", () => {
  const text = renderTable(`${TABLE_SRC}\nhide date`);
  assert.ok(!text.includes("日期"), `日期列应被移除，实际: ${text}`);
});

test("[FIX-4] 图表默认色板 10 色、面板饼图色板 20 色，且后者包含前者全部颜色", () => {
  assert.equal(CHART_COLORS.length, 10, "图表色板应为 10 色");
  assert.equal(PANEL_PIE_COLORS.length, 20, "面板饼图色板应为 20 色");
  for (const c of CHART_COLORS) {
    assert.ok(PANEL_PIE_COLORS.includes(c), `面板色板应包含图表颜色 ${c}`);
  }
});

test("[FIX-9] 预算 rollover 应把上一周期结余滚入本期额度", () => {
  const settings = makeSettings();
  const manager = new BudgetManager();

  // 上个月的一笔支出（相对当前时刻构造，避免跨月失效）
  const lastMonthDay = moment().subtract(1, "month").date(10).format("YYYY-MM-DD");
  const entry = parse(`- #支出/购物 上月花费 💴-100 ➕${lastMonthDay}`, settings);
  assert.ok(entry, "测试条目应能解析");

  const base = { name: "测试预算", amount: 500, period: "monthly" as const, tag: "#支出" };
  const withoutRollover = manager.getBudgetProgress(
    [entry!], [{ ...base, id: "b1", rollover: false }], 1, 1,
  );
  const withRollover = manager.getBudgetProgress(
    [entry!], [{ ...base, id: "b2", rollover: true }], 1, 1,
  );

  assert.equal(withoutRollover[0].remaining, 500, "关闭滚存时额度应保持 500");
  // 上期额度 500 - 支出 100 = 结余 400 → 本期额度 900
  assert.equal(withRollover[0].remaining, 900, "开启滚存后额度应为 500+400=900");
});

test("[FIX-9] day/custom 周期无法定义上一周期，rollover 不应改变额度", () => {
  const settings = makeSettings();
  const manager = new BudgetManager();
  const entry = parse("- #支出/购物 今天 💴-50 ➕" + moment().format("YYYY-MM-DD"), settings);
  const progress = manager.getBudgetProgress(
    [entry!],
    [{ id: "b3", name: "日预算", amount: 100, period: "day" as never, tag: "#支出", rollover: true }],
    1, 1,
  );
  // 若 rollover 被错误应用，额度会变化，百分比不再是 50/100
  assert.equal(progress[0].percentage, 50, "day 周期不滚存，百分比应为 50%");
  assert.equal(progress[0].isOverspent, false);
});

// ------------------------------------------- i18n 端口化：语言解析与货币覆盖

test("[i18n] 语言检测：别名命中与同族回退", () => {
  initI18n("zh-CN");
  assert.equal(getLocale(), "zh-CN");

  initI18n("zh-TW");
  assert.equal(getLocale(), "zh-CN", "zh-TW 应落回 zh-CN（同语言族）");

  initI18n("zh");
  assert.equal(getLocale(), "zh-CN", "zh 别名应命中 zh-CN");

  initI18n("en-GB");
  assert.equal(getLocale(), "en", "en-GB 别名应命中 en");

  initI18n("fr-FR");
  assert.equal(getLocale(), "en", "未注册语言应回退到 en");

  initI18n("");
  assert.equal(getLocale(), "en", "空语言标识应回退到 en");
});

test("[i18n] 货币符号：语言默认 + 设置覆盖", () => {
  initI18n("zh-CN");
  setCurrencyOverride(null);
  assert.equal(getCurrencySymbol(), "¥", "中文默认 ¥");

  initI18n("en");
  assert.equal(getCurrencySymbol(), "$", "英文默认 $");

  setCurrencyOverride("NT$");
  assert.equal(getCurrencySymbol(), "NT$", "设置覆盖应优先于语言默认");

  initI18n("zh-CN");
  assert.equal(getCurrencySymbol(), "NT$", "覆盖在语言切换后仍生效");

  setCurrencyOverride("");
  assert.equal(getCurrencySymbol(), "¥", "空覆盖应恢复语言默认");

  setCurrencyOverride(null);
});

test("[i18n] 翻译回退链：当前语言命中，缺失 key 原样返回", () => {
  initI18n("zh-CN");
  assert.equal(t("settings.newBudget"), zhLocale["settings.newBudget"]);
  assert.equal(t("__not_a_real_key__"), "__not_a_real_key__", "缺失 key 应原样返回");
});

// ------------------------------------------- 插件加载冒烟：onload 必须完整执行
//
// 这一条能捕获「模块加载期正常、但 onload 里引用了未定义符号」这类问题。
// 实际发生过的例子：main.ts 用了 t("...") 但只 import 了 tp，构建照常通过，
// 插件却在 Obsidian 里加载失败。

test("[冒烟] 编辑器右键菜单应注册「记账」与「插入图表」，点击能唤起弹窗", async () => {
  const plugin = new CashlogPlugin() as unknown as Record<string, unknown>;
  let menuHandler: ((menu: unknown, editor: unknown, view: unknown) => void) | null = null;

  plugin.app = {
    vault: { getMarkdownFiles: () => [], on: () => ({}) },
    metadataCache: { resolvedLinks: {}, getFileCache: () => null, on: () => ({}) },
    workspace: {
      on: (evt: string, cb: unknown) => {
        if (evt === "editor-menu") menuHandler = cb as typeof menuHandler;
        return {};
      },
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      onLayoutReady: (cb: () => void) => {
        cb();
      },
    },
  };
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  plugin.addRibbonIcon = () => ({});
  plugin.registerView = () => {};
  plugin.addSettingTab = () => {};
  plugin.registerMarkdownCodeBlockProcessor = () => {};
  plugin.registerEvent = () => ({});
  plugin.addCommand = () => {};

  await (plugin.onload as () => Promise<void>).call(plugin);
  assert.ok(menuHandler, "onload 中应注册 editor-menu 事件");

  // 最小 Menu 替身：支持一级项与子菜单，记录标题、section 与点击回调
  interface MenuItemStub {
    title: string;
    handler: (() => void) | null;
    submenu: MenuStub | null;
    section: string;
  }
  interface MenuStub {
    items: MenuItemStub[];
    addItem: (fn: (item: unknown) => void) => void;
  }
  function createMenuStub(): MenuStub {
    const menu = {
      items: [] as MenuItemStub[],
      addItem: (fn: (item: unknown) => void) => {
        const item = {
          title: "",
          handler: null as (() => void) | null,
          submenu: null as MenuStub | null,
          section: "",
          setTitle(v: string) {
            item.title = v;
            return item;
          },
          setIcon() {
            return item;
          },
          setSection(v: string) {
            item.section = v;
            return item;
          },
          onClick(cb: () => void) {
            item.handler = cb;
            return item;
          },
          setSubmenu() {
            item.submenu = createMenuStub();
            return item.submenu;
          },
        };
        fn(item);
        menu.items.push(item);
      },
    };
    return menu;
  }

  const editor = {
    getCursor: () => ({ line: 0, ch: 0 }),
    getLine: () => "",
    replaceRange: () => {},
    setLine: () => {},
  };
  const view = { file: null };

  // 账目图表通过 MenuItem.setSection 归入 Obsidian 内置「插入」组。
  // 实测「插入」不是子菜单，而是一组 section 前缀相同的项（selection.insert.*），
  // 由 Obsidian 渲染时合并成可展开菜单；因此这里验证 section 而不是 submenu。
  const menu = createMenuStub();
  assert.doesNotThrow(() => menuHandler!(menu, editor, view), "构建右键菜单不应抛错");

  const ledger = menu.items.find((i) => i.title === t("commands.createOrEdit"));
  const chart = menu.items.find((i) => i.title === t("menu.chart"));
  assert.ok(ledger, "应有「创建或编辑记账」");
  assert.ok(chart, "应有「账目图表」");
  assert.ok(
    chart!.section === "selection.insert.advanced",
    `账目图表应归入「插入 → 高级」组，实际 section=${chart!.section}`,
  );

  assert.doesNotThrow(() => ledger!.handler!(), "点击「记账」应唤起 CashlogModal");
  assert.doesNotThrow(() => chart!.handler!(), "点击「账目图表」应唤起 ChartModal");
});

test("[冒烟] 插件 onload 应完整执行且不抛错", async () => {
  const plugin = new CashlogPlugin() as unknown as Record<string, unknown>;

  plugin.app = {
    vault: { getMarkdownFiles: () => [], on: () => ({}) },
    metadataCache: { resolvedLinks: {}, getFileCache: () => null, on: () => ({}) },
    workspace: {
      on: () => ({}),
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      onLayoutReady: (cb: () => void) => {
        cb();
      },
    },
  };
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  plugin.addRibbonIcon = () => ({});
  plugin.registerView = () => {};
  plugin.addSettingTab = () => {};
  plugin.registerMarkdownCodeBlockProcessor = () => {};
  plugin.registerEvent = () => ({});
  plugin.addCommand = () => {};

  const onload = plugin.onload as () => Promise<void>;
  await assert.doesNotReject(
    () => onload.call(plugin),
    "插件 onload 不应抛错，否则 Obsidian 会提示加载失败",
  );
});

// ------------------------------------------- FIX-2 运行时验证：设置页是否真的渲染出预算 UI

function renderSettingsTab(over: Partial<CashlogSettings>): string {
  const settings = makeSettings({ enableAccounts: false, enableAttachments: false, ...over });
  const plugin = {
    settings,
    app: {},
    saveSettings: async () => {},
    saveSettingsAndReindex: async () => {},
    saveSettingsDebounced: () => {},
  } as never;

  const container = new FakeElement("div");
  const tab = new CashlogSettingsTab({} as never, plugin);
  (tab as unknown as { containerEl: FakeElement }).containerEl = container;
  tab.display();
  return collectText(container);
}

test("[FIX-2] 开启预算后，原生设置页应渲染出预算管理 UI", () => {
  const text = renderSettingsTab({ enableBudgets: true });
  assert.ok(text.includes(t("settings.section.budget")), `应有「预算设置」分区标题`);
  assert.ok(
    text.includes(t("settings.newBudget")),
    `应渲染「新增预算」表单与添加按钮，实际设置页文本: ${text.slice(0, 600)}`,
  );
});

test("[FIX-2] 关闭预算开关时不渲染预算表单（保留分区标题）", () => {
  const text = renderSettingsTab({ enableBudgets: false });
  assert.ok(text.includes(t("settings.section.budget")), "分区标题应始终存在");
  assert.ok(!text.includes(t("settings.newBudget")), "关闭开关时不应出现新增表单");
});

test("[FIX-2] 开启目标后，原生设置页应渲染出目标管理 UI", () => {
  const text = renderSettingsTab({ enableBudgets: false, enableGoals: true });
  assert.ok(text.includes(t("settings.section.goals")), "应有「目标设置」分区标题");
  assert.ok(text.includes(t("settings.newGoal")), `应渲染「新增目标」表单，实际: ${text.slice(0, 600)}`);
});

// ------------------------------------------- FIX-1 运行时验证：子页面是否真的渲染出眼睛按钮

function findClass(el: FakeElement, cls: string): boolean {
  if (el.cls.includes(cls)) return true;
  return el.children.some((c) => findClass(c, cls));
}

test("[FIX-1] 子页面头部应同时渲染「返回」与「金额隐藏开关」按钮", () => {
  const plugin = { settings: makeSettings(), app: {}, events: { on: () => ({}) } } as never;
  const view = new CashlogView({} as never, plugin);
  const container = new FakeElement("div");
  (view as unknown as { panelContentEl: FakeElement }).panelContentEl = container;
  (view as unknown as { hideAmounts: boolean }).hideAmounts = true;

  (view as unknown as { renderSubPageHeader: () => void }).renderSubPageHeader();

  assert.ok(findClass(container, "cashlog-back-btn"), "子页面应有返回按钮");
  assert.ok(
    findClass(container, "cashlog-subpage-toggle"),
    `子页面应有金额隐藏开关按钮（class=cashlog-subpage-toggle），实际渲染: ${collectText(container)}`,
  );
});

test("[FIX-1] 对照：开关按钮位于 subpage-header 容器内（而非散落）", () => {
  const plugin = { settings: makeSettings(), app: {}, events: { on: () => ({}) } } as never;
  const view = new CashlogView({} as never, plugin);
  const container = new FakeElement("div");
  (view as unknown as { panelContentEl: FakeElement }).panelContentEl = container;
  (view as unknown as { renderSubPageHeader: () => void }).renderSubPageHeader();

  const header = container.children.find((c) => c.cls.includes("cashlog-subpage-header"));
  assert.ok(header, "应存在 cashlog-subpage-header 容器");
  assert.ok(findClass(header!, "cashlog-subpage-toggle"), "开关按钮应在 header 容器内");
});

// ------------------------------------------- 面板设置结构：内容必须落在 section 内部（修复「两条分割线」）

test("[面板] 设置分区的内容应绘制在 section 内部，且不再渲染独立分割线", () => {
  const settings = makeSettings({
    enableAccounts: false,
    enableAttachments: false,
    enableBudgets: false,
    enableGoals: false,
  });
  const plugin = {
    settings,
    events: { on: () => ({}) },
    cache: { getEntries: () => [] },
    saveSettings: async () => {},
    saveSettingsAndReindex: async () => {},
    saveData: async () => {},
  } as never;

  const container = new FakeElement("div");
  container.addClass("cashlog-panel-content");
  Object.assign(container, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });

  renderPanelSettings(container as unknown as HTMLElement, plugin);

  const sections = container.children.filter((c) => c.cls.includes("cashlog-settings-section"));
  assert.ok(sections.length >= 5, `应渲染多个设置分区，实际 ${sections.length}`);

  for (const sec of sections) {
    const title = collectText(sec).slice(0, 20);
    const content = sec.children.find((c) => c.cls.includes("cashlog-settings-content"));
    if (!content) {

      // 功能关闭的分区只有标题行（开关在标题行上），不渲染内容块 —— 这是设计行为

      assert.equal(sec.children.length, 1, `分区「${title}」没有 content 时只应有标题行`);

      continue;

    }

    assert.ok(

      content.children.length > 0,

      `分区「${title}」的 content 不应为空 —— 内容被错误地加到了 section 外部`,

    );
  }

  let dividers = 0;
  (function count(el: FakeElement): void {
    if (el.cls.includes("cashlog-settings-divider")) dividers += 1;
    for (const c of el.children) count(c);
  })(container);
  assert.equal(dividers, 0, "不应再渲染 cashlog-settings-divider（分区改用卡片间距分隔）");
});

// ------------------------------------------- 端到端 / 属性 / 差分：面板设置

function makePanelPlugin(over: Partial<CashlogSettings> = {}): never {
  return {
    settings: makeSettings({ enableAccounts: true, enableAttachments: true, enableBudgets: true, enableGoals: true, ...over }),
    events: { on: () => ({}) },
    cache: { getEntries: () => [] },
    saveSettings: async () => {},
    saveSettingsAndReindex: async () => {},
    saveData: async () => {},
  } as never;
}

function renderPanel(over: Partial<CashlogSettings> = {}): FakeElement {
  const container = new FakeElement("div");
  container.addClass("cashlog-panel-content");
  Object.assign(container, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
  renderPanelSettings(container as unknown as HTMLElement, makePanelPlugin(over));
  return container;
}

function assertPanelStructure(container: FakeElement, label: string): void {
  const sections = container.children.filter((c) => c.cls.includes("cashlog-settings-section"));
  assert.ok(sections.length >= 5, `${label}: 应渲染多个分区，实际 ${sections.length}`);
  for (const sec of sections) {
    const title = collectText(sec).slice(0, 20);
    const content = sec.children.find((c) => c.cls.includes("cashlog-settings-content"));
    if (!content) {

      // 功能关闭的分区只有标题行（开关在标题行上），不渲染内容块 —— 这是设计行为

      assert.equal(sec.children.length, 1, `${label}: 分区「${title}」没有 content 时只应有标题行`);

      continue;

    }

    assert.ok(content.children.length > 0, `${label}: 分区「${title}」内容为空（未绘制进 section）`);
  }
  let dividers = 0;
  (function count(el: FakeElement): void {
    if (el.cls.includes("cashlog-settings-divider")) dividers += 1;
    for (const c of el.children) count(c);
  })(container);
  assert.equal(dividers, 0, `${label}: 不应再出现 cashlog-settings-divider`);
}

test("[端到端] 打开面板设置 → 重建（开关/删除后刷新）→ 结构完整且滚动位置保持", () => {
  const container = new FakeElement("div");
  container.addClass("cashlog-panel-content");
  // 模拟真实滚动状态：总高 1000、视口 100、当前滚到 500（比例 500/900）
  Object.assign(container, { scrollTop: 500, scrollHeight: 1000, clientHeight: 100 });

  const plugin = makePanelPlugin();
  renderPanelSettings(container as unknown as HTMLElement, plugin);

  assertPanelStructure(container, "[首次渲染]");
  assert.equal(container.scrollTop, 500, "重建后滚动位置应按比例保持（不应跳回顶部）");

  // 再重建一次：模拟用户再次切换开关 / 删除条目后触发的刷新
  renderPanelSettings(container as unknown as HTMLElement, plugin);
  assertPanelStructure(container, "[二次重建]");
  assert.equal(container.scrollTop, 500, "二次重建后滚动位置仍应保持");
});

test("[属性] 16 种功能开关组合下，每个分区的内容都必须落在 section 内", () => {
  let combos = 0;
  for (const enableAccounts of [false, true]) {
    for (const enableAttachments of [false, true]) {
      for (const enableBudgets of [false, true]) {
        for (const enableGoals of [false, true]) {
          combos += 1;
          const label = `[accounts=${enableAccounts} attach=${enableAttachments} budget=${enableBudgets} goal=${enableGoals}]`;
          assertPanelStructure(renderPanel({ enableAccounts, enableAttachments, enableBudgets, enableGoals }), label);
        }
      }
    }
  }
  assert.equal(combos, 16, "应覆盖全部 16 种开关组合");
});

test("[属性] 边界数据（空/超长/特殊字符/大量账户）下渲染不崩溃且结构完整", () => {
  const cases: Array<{ name: string; accounts: string[] }> = [
    { name: "空账户列表", accounts: [] },
    { name: "超长账户名", accounts: ["A".repeat(300)] },
    { name: "特殊字符账户", accounts: ["<script>alert(1)</script>", "&amp;", "账号/带斜杠"] },
    { name: "大量账户", accounts: Array.from({ length: 60 }, (_, i) => `账户${i}`) },
  ];
  for (const c of cases) {
    const plugin = makePanelPlugin({ enableAccounts: true });
    (plugin as unknown as { settings: CashlogSettings }).settings.accounts = c.accounts;
    const container = new FakeElement("div");
    container.addClass("cashlog-panel-content");
    Object.assign(container, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    renderPanelSettings(container as unknown as HTMLElement, plugin);
    assertPanelStructure(container, `[${c.name}]`);
  }
});

// ------------------------------------------- 差分测试：修复前 vs 修复后（同一份输入）

test("[差分] 同一份输入下：修复前 section 内容为空且有分割线，修复后内容进卡片且无分割线", () => {
  // 旧版模块由 build.mjs 单独产出，源码来自 `git show HEAD:src/PanelSettings.ts`
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oldMod = require("./panel-settings-old.cjs") as {
    renderPanelSettings: (c: unknown, p: unknown) => void;
  };

  const renderWith = (fn: (c: unknown, p: unknown) => void): FakeElement => {
    const plugin = makePanelPlugin();
    const container = new FakeElement("div");
    container.addClass("cashlog-panel-content");
    Object.assign(container, { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    fn(container as unknown as HTMLElement, plugin);
    return container;
  };

  const countByClass = (el: FakeElement, cls: string): number => {
    let n = el.cls.includes(cls) ? 1 : 0;
    for (const c of el.children) n += countByClass(c, cls);
    return n;
  };

  const emptyContents = (root: FakeElement): number =>
    root.children
      .filter((c) => c.cls.includes("cashlog-settings-section"))
      .filter((s) => {
        const content = s.children.find((c) => c.cls.includes("cashlog-settings-content"));
        return !content || content.children.length === 0;
      }).length;

  const before = renderWith(oldMod.renderPanelSettings);
  const after = renderWith(renderPanelSettings);

  // 修复前：所有 section 的 content 为空 + 存在分割线（这正是被修复的缺陷）
  assert.ok(emptyContents(before) > 0, "修复前应有 section 的 content 为空");
  const beforeDividers = countByClass(before, "cashlog-settings-divider");
  assert.ok(beforeDividers > 0, "修复前应渲染 cashlog-settings-divider");

  // 修复后：没有空 content、没有分割线
  assert.equal(emptyContents(after), 0, "修复后不应再有空的 content");
  assert.equal(countByClass(after, "cashlog-settings-divider"), 0, "修复后不应再有分割线");

  // 同一份输入，输出确实不同
  assert.notEqual(beforeDividers, 0, "新旧分割线数量应有差异（旧 > 0，新 = 0）");
});

// ------------------------------------------- 表格列增强：顺序式 column 指令

test("[FEAT] column 指令：出现顺序即列序，且首次出现会丢弃默认列", () => {
  const q = new Query('column amount "金额"\ncolumn date "日期"', makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.tableColCount, 2, "只应有 2 列，默认的 6 列应被丢弃");
  assert.equal(q.tableCols[0].field, "amount");
  assert.equal(q.tableCols[1].field, "date");
  assert.equal(q.tableCols[0].header, "金额");
});

test("[FEAT] column 支持 tag 与 time 字段", () => {
  const q = new Query('column tag "标签"\ncolumn time "时刻"', makeSettings());
  assert.equal(q.getError(), null);
  assert.equal(q.tableCols[0].field, "tag");
  assert.equal(q.tableCols[1].field, "time");
});

test("[FEAT] column 与 colN 混用应报错（两种语法须各自独立）", () => {
  const forward = new Query("column date\ncol2 amount", makeSettings());
  assert.ok(forward.getError(), "column 在前、colN 在后应报错");

  const backward = new Query("col1 date\ncolumn amount", makeSettings());
  assert.ok(backward.getError(), "colN 在前、column 在后应报错");
});

test("[对照] 只用 colN 时不报错（旧笔记保持兼容）", () => {
  const q = new Query(
    'table columns 3\ncol1 date "日期"\ncol2 amount "金额"\ncol3 account "账户"',
    makeSettings(),
  );
  assert.equal(q.getError(), null);
  assert.equal(q.tableColCount, 3);
});

test("[FEAT] column 超过列数上限应报错", () => {
  const many = Array.from({ length: MAX_TABLE_COLS + 1 }, (_, i) => `column date "c${i}"`).join("\n");
  const q = new Query(many, makeSettings());
  assert.ok(q.getError(), `超过 ${MAX_TABLE_COLS} 列应报错`);
});

test("[FEAT] 表格应能渲染 tag 与 time 列", () => {
  const source = [
    "is expense",
    'column date "日期"',
    'column tag "标签"',
    'column time "时刻"',
  ].join("\n");
  const settings = makeSettings({ showEditButton: false, showNoteLink: false });
  const entries = [parse("- #支出/餐饮 午餐 💴-35 ➕2026-04-25 ⏰12:30", settings)]
    .filter((e): e is CashlogEntry => e !== null);
  const query = new Query(source, settings);
  assert.equal(query.getError(), null, `查询不应报错: ${query.getError()}`);

  const container = new FakeElement("div");
  renderChartTable(
    container as unknown as HTMLElement,
    query.apply(entries),
    query,
    parseTableConfig(source),
    fakePlugin(settings, entries),
  );
  const text = collectText(container);
  assert.ok(text.includes("标签"), `应有标签列表头，实际: ${text}`);
  assert.ok(text.includes("时刻"), `应有时刻列表头，实际: ${text}`);
  assert.ok(text.includes("餐饮"), `标签列应渲染标签内容，实际: ${text}`);
  assert.ok(text.includes("12:30"), `时刻列应渲染时间内容，实际: ${text}`);
});

// ------------------------------------------- 滚动位置：refresh() 不应把面板滚回顶部

test("[端到端] refresh() 在设置页刷新后不应把面板滚回顶部（删除/开关后跳动的根因）", () => {
  const plugin = makePanelPlugin();
  const view = new CashlogView({} as never, plugin);

  const container = new FakeElement("div");
  container.addClass("cashlog-panel-content");
  Object.assign(container, { scrollTop: 500, scrollHeight: 1000, clientHeight: 100 });

  (view as unknown as { panelContentEl: FakeElement }).panelContentEl = container;
  (view as unknown as { activeTab: string }).activeTab = "settings";

  // 模拟「保存设置 → render-refresh → refresh()」这条真实链路
  (view as unknown as { refresh: () => void }).refresh();

  assert.equal(
    container.scrollTop,
    500,
    "refresh() 后滚动位置应保持；若跳回 0 说明 refresh 在重建前清空了容器",
  );
});

// ------------------------------------------- 二级子标签（#支出/餐饮/午餐）

test("[二级] 校验：允许两级，拒绝三级", () => {
  assert.equal(validateSubTagName("餐饮").valid, true, "一级应合法");
  assert.equal(validateSubTagName("餐饮/午餐").valid, true, "两级应合法");
  assert.equal(validateSubTagName("a/b/c").valid, false, "三级应被拒绝");
});

test("[二级] 校验：拒绝空段（a//b、/a、a/、单独的 /）", () => {
  for (const bad of ["a//b", "/a", "a/", "/"]) {
    assert.equal(validateSubTagName(bad).valid, false, `${bad} 应判为非法`);
  }
});

test("[二级] 解析：getCategory 返回完整两级路径", () => {
  const e = parse("- #支出/餐饮/午餐 午饭 💴-35 ➕2026-04-25", makeSettings())!;
  assert.equal(e.getCategory("#支出"), "餐饮/午餐", "getCategory 应保留完整二级路径");
});

test("[二级] getTopCategory 折叠到一级", () => {
  const e = parse("- #支出/餐饮/午餐 午饭 💴-35 ➕2026-04-25", makeSettings())!;
  assert.equal(e.getTopCategory("#支出"), "餐饮");
});

test("[二级] getTopCategory 对一级子标签原样返回", () => {
  const e = parse("- #支出/交通 地铁 💴-5 ➕2026-04-25", makeSettings())!;
  assert.equal(e.getTopCategory("#支出"), "交通");
});

test("[二级] group by tag 默认按一级汇总，二级不单独成组", () => {
  const settings = makeSettings();
  const entries = [
    parse("- #支出/餐饮/午餐 午饭 💴-35 ➕2026-04-25", settings),
    parse("- #支出/餐饮/晚餐 晚饭 💴-50 ➕2026-04-25", settings),
    parse("- #支出/交通 地铁 💴-5 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag", settings).apply(entries);
  const keys = result.groups.map((g) => g.key);

  assert.ok(keys.includes("支出/餐饮"), `应出现一级分组，实际: ${keys.join(" | ")}`);
  assert.ok(!keys.includes("支出/餐饮/午餐"), "二级不应单独成组");
  assert.ok(!keys.includes("支出/餐饮/晚餐"), "二级不应单独成组");
});

test("[二级] group by tag level 2 保留完整标签", () => {
  const settings = makeSettings();
  const entries = [
    parse("- #支出/餐饮/午餐 午饭 💴-35 ➕2026-04-25", settings),
    parse("- #支出/餐饮/晚餐 晚饭 💴-50 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag level 2", settings).apply(entries);
  const keys = result.groups.map((g) => g.key);

  assert.ok(keys.includes("支出/餐饮/午餐"), `level 2 应保留完整标签，实际: ${keys.join(" | ")}`);
  assert.ok(keys.includes("支出/餐饮/晚餐"));
});

test("[对照] group by tag 对无子标签的条目保持原样", () => {
  const settings = makeSettings();
  const entries = [parse("- #支出 杂项 💴-9 ➕2026-04-25", settings)]
    .filter((e): e is CashlogEntry => e !== null);
  const result = new Query("group by tag", settings).apply(entries);
  assert.equal(result.groups[0].key, "支出", "一级标签不应被改写（去掉 # 后）");
});

test("[二级] tag includes 用一级名能命中二级条目", () => {
  const settings = makeSettings();
  const entries = [parse("- #支出/餐饮/午餐 午饭 💴-35 ➕2026-04-25", settings)]
    .filter((e): e is CashlogEntry => e !== null);
  const result = new Query("tag includes 餐饮", settings).apply(entries);
  const hit = result.groups.reduce((n, g) => n + g.entries.length, 0);
  assert.equal(hit, 1, "tag includes 餐饮 应命中 #支出/餐饮/午餐");
});

// ------------------------------------------- 静态检查：共享组件必须被 import

test("[静态] 使用 createSection 的文件必须 import 它（踩过的坑：漏 import 导致弹窗空白）", () => {
  assert.ok(SRC_DIR, "未能定位 src 目录");

  // 自带递归：不依赖其它测试内部定义的 walk()
  const listTs = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listTs(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  };

  const files = listTs(SRC_DIR!);
  const offenders: string[] = [];

  for (const file of files) {
    // 定义文件自身不需要 import
    if (file.replace(/\\/g, "/").endsWith("ui/Section.ts")) continue;
    const src = readFileSync(file, "utf8");
    if (!/\bcreateSection\s*\(/.test(src)) continue;
    if (!/import\s*\{[^}]*\bcreateSection\b[^}]*\}\s*from\s*"\.\/ui\/Section"/.test(src)) {
      offenders.push(file.replace(SRC_DIR!, "").replace(/\\/g, "/"));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "以下文件使用了 createSection 却没有从 ./ui/Section import：" + offenders.join(", "),
  );
});

// ------------------------------------------- 标签树（第一批：层状结构）

test("[标签树] legacyToTree 把扁平数组还原成树，并保留层级", () => {
  const tree = legacyToTree(["餐饮", "餐饮/午餐", "交通"]);
  assert.equal(tree.length, 2, "应有两个根节点");
  assert.equal(tree[0].name, "餐饮");
  assert.deepEqual(tree[0].children?.map((c) => c.name), ["午餐"]);
  assert.equal(tree[1].name, "交通");
  assert.equal(tree[1].children, undefined, "无子节点时不应有空数组");
});

test("[标签树] legacyToTree 支持三层并去重", () => {
  const tree = legacyToTree(["a/b/c", "a/b", "a/b/c"]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children?.[0].name, "b");
  assert.equal(tree[0].children?.[0].children?.length, 1, "重复路径应去重");
  assert.equal(tree[0].children?.[0].children?.[0].name, "c");
});

test("[标签树] flattenTree 能还原回扁平路径", () => {
  const flat = flattenTree(legacyToTree(["餐饮", "餐饮/午餐", "交通"]));
  assert.deepEqual(flat, ["餐饮", "餐饮/午餐", "交通"]);
});

test("[标签树] validateTagPath 拒绝空段与空名", () => {
  for (const bad of ["a//b", "/a", "a/", "/", "a/ /b"]) {
    assert.equal(validateTagPath(bad).valid, false, `${bad} 应判为非法`);
  }
  assert.equal(validateTagPath("餐饮/午餐").valid, true);
  assert.equal(validateTagPath("餐饮").valid, true);
});

test("[标签树] pruneEmptyNodes 清掉空名节点与空 children", () => {
  const tree = pruneEmptyNodes([
    { name: "a", children: [{ name: "" }, { name: "b" }] },
    { name: "   " },
    { name: "c", children: [] },
  ]);
  assert.equal(tree.length, 2, "空名节点应被清掉");
  assert.equal(tree[0].name, "a");
  assert.deepEqual(tree[0].children?.map((c) => c.name), ["b"]);
  assert.equal(tree[1].name, "c");
  assert.equal(tree[1].children, undefined, "空 children 应被删除");
});

test("[标签树] addChild / removeNode 增删任意层级", () => {
  const tree = legacyToTree(["餐饮"]);
  assert.equal(addChild(tree, ["餐饮"], "午餐"), true);
  assert.equal(addChild(tree, ["餐饮"], "午餐"), false, "重复添加应返回 false");
  assert.equal(addChild(tree, ["餐饮", "午餐"], "外卖"), true);
  assert.deepEqual(tree[0].children?.[0].children?.map((c) => c.name), ["外卖"]);
  assert.equal(removeNode(tree, ["餐饮", "午餐", "外卖"]), true);
  assert.equal(tree[0].children?.[0].children, undefined, "删空后应清掉 children");
});

test("[标签树] stripCommonPrefix 同场景省略公共前缀", () => {
  const m = stripCommonPrefix(["支出/餐饮", "支出/交通"]);
  assert.equal(m.get("支出/餐饮"), "餐饮");
  assert.equal(m.get("支出/交通"), "交通");
});

test("[标签树] stripCommonPrefix 更深层级省略两级前缀", () => {
  const m = stripCommonPrefix(["支出/餐饮/早餐", "支出/餐饮/晚餐"]);
  assert.equal(m.get("支出/餐饮/早餐"), "早餐");
  assert.equal(m.get("支出/餐饮/晚餐"), "晚餐");
});

test("[标签树] stripCommonPrefix 混排时不省略", () => {
  const m = stripCommonPrefix(["支出/餐饮", "收入/工资"]);
  assert.equal(m.get("支出/餐饮"), "支出/餐饮");
  assert.equal(m.get("收入/工资"), "收入/工资");
});

test("[对照] stripCommonPrefix 至少保留一段，不会压成空标签", () => {
  const m = stripCommonPrefix(["支出", "支出"]);
  assert.equal(m.get("支出"), "支出");
});

test("[标签树] tagToGroupKey 去 # 并保留主标签", () => {
  assert.equal(tagToGroupKey("#支出/餐饮", "#支出", undefined), "支出/餐饮");
  assert.equal(tagToGroupKey("#支出/餐饮/午餐", "#支出", 2), "支出/餐饮/午餐");
});

test("[标签树] tagToGroupKey 按 level 截断子标签深度", () => {
  assert.equal(tagToGroupKey("#支出/餐饮/午餐", "#支出", 1), "支出/餐饮");
  assert.equal(tagToGroupKey("#支出/餐饮/午餐/外卖", "#支出", 2), "支出/餐饮/午餐");
  assert.equal(tagToGroupKey("#地点/学校/食堂", "#地点", 1), "地点/学校");
});

test("[标签树] 端到端：列表分组标题去 # 并省略公共前缀", () => {
  const settings = makeSettings({ showEditButton: false, showNoteLink: false });
  const entries = [
    parse("- #支出/餐饮 午饭 💴-35 ➕2026-04-25", settings),
    parse("- #支出/交通 地铁 💴-5 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const q = new Query("group by tag", settings);
  assert.equal(q.getError(), null);

  const container = new FakeElement("div");
  renderQueryResult(
    container as unknown as HTMLElement,
    q.apply(entries),
    q,
    fakePlugin(settings, entries),
  );

  // 只取分组标题元素：条目自身仍会显示 "#支出/餐饮" 标签，不能用整段文本断言
  const titles: string[] = [];
  (function walk(el: FakeElement): void {
    if (el.cls.some((c) => c.includes("cashlog-group-header"))) titles.push(collectText(el));
    for (const c of el.children) walk(c);
  })(container);

  const joined = titles.join(" | ");
  assert.ok(joined.includes("餐饮"), `分组标题应为「餐饮」，实际: ${joined}`);
  assert.ok(joined.includes("交通"), `分组标题应为「交通」，实际: ${joined}`);
  assert.ok(!joined.includes("#"), `分组标题不应带 #，实际: ${joined}`);
});

test("[对照] 混排时列表分组标题保留完整路径", () => {
  const settings = makeSettings({ showEditButton: false, showNoteLink: false });
  const entries = [
    parse("- #支出/餐饮 午饭 💴-35 ➕2026-04-25", settings),
    parse("- #收入/工资 发薪 💴3000 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const q = new Query("group by tag", settings);
  const container = new FakeElement("div");
  renderQueryResult(
    container as unknown as HTMLElement,
    q.apply(entries),
    q,
    fakePlugin(settings, entries),
  );

  const text = collectText(container);
  assert.ok(text.includes("支出/餐饮"), `混排时应保留「支出/餐饮」，实际: ${text}`);
  assert.ok(text.includes("收入/工资"), `混排时应保留「收入/工资」，实际: ${text}`);
});

// ------------------------------------------- 多标签：编辑不丢数据（第一批核心）

test("[标签] 编辑多标签条目时，附加标签必须原样保留", () => {
  const settings = makeSettings();
  const line = "- #支出/餐饮 午饭 #地点/食堂 #必要性/必要 💴-35 ➕2026-04-25";
  const entry = parse(line, settings);
  assert.ok(entry, "条目应能解析");
  assert.deepEqual(
    entry!.tags,
    ["#支出/餐饮", "#地点/食堂", "#必要性/必要"],
    "解析层应保留全部三个标签",
  );

  // 模拟打开编辑弹窗
  const data = createDefaultData(settings, entry!);
  assert.deepEqual(
    data.extraTags,
    ["#地点/食堂", "#必要性/必要"],
    "副标签应被识别为附加标签",
  );

  // 模拟保存（金额不变，只走一遍构建）
  const built = buildEntryFromModalData(data, fakePlugin(settings, [entry!]), {
    indentation: "",
    listMarker: "-",
    location: null,
  });

  assert.deepEqual(
    built.tags,
    ["#支出/餐饮", "#地点/食堂", "#必要性/必要"],
    "保存后三个标签都应还在（修复前只剩主标签）",
  );
});

test("[标签] 编辑时修改金额，附加标签仍然保留", () => {
  const settings = makeSettings();
  const entry = parse("- #支出/餐饮 午饭 #地点/食堂 💴-35 ➕2026-04-25", settings)!;
  const data = createDefaultData(settings, entry);

  // 改金额
  data.accounts = [{ account: "", amount: "50" }];

  const built = buildEntryFromModalData(data, fakePlugin(settings, [entry]), {
    indentation: "",
    listMarker: "-",
    location: null,
  });

  assert.ok(built.tags.includes("#地点/食堂"), "改金额不应丢副标签");
});

test("[对照] 无副标签的条目编辑后标签数量不变", () => {
  const settings = makeSettings();
  const entry = parse("- #支出/餐饮 午饭 💴-35 ➕2026-04-25", settings)!;
  const data = createDefaultData(settings, entry);
  assert.deepEqual(data.extraTags, [], "没有副标签时应为空数组");

  const built = buildEntryFromModalData(data, fakePlugin(settings, [entry]), {
    indentation: "",
    listMarker: "-",
    location: null,
  });
  assert.deepEqual(built.tags, ["#支出/餐饮"]);
});

test("[标签] 转账条目的附加标签也应保留", () => {
  const settings = makeSettings({ enableAccounts: true });
  const entry = parse("- #转账 #地点/银行 💳微信💴-100 💳支付宝💴100 ➕2026-04-25", settings)!;
  const data = createDefaultData(settings, entry);
  assert.deepEqual(data.extraTags, ["#地点/银行"], "转账的副标签应被保留");
});

// ------------------------------------------- group by tag <路径>

test("[标签] group by tag 餐饮：只统计餐饮子树，按下一级分组", () => {
  const settings = makeSettings();
  const entries = [
    parse("- #支出/餐饮/午餐 午饭 💴-35 ➕2026-04-25", settings),
    parse("- #支出/餐饮/晚餐 晚饭 💴-50 ➕2026-04-25", settings),
    parse("- #支出/交通/地铁 通勤 💴-5 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag 餐饮", settings).apply(entries);
  const keys = result.groups.map((g) => g.key);

  assert.ok(keys.includes("支出/餐饮/午餐"), `应包含午餐组，实际: ${keys.join(" | ")}`);
  assert.ok(keys.includes("支出/餐饮/晚餐"), "应包含晚餐组");
  assert.ok(!keys.some((k) => k.includes("交通")), "交通支不应出现（已被路径收窄）");
});

test("[标签] group by tag 地点/学校：能按副标签分组", () => {
  const settings = makeSettings();
  const entries = [
    parse("- #支出/餐饮 午饭 #地点/学校/食堂 💴-35 ➕2026-04-25", settings),
    parse("- #支出/餐饮 晚饭 #地点/学校/超市 💴-20 ➕2026-04-25", settings),
    parse("- #支出/餐饮 家里吃 #地点/家 💴-10 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag 地点/学校", settings).apply(entries);
  const keys = result.groups.map((g) => g.key);

  assert.ok(keys.includes("地点/学校/食堂"), `应包含食堂组，实际: ${keys.join(" | ")}`);
  assert.ok(keys.includes("地点/学校/超市"), "应包含超市组");
  assert.ok(!keys.some((k) => k.includes("家")), "非学校地点不应出现");
});

test("[标签] group by tag 餐饮 level 2：下钻两级", () => {
  const settings = makeSettings();
  const entries = [
    parse("- #支出/餐饮/午餐/外卖 外卖 💴-30 ➕2026-04-25", settings),
    parse("- #支出/餐饮/午餐/食堂 食堂 💴-15 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag 餐饮 level 2", settings).apply(entries);
  const keys = result.groups.map((g) => g.key);

  assert.ok(keys.includes("支出/餐饮/午餐/外卖"), `应到第三层，实际: ${keys.join(" | ")}`);
  assert.ok(keys.includes("支出/餐饮/午餐/食堂"));
});

test("[对照] group by tag 不带路径时仍是全局一级", () => {
  const settings = makeSettings();
  const entries = [
    parse("- #支出/餐饮/午餐 午饭 💴-35 ➕2026-04-25", settings),
    parse("- #支出/交通/地铁 通勤 💴-5 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag", settings).apply(entries);
  const keys = result.groups.map((g) => g.key);
  assert.deepEqual(keys.sort(), ["支出/交通", "支出/餐饮"], "全局一级（去 #，按 sort 顺序）");
});

test("[标签] group by tag level 3 支持任意深度", () => {
  const settings = makeSettings();
  const entries = [
    parse("- #支出/餐饮/午餐/外卖/工作日 外卖 💴-30 ➕2026-04-25", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag level 3", settings).apply(entries);
  assert.equal(result.groups[0].key, "支出/餐饮/午餐/外卖");
});

test("[标签] group by tag <路径> 时，无该标签的记录不应落进「全部」组", () => {
  const settings = makeSettings();
  const entries = [
    // 这条只有 #支出，没有餐饮
    parse("- #支出 122112 💴-121 ➕2026-11-23", settings),
    parse("- #支出/餐饮/午餐 午饭 💴-40 ➕2026-11-24", settings),
  ].filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag 餐饮", settings).apply(entries);
  const keys = result.groups.map((g) => g.key);
  const total = result.groups.reduce((n, g) => n + g.entries.length, 0);

  assert.ok(!keys.includes("全部"), `不应出现「全部」组，实际: ${keys.join(" | ")}`);
  assert.equal(total, 1, "只有带餐饮标签的那条应被计入");
});

test("[标签] 指定的路径一条都匹配不上时，结果为空而不是「全部」", () => {
  const settings = makeSettings();
  const entries = [parse("- #支出 杂项 💴-9 ➕2026-11-23", settings)]
    .filter((e): e is CashlogEntry => e !== null);

  const result = new Query("group by tag 餐饮", settings).apply(entries);
  assert.equal(result.groups.length, 0, "没有匹配项时不应产生任何分组");
});
﻿

// ===== 标签树弹窗（TagTreeModal）：真实渲染 + 真实点击 =====
// 这组用例把弹窗真正渲染出来并派发点击，能抓住「点了没反应」这类
// 只有交互路径才暴露的缺陷；桩里 blur 会触发重建，因此也用来检查
// 「点击目标是否在点击到达前就被销毁」。

function treeContent(modal: TagTreeModal): FakeElement {
  return modal.contentEl as unknown as FakeElement;
}

function treeRowOf(li: FakeElement): FakeElement {
  return li.children.find((c) => c.hasClass("cashlog-tag-tree-row"))!;
}

function treeNameOf(li: FakeElement): string {
  return (
    treeRowOf(li)
      .querySelectorAll("span")
      .find((s) => s.hasClass("cashlog-tag-tree-name"))
      ?.own.join("") ?? ""
  );
}

function treeButton(li: FakeElement, icon: string): FakeElement {
  const btn = treeRowOf(li)
    .querySelectorAll("span")
    .find((s) => s.attrs["data-icon"] === icon);
  assert.ok(btn, `节点「${treeNameOf(li)}」应渲染 ${icon} 按钮`);
  return btn!;
}

// 顶层标签 = 第一个 ul 的直接子 li（嵌套子标签在更深的 ul 里）
function treeTopItems(modal: TagTreeModal): FakeElement[] {
  const ul = treeContent(modal).querySelectorAll("ul")[0];
  return ul.children.filter((c) => c.tag === "li");
}

function openTagTree(nodes: TagNode[]): TagTreeModal {
  const modal = new TagTreeModal({} as never, [{ key: "expense", title: "支出", nodes }], () => {});
  modal.open();
  return modal;
}

function isInside(el: FakeElement, ancestor: FakeElement): boolean {
  let cur: FakeElement | null = el;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

test("[标签树] 改名输入框应覆盖在标签名字的位置，而不是排到子标签之后", () => {
  const modal = openTagTree([{ name: "餐饮", children: [{ name: "午餐" }] }]);
  const canteen = treeTopItems(modal).find((li) => treeNameOf(li) === "餐饮")!;
  treeButton(canteen, "pencil").dispatch("click", {});

  const li = treeTopItems(modal)[0];
  const editor = treeContent(modal).querySelectorAll(".cashlog-tag-tree-row-editing")[0];
  assert.ok(editor, "点改名后应出现输入框");

  // 「覆盖在名字之上」= 输入框就在名字那一行里。
  // 现状是追加到 li 末尾，有子标签时会排到子列表之后，用户看到的是「底下多一行」。
  assert.equal(
    editor.parent,
    treeRowOf(li),
    "改名输入框应位于标签名字所在的行内，而不是排到子标签列表之后",
  );
});

test("[标签树] 每个分类最后一项母标签也能添加子标签", () => {
  const modal = openTagTree([{ name: "餐饮" }, { name: "交通" }, { name: "购物" }]);

  const items = treeTopItems(modal);
  assert.equal(treeNameOf(items[items.length - 1]), "购物", "最后一项应是购物");

  treeButton(items[items.length - 1], "plus").dispatch("click", {});

  const editor = treeContent(modal).querySelectorAll(".cashlog-tag-tree-row-editing")[0];
  assert.ok(editor, "点最后一项的 + 应出现子标签输入框");

  const top = treeTopItems(modal);
  assert.ok(isInside(editor, top[top.length - 1]), "输入行应挂在该节点之下");
});
