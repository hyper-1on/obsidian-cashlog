/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Obsidian API 和 Chart.js 类型在 ESLint 类型检查中无法完全解析 */
import { Editor, Notice, type TFile } from "obsidian";
import type CashlogPlugin from "./main";
import { CashlogEntry } from "./CashlogEntry";
import { parseCashlogLineLenient } from "./CashlogSerializer";
import { CashlogModal, EditableEntryData } from "./CashlogModal";
import { ChartModal } from "./ChartModal";
import { ImportModal } from "./Import/ImportModal";
import { nonCashlogRegex } from "./CashlogRegex";
import { EntryLocation } from "./EntryLocation";
import { buildEntryFromModalData } from "./EntryEditor";
import { t } from "./i18n";
import { moment } from "./types";

// 注册所有命令
export function addCommands(plugin: CashlogPlugin): void {
  plugin.addCommand({
    id: "create-or-edit",
    name: t("commands.createOrEdit"),
    icon: "yen-sign",
    editorCheckCallback: (checking, editor, view) => {
      return createOrEdit(checking, editor, view, plugin);
    },
  });

  plugin.addCommand({
    id: "insert-chart",
    name: t("commands.insertChart"),
    icon: "table",
    editorCheckCallback: (checking, editor, _view) => {
      if (checking) return true;
      const modal = new ChartModal(plugin.app, plugin, editor);
      modal.open();
      return true;
    },
  });

  plugin.addCommand({
    id: "import-statement",
    name: t("commands.importStatement"),
    icon: "upload",
    // 不依赖光标位置，直接开弹窗
    callback: () => {
      new ImportModal(plugin.app, plugin).open();
    },
  });

  plugin.addCommand({
    id: "open-panel",
    name: t("commands.openPanel"),
    icon: "yen-sign",
    callback: () => {
      void plugin.activateCashlogPanel();
    },
  });
}

// 从任意行提取缩进和列表标记
function extractLineContext(line: string): { indentation: string; listMarker: string } {
  const match = line.match(nonCashlogRegex);
  if (match === null) {
    return { indentation: "", listMarker: "-" };
  }
  return {
    indentation: match[1],
    listMarker: match[2] ?? "-",
  };
}

// 光标所在行在文件中的位置。
// 必须把位置一路传到 EntryEditor：编辑「余额变更」条目时，
// 它依赖 location 才能把这条自身从「当前余额」重算里排除掉，
// 否则每次保存都会按旧 delta 偏移一次。
export function buildEntryLocationForCursor(
  file: { path: string } | null | undefined,
  lineNumber: number,
): EntryLocation | null {
  if (!file || !file.path) return null;
  return new EntryLocation(file.path, lineNumber);
}

// 创建或编辑记账条目。
// 导出是为了让编辑器右键菜单复用同一套逻辑（菜单与命令必须行为一致）。
export function createOrEdit(
  checking: boolean,
  editor: Editor,
  view: { file?: TFile | null } | null,
  plugin: CashlogPlugin,
): boolean {
  if (checking) {
    return true;
  }

  const cursor = editor.getCursor();
  const lineNumber = cursor.line;
  const line = editor.getLine(lineNumber);

  const context = extractLineContext(line);
  const location = buildEntryLocationForCursor(view?.file, lineNumber);

  let entry = parseCashlogLineLenient(line, location, plugin.settings);

  if (entry === null) {
    const nonMatch = line.match(nonCashlogRegex);
    const description = nonMatch ? (nonMatch[3] || "").trim() : line.trim();
    entry = new CashlogEntry(
      description,
      0,
      moment(),
      null,
      [],
      context.indentation,
      context.listMarker,
      location,
      "",
    );
  }

  const writeToEditor = (data: EditableEntryData) => {
    if (data.tagType === "balanceChange") {
      if (!plugin.cache) {
        new Notice(t("notice.accountBalanceUnavailable"));
        return;
      }
    }
    const newEntry = buildEntryFromModalData(data, plugin, {
      indentation: context.indentation,
      listMarker: context.listMarker,
      location,
    });
    const newLine = newEntry.toFileLineString();

    if (line.trim() === "") {
      editor.replaceRange(newLine + "\n", cursor);
    } else {
      editor.setLine(lineNumber, newLine);
    }
  };

  const modal = new CashlogModal(
    plugin.app, plugin.settings, entry, writeToEditor, writeToEditor, plugin,
  );
  modal.open();

  return true;
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- 结束 Obsidian API 和 Chart.js 类型安全规则禁用 */
