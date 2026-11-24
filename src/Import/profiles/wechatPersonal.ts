// 导入功能 · 微信个人账单
//
// 文件可能是 CSV（UTF-8 BOM）或 xlsx，表头固定 11 列：
//   交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
//
// 「收/支」列的 `/` 表示中性交易。微信自己的说明是：
//   「充值/提现/理财通购买/零钱通存取/信用卡还款等交易，将计入中性交易」
// 这些既可能是转账，也可能是支出或收入，平台没有进一步区分，
// 所以归一化成 undetermined，由用户在清单里指定，不替用户猜。

import type { ImportProfile, ImportRecord, ImportSkip, DeclaredSummary } from "../types";
import { cell, columnIndex } from "../header";
import { excelSerialToTime, normalizeTradeTime, parseMoney, roundMoney } from "../values";

const SIGNATURE = ["交易时间", "交易类型", "交易对方", "金额(元)"];

const DIRECTION_MAP: Record<string, ImportRecord["direction"] | undefined> = {
  收入: "income",
  支出: "expense",
  "/": "undetermined",
};

export const wechatPersonalProfile: ImportProfile = {
  source: "wechat_personal",
  label: "微信支付 · 个人账单",
  headerSignature: SIGNATURE,
  hasBalance: false,

  extract(rows, header, headerRow) {
    const iTime = columnIndex(header, "交易时间");
    const iType = columnIndex(header, "交易类型");
    const iParty = columnIndex(header, "交易对方");
    const iProduct = columnIndex(header, "商品");
    const iDir = columnIndex(header, "收/支");
    const iAmount = columnIndex(header, "金额(元)");
    const iPay = columnIndex(header, "支付方式");
    const iStatus = columnIndex(header, "当前状态");
    const iOrder = columnIndex(header, "交易单号");
    const iMerchantOrder = columnIndex(header, "商户单号");
    const iNote = columnIndex(header, "备注");

    const records: ImportRecord[] = [];
    const skipped: ImportSkip[] = [];

    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.every((c) => String(c ?? "").trim() === "")) continue;

      const rawTime = cell(row, iTime);
      // xlsx 的 raw 模式给的是 Excel 序列号；CSV 给的是文本
      const tradeTime =
        /^\d+(\.\d+)?$/.test(rawTime) && Number(rawTime) > 20000
          ? excelSerialToTime(Number(rawTime))
          : normalizeTradeTime(rawTime);

      const rawDir = cell(row, iDir);
      const direction = DIRECTION_MAP[rawDir];
      const amount = parseMoney(cell(row, iAmount));

      if (tradeTime === null) {
        skipped.push({ rowIndex: r + 1, reason: "时间无法解析", raw: row.join(" | ").slice(0, 120) });
        continue;
      }
      if (!direction) {
        skipped.push({
          rowIndex: r + 1,
          reason: `未知的收/支值「${rawDir}」`,
          raw: row.join(" | ").slice(0, 120),
        });
        continue;
      }
      if (amount === null) {
        skipped.push({ rowIndex: r + 1, reason: "金额无法解析", raw: row.join(" | ").slice(0, 120) });
        continue;
      }

      const raw: Record<string, string> = {};
      header.forEach((name, idx) => {
        if (name) raw[name] = String(row[idx] ?? "").trim();
      });

      records.push({
        source: "wechat_personal",
        rowIndex: r + 1,
        tradeTime,
        direction,
        amount: roundMoney(Math.abs(amount)),
        currency: "CNY",
        balance: null,
        counterparty: cell(row, iParty) || null,
        category: cell(row, iType) || null,
        payMethod: cell(row, iPay) || null,
        status: cell(row, iStatus) || null,
        orderNo: cell(row, iOrder) || null,
        merchantOrderNo: cell(row, iMerchantOrder) || null,
        product: cell(row, iProduct) || null,
        note: cell(row, iNote) || null,
        raw,
      });
    }

    return { records, skipped };
  },

  parseDeclared(texts) {
    // 前 20 行里有一组汇总：
    //   共150笔记录
    //   收入：46笔 3362.20元
    //   支出：103笔 3192.52元
    //   中性交易：1笔 1000.00元
    const head = texts.join("\n");

    const totalMatch = head.match(/共(\d+)笔记录/);
    const grab = (label: string): { count: number; sum: number } | null => {
      const m = head.match(new RegExp(`${label}[：:]\\s*(\\d+)笔\\s*([\\d.]+)元`));
      return m ? { count: Number(m[1]), sum: Number(m[2]) } : null;
    };

    const income = grab("收入");
    const expense = grab("支出");
    // 微信的叫法是「中性交易」，模板文档里写成「不计收支」（那是支付宝的说法）
    const transfer = grab("中性交易") ?? grab("不计收支");

    if (totalMatch === null && !income && !expense && !transfer) return null;

    const summary: DeclaredSummary = {
      totalCount: totalMatch ? Number(totalMatch[1]) : null,
      income,
      expense,
      transfer,
    };
    return summary;
  },
};
