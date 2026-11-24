// 导入功能 · 统一结构
//
// 目标：把微信 / 支付宝 / 银行导出的流水，归一化成同一种形状，
// 后续的清单、去重、写笔记都只认这个结构。
//
// 设计取舍：
// - 金额一律「绝对值」，方向由 direction 单独表达。
//   流水里的正负号各平台含义不一（支付宝分列式的支出列是负数），
//   混在金额里会导致重复计数。
// - direction 允许 "undetermined"。
//   微信的「中性交易」、支付宝的「不计收支」都可能是转账 / 支出 / 收入，
//   平台没有给出确定的语义，所以这里不替用户做决定。
// - 原始行保留在 raw 里，映射错了还能人工核对。

/** 流水来源。新增格式时同步扩充这里与 header.ts 的识别规则。 */
export type ImportSource =
  | "alipay_ledger" // 支付宝 App「收支明细」：收入/支出分列 + 余额
  | "alipay_app" // 支付宝 App「电子客户回单」
  | "alipay_web" // 支付宝网页端明细
  | "wechat_personal" // 微信个人账单
  | "wechat_merchant_trade" // 微信商户交易账单
  | "wechat_merchant_fund" // 微信商户资金账单
  | "alipay_merchant" // 支付宝商户账单
  | "bank" // 银行流水
  | "generic"; // 时间 / 金额 / 备注 三列

/**
 * 资金方向。
 * undetermined = 平台没有明确语义（中性交易 / 不计收支），需要用户在清单里指定。
 */
export type ImportDirection = "income" | "expense" | "transfer" | "undetermined";

/** 一行流水的归一化结果。 */
export interface ImportRecord {
  /** 来源格式 */
  source: ImportSource;
  /** 在原文件中的行号（1 起，便于回溯） */
  rowIndex: number;
  /** 交易时间 YYYY-MM-DDTHH:mm:ss；只有日期时补 T00:00:00 */
  tradeTime: string;
  /** 方向；undetermined 表示需要用户确认 */
  direction: ImportDirection;
  /** 金额绝对值（元），保留两位小数 */
  amount: number;
  /** 货币；默认 CNY */
  currency: string;
  /** 交易后余额，没有则为 null */
  balance: number | null;
  /** 交易对方 / 商户名 */
  counterparty: string | null;
  /** 平台分类，如 商户消费 / 餐饮美食；不可靠，仅作参考 */
  category: string | null;
  /** 支付方式 / 资金渠道，如 零钱 / 花呗；用于映射账户 */
  payMethod: string | null;
  /** 交易状态原值 */
  status: string | null;
  /** 平台侧唯一流水号（字符串，可能很长） */
  orderNo: string | null;
  /** 商户订单号 */
  merchantOrderNo: string | null;
  /** 商品名称 / 商品说明 */
  product: string | null;
  /** 备注 / 用途 */
  note: string | null;
  /** 原始行：字段名 → 原值，供人工核对与后续补映射 */
  raw: Record<string, string>;
}

/** 解析一份文件的结论。 */
export interface ImportParseResult {
  /** 识别到的来源；识别不出时为 null */
  source: ImportSource | null;
  /** 表头所在行号（1 起）；识别不出时为 null */
  headerRow: number | null;
  /** 表头列名（已 trim） */
  header: string[];
  /** 成功归一化的记录 */
  records: ImportRecord[];
  /** 被跳过的行及原因 */
  skipped: ImportSkip[];
  /** 文件自带的汇总行（用于对账），没有则为 null */
  declared: DeclaredSummary | null;
}

/** 一行被跳过的原因。 */
export interface ImportSkip {
  rowIndex: number;
  reason: string;
  /** 原始行内容，截断后便于定位 */
  raw: string;
}

/**
 * 文件头自带的汇总。
 * 微信、支付宝的个人账单都会在开头声明笔数与金额，
 * 解析完拿它做对账，是最硬的一条正确性证据。
 */
export interface DeclaredSummary {
  totalCount: number | null;
  income?: { count: number; sum: number } | null;
  expense?: { count: number; sum: number } | null;
  /** 微信叫「中性交易」，支付宝叫「不计收支」 */
  transfer?: { count: number; sum: number } | null;
}

/** 某个来源的解析器。 */
export interface ImportProfile {
  source: ImportSource;
  /** 人类可读的名字，用于清单标题 */
  label: string;
  /** 表头里必须出现的列名（用于识别，不用于提取） */
  headerSignature: string[];
  /** 该来源是否有余额，可用于勾稽 */
  hasBalance: boolean;
  /** 把表头之后的若干行转成记录 */
  extract(rows: string[][], header: string[], headerRow: number): {
    records: ImportRecord[];
    skipped: ImportSkip[];
  };
  /** 从文件头（表头之前的行）解析出汇总；没有则返回 null */
  parseDeclared?(texts: string[]): DeclaredSummary | null;
}
