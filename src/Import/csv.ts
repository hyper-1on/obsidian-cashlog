// 导入功能 · CSV 解析
//
// 账单 CSV 有几个现实问题，所以不直接 split(",")：
// - 字段里可能有逗号（商品名）、换行（备注）
// - 支付宝网页端的列名带尾随空格
// - 支付宝分列式的流水号带尾随 tab
// 这里按 RFC 4180 处理引号与换行，单元格的空白由调用方 trim。

/**
 * 把 CSV 文本解析成二维数组。
 * 保留空行（由调用方决定是否跳过），因为跳过空行的判断要和「# 分隔线」一起做。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // "" 表示一个字面量引号
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  // 末尾没有换行时补最后一行
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
