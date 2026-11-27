/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { type App, type Vault } from "obsidian";
import { moment } from "./types";
import type { Moment } from "./types";
import type { CashlogSettings } from "./Settings";
import { t } from "./i18n";

export class AttachmentManager {
  constructor(
    private app: App,
    private vault: Vault,
    private settings: CashlogSettings,
  ) {}

  // 生成附件文件名：毫秒时间戳 + 冲突序号。
  // 同一毫秒内多选上传（多次调用都落在同一毫秒）会生成相同时间戳，
  // 不做唯一化会导致 createBinary 因文件已存在而失败、附件丢失。
  // now 可注入：测试需要稳定复现「同一毫秒内多次上传重名」的场景，
  // 直接依赖真实时钟会跨毫秒，导致 base 不同而永远不触发冲突分支。
  generateFileName(extension: string, now: Moment = moment()): string {
    const base = `cashlog-${now.format("YYYYMMDDHHmmssSSS")}`;
    const folder = this.settings.attachmentFolder;
    let candidate = `${base}.${extension}`;
    let counter = 1;
    while (this.vault.getAbstractFileByPath(`${folder}/${candidate}`)) {
      candidate = `${base}-${counter++}.${extension}`;
    }
    return candidate;
  }

  // 确保附件文件夹存在
  async ensureAttachmentFolder(): Promise<void> {
    const folder = this.settings.attachmentFolder;
    const exists = this.vault.getAbstractFileByPath(folder);
    if (!exists) {
      await this.vault.createFolder(folder);
    }
  }

  // 保存上传的图片文件到 vault，返回 wikilink 字符串
  async saveAttachment(file: File): Promise<string> {
    await this.ensureAttachmentFolder();

    // 保留原始文件扩展名
    const ext = file.name.includes(".") ? file.name.split(".").pop() || "png" : "png";
    const fileName = this.generateFileName(ext);
    const filePath = `${this.settings.attachmentFolder}/${fileName}`;

    // 读取文件内容为 ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();

    // 写入 vault
    await this.vault.createBinary(filePath, arrayBuffer);

    // 返回 wikilink 字符串（用于嵌入到记账行）
    return `${fileName}|${t("attachment.defaultName")}`;
  }

  // 删除附件文件
  async deleteAttachment(fileName: string): Promise<void> {
    const filePath = `${this.settings.attachmentFolder}/${fileName}`;
    const file = this.vault.getAbstractFileByPath(filePath);
    if (file) {
      await this.app.fileManager.trashFile(file);
    }
  }
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
