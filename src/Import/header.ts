// 导入功能 · 表头定位
//
// 所有个人账单的表头都不在第 1 行：微信前面有 4–17 行说明，
// 支付宝有 6–12 行。所以不能假设位置，只能按列名特征搜。
//
// 列名比对前统一 trim —— 支付宝网页端的列名带尾随空格，不 trim 会永远认不出。

export interface HeaderSignature {
  /** 表头里必须同时出现的列名 */
  need: string[];
}

export interface HeaderMatch {
  /** 0 起的行下标 */
  rowIndex: number;
  /** 已 trim 的列名 */
  header: string[];
  /** 命中的 signature 下标 */
  signatureIndex: number;
}

/**
 * 在前 maxScan 行里找表头。
 *
 * 匹配规则：某一行同时包含 signature 里的所有列名。
 * 用「包含」而不是「相等」，是因为支付宝部分列名带单位后缀（如「金额（元）」），
 * 而不同版本的这个后缀会变。
 */
export function findHeader(
  rows: string[][],
  signatures: HeaderSignature[],
  maxScan = 40,
): HeaderMatch | null {
  const limit = Math.min(rows.length, maxScan);

  for (let r = 0; r < limit; r++) {
    const cells = rows[r].map((c) => String(c ?? "").trim());
    for (let s = 0; s < signatures.length; s++) {
      const need = signatures[s].need;
      if (need.every((name) => cells.some((c) => c === name || c.startsWith(name)))) {
        return { rowIndex: r, header: cells, signatureIndex: s };
      }
    }
  }

  return null;
}

/** 取某一列的索引；列不存在返回 -1。 */
export function columnIndex(header: string[], name: string): number {
  return header.indexOf(name);
}

/** 取某行的某个单元格并 trim；越界返回空串。 */
export function cell(row: string[], index: number): string {
  if (index < 0 || index >= row.length) return "";
  return String(row[index] ?? "").trim();
}
