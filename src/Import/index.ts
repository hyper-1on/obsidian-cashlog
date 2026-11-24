// 导入功能 · 入口
//
// 这里只做「给定 rows，产出统一结构」，不碰文件读取、不碰 Obsidian：
// - node 侧由 scripts/verify-import.ts 读文件后调用
// - 插件侧由 ImportModal 用 vault.readBinary 读文件后调用
// 两边跑的是同一份解析逻辑，验证脚本的结论才能代表插件的行为。

import { findHeader, type HeaderSignature } from "./header";
import type { ImportParseResult, ImportProfile } from "./types";
import { alipayLedgerProfile } from "./profiles/alipayLedger";
import { wechatPersonalProfile } from "./profiles/wechatPersonal";

/**
 * 已支持的格式。
 * 顺序即匹配优先级：特征更具体的放前面，避免被更宽松的 signature 抢走。
 */
export const PROFILES: ImportProfile[] = [alipayLedgerProfile, wechatPersonalProfile];

function signaturesInOrder(): HeaderSignature[] {
  return PROFILES.map((p) => ({ need: p.headerSignature }));
}

/**
 * 解析一张已经转成二维数组的表。
 *
 * rows 里的单元格必须是字符串；xlsx 的日期序列号由调用方先转换
 * （core 不引入 SheetJS，保持纯函数）。
 */
export function parseImportRows(rows: string[][]): ImportParseResult {
  const empty: ImportParseResult = {
    source: null,
    headerRow: null,
    header: [],
    records: [],
    skipped: [],
    declared: null,
  };

  if (rows.length === 0) return empty;

  const match = findHeader(rows, signaturesInOrder());
  if (!match) return empty;

  const profile = PROFILES[match.signatureIndex];
  const { records, skipped } = profile.extract(rows, match.header, match.rowIndex);

  // 表头之前的行就是文件头，汇总声明通常在那里
  const headTexts = rows.slice(0, match.rowIndex).map((r) => r.join(" "));
  const declared = profile.parseDeclared ? profile.parseDeclared(headTexts) : null;

  return {
    source: profile.source,
    headerRow: match.rowIndex + 1,
    header: match.header,
    records,
    skipped,
    declared,
  };
}
