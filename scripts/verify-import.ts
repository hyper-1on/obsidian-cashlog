// 导入功能 · 验证脚本（开发期）
//
// 用真实导出文件跑一遍核心解析链路，并与文件头自带的汇总对账。
// 这里的解析逻辑全部来自 src/Import/，和插件运行时是同一份代码。
//
// 用法：
//   npx jiti scripts/verify-import.ts <文件...>
//
// xlsx 需要 SheetJS（装在仓库外的 devdeps 里）：
//   $env:NODE_PATH = 'D:\CSlearning\cashlog-update\devdeps\node_modules'

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { decodeImportText } from "../src/Import/encoding";
import { parseCsv } from "../src/Import/csv";
import { parseImportRows } from "../src/Import/index";
import { reconcile, summarize } from "../src/Import/reconcile";
import { excelSerialToTime } from "../src/Import/values";
import type { ImportParseResult } from "../src/Import/types";

type SheetJs = {
  read: (data: Buffer, opts: Record<string, unknown>) => {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json: (ws: unknown, opts: Record<string, unknown>) => unknown[][];
  };
};

function loadXlsx(): SheetJs | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("xlsx") as SheetJs;
  } catch {
    return null;
  }
}

/** 把 xlsx 工作表的首行转成二维字符串数组，日期序列号统一成时间字符串。 */
function xlsxToRows(bytes: Buffer): { rows: string[][]; sheetName: string } | null {
  const XLSX = loadXlsx();
  if (!XLSX) return null;

  const wb = XLSX.read(bytes, { type: "buffer", cellDates: false, cellText: false });
  const sheetName = wb.SheetNames[0];
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: "",
  }) as unknown[][];

  const rows = raw.map((row) =>
    row.map((cellVal) => {
      if (cellVal === null || cellVal === undefined) return "";
      if (cellVal instanceof Date) {
        return cellVal.toISOString().slice(0, 19);
      }
      if (typeof cellVal === "number" && cellVal > 20000 && cellVal < 60000) {
        // 疑似 Excel 日期序列号
        return excelSerialToTime(cellVal) ?? String(cellVal);
      }
      return String(cellVal);
    }),
  );

  return { rows, sheetName };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width);
}

function printResult(result: ImportParseResult, extra: string): void {
  const s = summarize(result.records);

  console.log("");
  console.log(`  来源识别    ${result.source ?? "未识别"}`);
  console.log(`  表头行号    ${result.headerRow ?? "-"}`);
  console.log(`  表头列数    ${result.header.length}`);
  if (result.header.length > 0) {
    console.log(`  列名        ${result.header.join(" | ")}`);
  }
  if (extra) console.log(`  ${extra}`);

  console.log("");
  console.log("  ---------------- 解析结果 ----------------");
  console.log(`  记录数      ${s.total}   跳过 ${result.skipped.length}`);
  console.log(`  收入        ${pad(s.income.count, 4)} 笔   ${s.income.sum}`);
  console.log(`  支出        ${pad(s.expense.count, 4)} 笔   ${s.expense.sum}`);
  if (s.undetermined.count > 0 || s.transfer.count > 0) {
    console.log(
      `  未定        ${pad(s.undetermined.count + s.transfer.count, 4)} 笔   ${s.undetermined.sum + s.transfer.sum}   （中性交易 / 不计收支，需人工指定方向）`,
    );
  }

  if (result.declared) {
    const rec = reconcile(result.records, result.declared);
    console.log("");
    console.log("  ---------------- 与文件头对账 ----------------");
    for (const item of rec.items) {
      const mark = item.ok === null ? " --  " : item.ok ? " OK  " : " FAIL";
      const declared = item.declared === null ? "(未声明)" : String(item.declared);
      console.log(`  ${mark} ${item.label.padEnd(8)} 解析 ${String(item.actual).padEnd(10)} 声明 ${declared}`);
    }
    console.log("");
    console.log(`  结论        ${rec.failed ? "存在不一致，需检查" : "全部对账通过"}`);
  } else {
    console.log("");
    console.log("  结论        文件头没有汇总声明，无法自动对账");
  }

  if (result.skipped.length > 0) {
    console.log("");
    console.log("  ---------------- 被跳过的行 ----------------");
    for (const skip of result.skipped.slice(0, 8)) {
      console.log(`  R${skip.rowIndex}  ${skip.reason}`);
      console.log(`        ${skip.raw}`);
    }
  }

  const sample = result.records.slice(0, 5);
  if (sample.length > 0) {
    console.log("");
    console.log("  ---------------- 抽样（前 5 条）----------------");
    for (const r of sample) {
      const amount = String(r.amount).padStart(8);
      const party = (r.counterparty ?? "-").slice(0, 14);
      const product = (r.product ?? r.note ?? "").slice(0, 20);
      console.log(`  R${r.rowIndex} ${r.tradeTime}  ${r.direction.padEnd(12)} ${amount}  ${party} | ${product}`);
    }
  }
}

function verifyFile(path: string): void {
  console.log("=".repeat(72));
  console.log(`文件: ${basename(path)}`);

  const bytes = readFileSync(path);
  const ext = extname(path).toLowerCase();

  if (ext === ".xlsx" || ext === ".xls") {
    const parsed = xlsxToRows(bytes);
    if (!parsed) {
      console.log("  !! 未安装 xlsx 库，无法读取该文件");
      console.log("     把 NODE_PATH 指向 devdeps/node_modules 后重试");
      return;
    }
    console.log(`  xlsx 工作表 ${parsed.sheetName}，共 ${parsed.rows.length} 行`);
    printResult(parseImportRows(parsed.rows), "");
    return;
  }

  const { text, encoding } = decodeImportText(bytes);
  const rows = parseCsv(text);
  console.log(`  编码 ${encoding}，字节 ${bytes.length}，共 ${rows.length} 行`);
  printResult(parseImportRows(rows), "");
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("用法: npx jiti scripts/verify-import.ts <文件...>");
  process.exit(1);
}

for (const file of files) {
  try {
    verifyFile(file);
  } catch (e) {
    console.log(`  !! 处理失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log("");
console.log("=".repeat(72));
