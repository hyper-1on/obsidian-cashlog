// 导入功能 · 从 vault 读取账单文件
//
// CSV 与 xlsx 两条路都收敛成「二维字符串数组」，交给 src/Import/ 的纯函数解析。
// 这一层是唯一接触 Obsidian 文件 API 与 SheetJS 的地方，
// 核心解析逻辑因此仍然可以在 node 下用脚本验证。

import { App, TFile } from "obsidian";
import * as XLSX from "xlsx";
import { decodeImportText } from "./encoding";
import { parseCsv } from "./csv";
import { excelSerialToTime } from "./values";

export interface ReadStatementResult {
  rows: string[][];
  /** 实际用的解码方式；xlsx 时为 "XLSX" */
  encoding: string;
  /** xlsx 的工作表名 */
  sheetName?: string;
  /** 行数，用于摘要展示 */
  rowCount: number;
}

/** 该扩展名是否受支持。 */
export function isStatementFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".csv") || lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

/**
 * 读取并转成二维字符串数组。
 *
 * - CSV：按 BOM → UTF-8 → GB18030 的顺序解码
 * - xlsx：交给 SheetJS，日期序列号单独换算
 *
 * 任何一步失败都抛出带可读原因的异常，由调用方展示给用户；
 * 不返回半个结果，避免「看起来导入成功、其实少了一半数据」。
 */
export async function readStatementFile(app: App, file: TFile): Promise<ReadStatementResult> {
  const buffer = await app.vault.readBinary(file);
  const bytes = new Uint8Array(buffer);
  const name = file.path.toLowerCase();

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return readXlsx(bytes);
  }
  return readCsv(bytes);
}

function readCsv(bytes: Uint8Array): ReadStatementResult {
  const { text, encoding } = decodeImportText(bytes);
  const rows = parseCsv(text);
  return { rows, encoding, rowCount: rows.length };
}

function readXlsx(bytes: Uint8Array): ReadStatementResult {
  const wb = XLSX.read(bytes, { type: "array", cellDates: false, cellText: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("工作簿里没有工作表");

  const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: "",
  }) as unknown[][];

  const rows = raw.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return "";
      if (typeof cell === "string") return cell;
      if (typeof cell === "number") {
        // 20000–60000 之间的整数区间对应 1954–2064 年，几乎一定是日期序列号
        if (cell > 20000 && cell < 60000) return excelSerialToTime(cell) ?? String(cell);
        return String(cell);
      }
      if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
      return String(cell);
    }),
  );

  return { rows, encoding: "XLSX", sheetName, rowCount: rows.length };
}
