// 测试构建脚本：把测试用例与 src 一起打包成 CJS，再用 node 内置 test runner 运行。
//
// 要点：把 "obsidian" 别名到本地测试桩（tests/stubs/obsidian.ts），
// 从而让插件逻辑脱离 Obsidian 运行时、可在 Node 下直接验证。
//
// 用法：npm test
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, mkdirSync } from "node:fs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, "..");
const distDir = path.join(testsDir, "dist");
mkdirSync(distDir, { recursive: true });

const alias = { obsidian: path.join(testsDir, "stubs", "obsidian.ts") };

// ---- 1) 差分测试基线：编译「修复前」的 PanelSettings ----
// fixture 由 `git show <fix-commit>^:src/PanelSettings.ts` 导出，用于新旧实现差分对比。
const oldPanelSrc = path.join(testsDir, "fixtures", "PanelSettings.before.ts");
const oldPanelOut = path.join(distDir, "panel-settings-old.cjs");

if (existsSync(oldPanelSrc)) {
  await esbuild.build({
    stdin: {
      contents: readFileSync(oldPanelSrc, "utf8"),
      resolveDir: path.join(root, "src"),
      loader: "ts",
      sourcefile: "PanelSettings.before.ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: oldPanelOut,
    alias,
    logLevel: "warning",
  });
  console.log("built -> tests/dist/panel-settings-old.cjs");
} else {
  console.log("skip -> tests/dist/panel-settings-old.cjs（缺少 fixture）");
}

// ---- 2) 测试包 ----
const outfile = path.join(distDir, "tests.cjs");
await esbuild.build({
  entryPoints: [path.join(testsDir, "regression.test.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  alias,
  // 差分基线是独立产物，不参与打包
  external: ["./panel-settings-old.cjs"],
  logLevel: "warning",
});
console.log("built -> tests/dist/tests.cjs");

// ---- 3) 冒烟产物：整插件打包 ----
// 插件在 Obsidian 里加载失败最常见的原因是模块顶层访问 DOM，或 onload 里
// 引用了未导入的符号。这个产物配合 regression.test.ts 里的「冒烟」用例使用。
const smokeOutfile = path.join(distDir, "plugin-smoke.cjs");
await esbuild.build({
  entryPoints: [path.join(root, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: smokeOutfile,
  alias,
  logLevel: "warning",
});
console.log("built -> tests/dist/plugin-smoke.cjs");
