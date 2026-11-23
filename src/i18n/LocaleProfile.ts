// 本地化端口：一种语言 = 一份 LocaleProfile。
//
// 这是 i18n 的唯一扩展点：新增语言只需在 initI18n 里 registerLocale 一份 profile，
// 不需要改动 t / tp / formatMoney / getCurrencySymbol 的任何调用方。
//
// 设计要点：
// - aliases 用来吸收 Obsidian / 浏览器给出的语言变体（zh-Hant、en-GB 等）；
// - currencySymbol 只是**该语言的默认值**，用户可以单独覆盖
//   （真实场景：中文界面 + 记美元），见 i18n.setCurrencyOverride。
export interface LocaleProfile {
  /** 语言标识，如 "zh-CN" */
  code: string;
  /** 匹配别名（不区分大小写），如 ["zh", "zh-hans"] */
  aliases: string[];
  /** 该语言的默认货币符号，如 "¥" */
  currencySymbol: string;
  /** 翻译表 */
  strings: Record<string, string>;
}
