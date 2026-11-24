// 导入功能 · 支付宝「收支明细」（分列式）
//
// 这是实际导出里最常见的支付宝格式，但现有模板文档没有收录：
//   #支付宝收支明细
//   #自[2025-11-24 00:00:00]至[2026-11-24 12:14:58]
//   #成功总金额：[3010.61]成功总笔数：[36]
//   ...
//   流水号,时间,名称,备注,收入,支出,账户余额（元）,资金渠道
//
// 与「电子回单」的关键差异：
// - 没有「收/支」列，收入与支出分两列，支出列是负数
// - 有账户余额，可逐行勾稽
// - 流水号带尾随 tab

import type { ImportProfile, ImportRecord, ImportSkip, DeclaredSummary } from "../types";
import { cell, columnIndex } from "../header";
import { normalizeTradeTime, parseMoney, roundMoney } from "../values";

const SIGNATURE = ["流水号", "时间", "名称", "收入", "支出"];

export const alipayLedgerProfile: ImportProfile = {
  source: "alipay_ledger",
  label: "支付宝 · 收支明细",
  headerSignature: SIGNATURE,
  hasBalance: true,

  extract(rows, header, headerRow) {
    const iSerial = columnIndex(header, "流水号");
    const iTime = columnIndex(header, "时间");
    const iName = columnIndex(header, "名称");
    const iNote = columnIndex(header, "备注");
    const iIncome = columnIndex(header, "收入");
    const iExpense = columnIndex(header, "支出");
    const iBalance = columnIndex(header, "账户余额（元）");
    const iChannel = columnIndex(header, "资金渠道");

    const records: ImportRecord[] = [];
    const skipped: ImportSkip[] = [];

    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.every((c) => String(c ?? "").trim() === "")) continue;

      // 文件尾还有一条 --------收支明细列表-------- 的分隔线
      if (cell(row, 0).startsWith("#")) continue;

      const tradeTime = normalizeTradeTime(cell(row, iTime));
      const income = parseMoney(cell(row, iIncome));
      const expense = parseMoney(cell(row, iExpense));

      if (tradeTime === null) {
        skipped.push({ rowIndex: r + 1, reason: "时间无法解析", raw: row.join(" | ").slice(0, 120) });
        continue;
      }

      // 按「列有没有值」判断，而不是「金额是否为 0」：
      // 「账户开户」一行收入列是 0.00，文件头的收入笔数把它算进去了。
      let direction: ImportRecord["direction"];
      let amount: number;
      if (income !== null) {
        direction = "income";
        amount = Math.abs(income);
      } else if (expense !== null) {
        direction = "expense";
        amount = Math.abs(expense);
      } else {
        skipped.push({
          rowIndex: r + 1,
          reason: "收入与支出列都没有值",
          raw: row.join(" | ").slice(0, 120),
        });
        continue;
      }

      const raw: Record<string, string> = {};
      header.forEach((name, idx) => {
        if (name) raw[name] = String(row[idx] ?? "").trim();
      });

      records.push({
        source: "alipay_ledger",
        rowIndex: r + 1,
        tradeTime,
        direction,
        amount: roundMoney(amount),
        currency: "CNY",
        balance: parseMoney(cell(row, iBalance)),
        counterparty: cell(row, iName) || null,
        category: null,
        payMethod: cell(row, iChannel) || null,
        status: null,
        orderNo: cell(row, iSerial) || null,
        merchantOrderNo: null,
        product: null,
        note: cell(row, iNote) || null,
        raw,
      });
    }

    return { records, skipped };
  },

  parseDeclared(texts) {
    // 文件头是若干 ------------ 包裹的段落，合并后按标签抓
    const head = texts.join("\n");
    const grabCount = (label: string): number | null => {
      const m = head.match(new RegExp(`${label}[：:]\\s*\\[?(\\d+)\\]?`));
      return m ? Number(m[1]) : null;
    };
    const grabSum = (label: string): number | null => {
      const m = head.match(new RegExp(`${label}[：:]\\s*\\[?([\\d.]+)\\]?`));
      return m ? Number(m[1]) : null;
    };

    const totalCount = grabCount("成功总笔数");
    const incomeCount = grabCount("收入笔数");
    const expenseCount = grabCount("支出笔数");
    const incomeSum = grabSum("收入金额");
    const expenseSum = grabSum("支出金额");

    if (
      totalCount === null &&
      incomeCount === null &&
      expenseCount === null &&
      incomeSum === null &&
      expenseSum === null
    ) {
      return null;
    }

    const summary: DeclaredSummary = { totalCount };
    if (incomeCount !== null && incomeSum !== null) {
      summary.income = { count: incomeCount, sum: incomeSum };
    }
    if (expenseCount !== null && expenseSum !== null) {
      summary.expense = { count: expenseCount, sum: expenseSum };
    }
    return summary;
  },
};
