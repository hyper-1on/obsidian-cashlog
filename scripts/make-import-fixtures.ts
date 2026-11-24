// 导入功能 · 生成脱敏 fixture（开发期）
//
// 从真实导出文件抽取样本，替换掉所有可识别信息，留下结构与金额，
// 用于回归测试中对账。金额刻意保留：文件头的汇总行要和明细对得上，
// 改了金额这条验证就失效了。
//
// 脱敏范围：姓名 / 昵称 / 账号 / 商户名 / 对方名 / 流水号 / 订单号 / 具体时间
// 保留：金额、余额、列结构、文件头汇总的数字
//
// 用法（素材不在仓库里，需要自己指路径）：
//   $env:NODE_PATH = '<你的 devdeps>/node_modules'
//   $env:IMPORT_SRC_DIR = '<存放真实账单的目录>'
//   npx jiti scripts/make-import-fixtures.ts

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeImportText } from "../src/Import/encoding";
import { parseCsv } from "../src/Import/csv";
import { excelSerialToTime } from "../src/Import/values";

const OUT_DIR = join(process.cwd(), "tests", "fixtures", "import");

/** 素材目录；未设置时直接报错，避免把本机路径写进仓库。 */
function sourceDir(): string {
  const dir = process.env.IMPORT_SRC_DIR;
  if (!dir) {
    throw new Error(
      "请设置环境变量 IMPORT_SRC_DIR 指向存放真实账单的目录（脚本只读取，不修改原文件）",
    );
  }
  return dir;
}

/** 在素材目录里按关键字找文件。 */
function findSource(keyword: string): string {
  const dir = sourceDir();
  const hit = readdirSync(dir).find((f) => f.includes(keyword));
  if (!hit) throw new Error(`素材目录里找不到名称含「${keyword}」的文件: ${dir}`);
  return join(dir, hit);
}

type SheetJs = {
  read: (data: Buffer, opts: Record<string, unknown>) => {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: { sheet_to_json: (ws: unknown, opts: Record<string, unknown>) => unknown[][] };
};

function loadXlsx(): SheetJs | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("xlsx") as SheetJs;
  } catch {
    return null;
  }
}

/** 把任意字符串里的 11 位手机号、长串数字替换成占位符。 */
function scrubText(text: string): string {
  return text
    .replace(/\b\d{11}\b/g, "00000000000")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "example@example.com");
}

/** 生成递增的假时间，保留「绝大多数格式」但去掉真实时间信息。 */
function fakeTime(index: number): string {
  const day = String((index % 28) + 1).padStart(2, "0");
  const hour = String(index % 24).padStart(2, "0");
  const minute = String((index * 7) % 60).padStart(2, "0");
  return `2026-01-${day} ${hour}:${minute}:00`;
}

function serializeCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
}

// ---------- 支付宝分列式 ----------

function makeAlipayFixture(): void {
  const src = findSource("ACCLOG");
  const bytes = readFileSync(src);
  const { text } = decodeImportText(bytes);
  const rows = parseCsv(text);

  const headerRow = rows.findIndex((r) => r.map((c) => c.trim()).includes("流水号"));
  if (headerRow < 0) throw new Error("未找到支付宝表头");

  const header = rows[headerRow].map((c) => c.trim());
  const iSerial = header.indexOf("流水号");
  const iTime = header.indexOf("时间");
  const iName = header.indexOf("名称");
  const iNote = header.indexOf("备注");

  let recordNo = 0;
  const out: string[][] = [];

  // 表头之前的说明行：保留结构，抹掉账号
  for (let r = 0; r < headerRow; r++) {
    out.push([scrubText(rows[r].join(","))]);
  }
  out.push(header);

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = [...rows[r]];
    if (row.every((c) => String(c ?? "").trim() === "")) {
      out.push(row);
      continue;
    }
    if (String(row[0] ?? "").trim().startsWith("#")) {
      out.push(row.map((c) => scrubText(String(c ?? ""))));
      continue;
    }

    recordNo++;
    if (iSerial >= 0) row[iSerial] = `SAMPLE${String(recordNo).padStart(6, "0")}`;
    if (iTime >= 0) row[iTime] = fakeTime(recordNo);
    if (iName >= 0) row[iName] = `示例对方${((recordNo - 1) % 5) + 1}`;
    if (iNote >= 0) row[iNote] = "";
    out.push(row.map((c) => scrubText(String(c ?? ""))));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "alipay-ledger.csv"), serializeCsv(out), "utf8");
  console.log(`alipay-ledger.csv  ${recordNo} 条记录`);
}

// ---------- 微信个人账单 ----------

function makeWechatFixture(): void {
  const src = findSource("微信支付账单流水文件");
  const XLSX = loadXlsx();
  if (!XLSX) throw new Error("未安装 xlsx，无法读取微信样本");

  const wb = XLSX.read(readFileSync(src), { type: "buffer" });
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    raw: true,
    defval: "",
  }) as unknown[][];

  const rows = raw.map((row) =>
    row.map((v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "number" && v > 20000 && v < 60000) return excelSerialToTime(v) ?? String(v);
      return String(v);
    }),
  );

  const headerRow = rows.findIndex((r) => r.map((c) => c.trim()).includes("交易时间"));
  if (headerRow < 0) throw new Error("未找到微信表头");

  const header = rows[headerRow].map((c) => c.trim());
  const iTime = header.indexOf("交易时间");
  const iType = header.indexOf("交易类型");
  const iParty = header.indexOf("交易对方");
  const iProduct = header.indexOf("商品");
  const iOrder = header.indexOf("交易单号");
  const iMerchantOrder = header.indexOf("商户单号");

  let recordNo = 0;
  const out: string[][] = [];

  for (let r = 0; r < headerRow; r++) {
    out.push([scrubText(rows[r].join(" ").trim()).replace(/\[.*?\]/g, "[示例用户]")]);
  }
  out.push(header);

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = [...rows[r]];
    if (row.every((c) => String(c ?? "").trim() === "")) {
      out.push(row);
      continue;
    }

    recordNo++;
    if (iTime >= 0) row[iTime] = fakeTime(recordNo);
    // 交易类型里可能带商户名（如「肯德基-退款」），一并脱敏
    if (iType >= 0) row[iType] = `示例类型${((recordNo - 1) % 4) + 1}`;
    if (iParty >= 0) row[iParty] = `示例对方${((recordNo - 1) % 5) + 1}`;
    if (iProduct >= 0) row[iProduct] = `示例商品${((recordNo - 1) % 3) + 1}`;
    if (iOrder >= 0) row[iOrder] = `SAMPLEORDER${String(recordNo).padStart(6, "0")}`;
    if (iMerchantOrder >= 0) row[iMerchantOrder] = `SAMPLEMERCHANT${String(recordNo).padStart(6, "0")}`;
    out.push(row.map((c) => scrubText(String(c ?? ""))));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "wechat-personal.csv"), serializeCsv(out), "utf8");
  console.log(`wechat-personal.csv  ${recordNo} 条记录`);
}

makeAlipayFixture();
makeWechatFixture();
console.log("完成 →", OUT_DIR);
