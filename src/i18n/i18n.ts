/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
// 国际化翻译引擎
//
// 一种语言 = 一份 LocaleProfile（见 ./LocaleProfile.ts）。
// 新增语言只需在 initI18n 里 registerLocale 一份 profile，
// t / tp / formatMoney / getCurrencySymbol 的调用方完全不用改。
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";
import type { LocaleProfile } from "./LocaleProfile";

type StringMap = Record<string, string>;

// code 与所有别名都指向同一份 profile
const profileIndex = new Map<string, LocaleProfile>();
const profileList: LocaleProfile[] = [];

let current: LocaleProfile | null = null;
let fallback: LocaleProfile | null = null;

// 用户在设置里指定的货币符号；空表示使用语言默认值
let currencyOverride: string | null = null;

function registerLocale(profile: LocaleProfile): void {
  profileList.push(profile);
  profileIndex.set(profile.code.toLowerCase(), profile);
  for (const alias of profile.aliases) {
    profileIndex.set(alias.toLowerCase(), profile);
  }
}

// 把语言标识（zh-Hant、en-GB 等）解析成已注册的 profile
function resolveLocale(lang: string): LocaleProfile | null {
  const lower = (lang || "").toLowerCase();
  if (!lower) return null;

  // 1) 精确命中（含别名）
  const exact = profileIndex.get(lower);
  if (exact) return exact;

  // 2) 前缀命中：zh-Hant 落回同语言族已注册的第一个 profile
  const prefix = lower.split("-")[0];
  for (const profile of profileList) {
    if (profile.code.toLowerCase().startsWith(`${prefix}-`)) return profile;
    if (profile.aliases.some((a) => a.toLowerCase().startsWith(`${prefix}-`))) return profile;
  }
  return null;
}

// 初始化：注册语言包并检测用户语言。
// detectedLang 仅用于测试与显式指定；省略时按 moment locale → 浏览器语言 的顺序检测。
export function initI18n(detectedLang?: string): void {
  registerLocale({
    code: "zh-CN",
    aliases: ["zh", "zh-hans", "zh-hans-cn"],
    currencySymbol: "¥",
    strings: zhCN as StringMap,
  });
  registerLocale({
    code: "en",
    aliases: ["en-us", "en-gb", "en-au", "en-ca"],
    currencySymbol: "$",
    strings: en as StringMap,
  });

  fallback = profileIndex.get("en") ?? profileList[0] ?? null;

  // moment locale 反映 Obsidian 的语言设置，优先；否则退到浏览器语言
  const momentLocale =
    (window as unknown as { moment?: { locale?: () => string } }).moment?.locale?.() || "";
  const detected = detectedLang ?? (momentLocale || navigator.language || "");
  current = resolveLocale(detected) ?? fallback;
}

// 首次使用前确保已初始化（测试环境不一定显式调用 initI18n）
function ensureInitialized(): void {
  if (!current) initI18n();
}

// 简单翻译：当前语言 → 英文回退 → key 本身
export function t(key: string): string {
  ensureInitialized();
  return current?.strings[key] ?? fallback?.strings[key] ?? key;
}

// 带插值的翻译（替换 {name} 占位符）
export function tp(key: string, params: Record<string, string | number>): string {
  let str = t(key);
  for (const [k, v] of Object.entries(params)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return str;
}

// 当前语言的标识
export function getLocale(): string {
  ensureInitialized();
  return current?.code ?? "en";
}

// 当前使用的货币符号：设置覆盖优先，否则用语言默认
export function getCurrencySymbol(): string {
  ensureInitialized();
  return currencyOverride || current?.currencySymbol || "¥";
}

// 设置货币符号覆盖；传空字符串或 null 表示恢复语言默认
export function setCurrencyOverride(symbol: string | null): void {
  currencyOverride = symbol && symbol.trim() ? symbol.trim() : null;
}

// 格式化金额（按当前语言环境）
export function formatMoney(value: number): string {
  ensureInitialized();
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString(current?.code ?? "en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const currency = getCurrencySymbol();
  return value < 0 ? `-${currency}${formatted}` : `${currency}${formatted}`;
}

// 格式化无符号金额
export function formatMoneyUnsigned(value: number): string {
  ensureInitialized();
  return value.toLocaleString(current?.code ?? "en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
