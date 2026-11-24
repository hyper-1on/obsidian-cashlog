// 导入功能 · 文本解码
//
// 账单的编码不统一：微信个人/商户是 UTF-8（可能带 BOM），
// 支付宝两个个人账单是 GB18030。检测顺序固定为 BOM → UTF-8 严格 → GB18030。
//
// 为什么不用「猜」：UTF-8 的非法字节序列很少见，能用 fatal:true 严格解码成功
// 就几乎一定真的是 UTF-8；失败再回退 GB18030，比看字节分布猜可靠得多。

export type ImportEncoding = "UTF-8" | "UTF-8 (BOM)" | "GB18030";

export interface DecodedText {
  text: string;
  encoding: ImportEncoding;
}

/** GB18030 是否可用。iOS 的 WKWebView 上 TextDecoder 可能不支持这个编码。 */
export function isGb18030Available(): boolean {
  try {
    new TextDecoder("gb18030");
    return true;
  } catch {
    return false;
  }
}

/**
 * 解码账单字节。
 *
 * 注意：GB18030 不可用时会抛出明确错误，而不是返回乱码文本。
 * 静默乱码会让用户以为账单解析成功、只是内容奇怪，比直接失败更糟。
 */
export function decodeImportText(bytes: Uint8Array): DecodedText {
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(3)),
      encoding: "UTF-8 (BOM)",
    };
  }

  // 严格 UTF-8：不合法会抛异常
  try {
    const strict = new TextDecoder("utf-8", { fatal: true });
    return { text: strict.decode(bytes), encoding: "UTF-8" };
  } catch {
    // 落到 GB18030
  }

  if (!isGb18030Available()) {
    throw new Error(
      "这个文件需要 GB18030 解码，但当前环境不支持。请先用 Excel 或记事本另存为 UTF-8 CSV 再导入。",
    );
  }

  return { text: new TextDecoder("gb18030").decode(bytes), encoding: "GB18030" };
}
