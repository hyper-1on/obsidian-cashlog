import { moment as obsidianMoment } from "obsidian";

// 自定义 Moment 接口，声明代码库中实际使用的方法
// 避免审核环境无法解析 obsidian 的 moment 类型导出导致 Moment 解析为 any
/** moment 的时间差对象；此处只需按天/按月取值 */
export interface Duration {
  asDays(): number;
  asMonths(): number;
}

export interface Moment {
  clone(): Moment;
  startOf(unit: string): Moment;
  endOf(unit: string): Moment;
  add(amount: number, unit: string): Moment;
  add(duration: Duration): Moment;
  subtract(amount: number, unit: string): Moment;
  subtract(duration: Duration): Moment;
  date(): number;
  date(value: number): Moment;
  daysInMonth(): number;
  isoWeekday(): number;
  valueOf(): number;
  isValid(): boolean;
  isSameOrAfter(other: Moment): boolean;
  isSameOrBefore(other: Moment): boolean;
  isBefore(other: Moment): boolean;
  isAfter(other: Moment): boolean;
  format(format?: string): string;
}

// obsidian.d.ts 把 moment 声明为 `typeof import("moment")`（`import * as Moment`），
// 那是命名空间类型，不带调用签名 —— 直接 `moment()` 会报 "has no call signatures"。
// 运行时它就是 moment 工厂函数，这里显式补上调用签名。
interface MomentFactory {
  (input?: unknown): Moment;
  (input: unknown, format: string): Moment;
  /** 无效时刻，用于解析失败时占位 */
  invalid(): Moment;
  /** 时间差；DateRange 只用到按天/按月两种粒度 */
  duration(amount: number, unit: string): Duration;
  duration(input: unknown): Duration;
  locale(): string;
}

export const moment = obsidianMoment as unknown as MomentFactory;
