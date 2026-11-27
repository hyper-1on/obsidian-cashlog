# Cashlog

> **Fork 声明** — 本仓库是
> [uuq007/obsidian-cashlog](https://github.com/uuq007/obsidian-cashlog) 的 fork，
> 由 [hyper-1on](https://github.com/hyper-1on/obsidian-cashlog) 维护，当前版本
> **1.2.0**，只作自用，不发布 release、不提交社区市场。
> 相对上游的全部缺陷修复见 **[PATCH.md](PATCH.md)**，后续开发记录见
> **[CHANGES.md](CHANGES.md)**。

一款 Obsidian 个人记账插件。使用 Emoji 标记直接在 Markdown 笔记中记录收支，然后通过查询语法检索、可视化和分析数据 — 所有操作都在你的 Vault 中完成。

**[English](https://github.com/hyper-1on/obsidian-cashlog/blob/main/README.md)**

**[使用手册](https://github.com/hyper-1on/obsidian-cashlog/blob/main/使用手册.md)**

---

## 功能特性

- **Markdown 原生记账** — 使用 Emoji 标记（`💴 ➕ ⏰`）将记账条目写成普通列表项
- **标签分类** — 用层级标签分类条目，如 `#支出/餐饮`、`#收入/工资`
- **查询语法** — 在 `cashlog` 代码块中过滤、排序、分组和汇总记账数据
- **图表可视化** — 通过 `cashlog-chart` 代码块生成条形图、折线图、扇形图和自定义表格
- **仪表盘面板** — 交互式侧边栏面板，包含摘要卡片、账户余额、预算和目标
- **多账户管理** — 追踪多个账户（微信、支付宝、银行卡），支持转账和余额调整
- **预算与目标** — 设置支出预算和收入目标，按周期追踪进度
- **附件功能** — 为记账条目附加票据照片，存储在 Vault 中
- **国际化** — 支持中英文界面
- **自然语言日期** — 支持 `date today`、`date last month`、`date 14 days ago` 等

### 本 fork 新增

在上述功能之外，本仓库还包含上游没有的改动。缺陷修复清单见
[PATCH.md](PATCH.md)，逐条开发记录见 [CHANGES.md](CHANGES.md)。

- **账单导入** — 从 vault 里选支付宝流水或微信个人账单（CSV / XLSX），
  解析成待确认列表：标出重复项与转账配对，补齐方向与标签后一次写入。
  支持表头笔数与金额对账，编码按 UTF-8 → GB18030 回退
- **标签树** — 标签是任意深度的树（`支出/餐饮/午餐`），在同一个弹窗里管理：
  就地改名、加子标签、连点两次删除
- **级联选标签** — 记账时逐层选择，三层标签点三次，不用打字
- **附加标签维度** — `地点`、`必要性` 这类独立标签树，与主标签一起写入笔记
- **`group by tag <路径>`** — 只看某一支，`level N` 控制下钻深度
- **图表弹窗的树形标签筛选** — 按层级缩进展示
- **界面上只显示纯词条** — 列表、表格、悬浮提示、勾选项显示 `支出/餐饮`；
  `#` 只留在笔记里，因为 Obsidian 需要它
- **编辑器右键菜单与左侧栏图标** — 不用命令面板也能记账或插入图表
- **顺序式 `column` 指令** — 按顺序声明列而不是按下标，并新增 `tag`、`time` 两列
- **货币符号可覆盖** — 界面语言与记账货币可以不一致
- **仓库内置回归测试** — `npm test` 跑 182 条，无额外依赖

## 快速开始

### 记一笔账

通过命令面板（`Ctrl+P`）→ `Create or edit cashlog`，或手动编写：

```markdown
- #支出/交通 坐高铁 💴-100 ➕2026-04-25 ⏰17:30
- #收入/工资 发工资 💴10000 ➕2026-04-25
```

| 符号 | 含义 | 格式 |
|------|------|------|
| `💴` | 金额 | `💴` + 数字（负数 = 支出） |
| `➕` | 日期 | `➕` + YYYY-MM-DD |
| `⏰` | 时间 | `⏰` + HH:mm |

![create-or-edit](assets/create-or-edit.png)

![create-or-edit2](assets/create-or-edit2.png)

在插件设置菜单中开启账户功能和附件功能后，完整的添加记账或编辑记账菜单如下：

![create-or-edit3](assets/create-or-edit3.png)


## 仪表盘面板

通过命令面板 → `打开 Cashlog 面板` 打开。面板提供：

![dashboard](assets/dashboard.png)

- **摘要卡片** — 当期收入、支出、结余、笔数
- **账户余额** — 各账户实时余额，支持点击查看明细
- **预算进度** — 支出 vs 预算，按周期追踪
- **目标进度** — 收入达成 vs 目标
- **最近交易** — 最近 10 条记录，悬浮显示详情
- **分类排行** — 支出分类 Top 5，显示占比

所有区域均可点击进入详情页。



### 查询数据

````markdown
```cashlog
is expense
date this month
sort by date descending
show total expense
```
````

![image-20260514235928988](assets/image-20260514235928988.png)

### 图表可视化

通过命令面板（`Ctrl+P`）→ `插入图表`，或手动编写：

![image-20260515000639026](assets/image-20260515000639026.png)

````markdown
```cashlog-chart
group by month
chart type bar
chart title "月度收支对比"
chart bar split by valueType
chart legend true
```
````

![image-20260515000037141](assets/image-20260515000037141.png)

![image-20260515000305595](assets/image-20260515000305595.png)

![image-20260515000355591](assets/image-20260515000355591.png)

![image-20260515000433199](assets/image-20260515000433199.png)

## 条目格式

### 基础格式

```markdown
- #支出/餐饮 午饭 💴-25 ➕2026-04-25 ⏰12:00
```

### 带账户

```markdown
- #支出/购物 买衣服 💳微信💴-200 ➕2026-04-25
```

### 转账

```markdown
- #转账 还信用卡 💳支付宝💴-500 💳工行信用卡💴500 ➕2026-04-25
```

### 余额变更

```markdown
- #余额变更 调整余额 💳支付宝💴50 ➕2026-04-25
```

### 带附件

```markdown
- #支出/购物 买衣服 💳微信💴-200 🧷[[cashlog-2026042517303050|小票]] ➕2026-04-25
```

## 查询语法

使用 `` ```cashlog `` 代码块查询整个 Vault 中的记账数据。

### 过滤指令

| 指令 | 说明 |
|------|------|
| `is income` / `is expense` / `is transfer` | 按类型过滤 |
| `tag includes #支出/餐饮` | 标签包含（支持 OR） |
| `description includes 高铁` | 描述包含文本（支持 OR） |
| `amount above 100` | 金额绝对值比较 |
| `date this month` | 日期过滤（自然语言、范围等） |
| `account is 微信` | 账户过滤（支持 OR） |
| `path includes 记账/` | 文件路径过滤 |
| `has attachment` | 仅显示有附件的条目 |

### 排序指令

| 指令 | 说明 |
|------|------|
| `sort by date descending` | 按日期排序 |
| `sort by amount descending` | 按金额排序 |
| `sort by description ascending` | 按描述排序 |

### 分组指令

| 指令 | 说明 |
|------|------|
| `group by tag` | 按标签分组 |
| `group by month` | 按月份分组 |
| `group by account` | 按账户分组 |
| `group by type` | 按类型分组 |

### 汇总指令

| 指令 | 说明 |
|------|------|
| `show total` | 显示总收入、总支出、结余、条目数 |
| `show total expense` | 仅显示总支出 |
| `show balance` | 仅显示结余 |
| `show count` | 仅显示条目数 |

### 日期格式

```
date 2026-04-25              # 指定日期
date today                   # 自然语言
date this month              # 相对范围
date 2026                    # 全年
date 2026-04                 # 整月
date 2026-W15                # ISO 周
date 2026-Q2                 # 季度
date 2026-01-01 2026-03-31   # 绝对范围
```

## 图表

使用 `` ```cashlog-chart `` 代码块渲染可视化图表（基于 Chart.js）。

| 类型 | 指令 |
|------|------|
| 条形图 | `chart type bar` |
| 折线图 | `chart type line` |
| 扇形图 | `chart type pie` |
| 表格 | `table columns N` + `colN 字段 "表头" 对齐` |

### 图表选项

| 指令 | 说明 |
|------|------|
| `chart title "标题"` | 图表标题 |
| `chart width 800` | 宽度（px） |
| `chart height 400` | 高度（px） |
| `chart legend true` | 显示图例 |
| `chart labels true` | 显示数据标签 |
| `chart bar split by valueType` | 按数值类型拆分柱子 |
| `chart line split by tag` | 按标签拆分折线 |
| `chart value income` | 扇形图数值模式 |



## 安装

本 fork **不发布 release**，也不在 Obsidian 社区市场里，没有可以直接下载的
安装包。用法是从源码构建，再把产物放进 vault。

### 从源码构建

```bash
git clone https://github.com/hyper-1on/obsidian-cashlog.git
cd obsidian-cashlog
git checkout dev
npm install
npm run build
```

依赖里有一个 `git+ssh` 来源的包（`eslint-plugin`，由 `obsidian-dev-utils`
带入）。如果 `npm install` 报 SSH 相关错误，先让 git 把 SSH 地址重写成
HTTPS，再重试：

```bash
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

### 放进 vault

1. 在 vault 的 `.obsidian/plugins/` 下建一个目录，目录名与 `manifest.json`
   的 `id` 保持一致
2. 把 `main.js`、`manifest.json`、`styles.css` 复制进去
3. Obsidian 设置 → 第三方插件 → 重新加载列表 → 启用

### 更新

重新 `npm run build`，覆盖 `main.js` 与 `styles.css`，再在 Obsidian 里
重载插件（或执行「重新加载应用」）。

## 设置

| 分类 | 选项 |
|------|------|
| 标签 | 自定义收入/支出/转账/余额变更标签名；重命名时自动迁移历史数据 |
| 子标签 | 添加、重命名、合并或删除子标签；自动发现 Vault 中的子标签 |
| 账户 | 开启多账户、添加/重命名/删除账户、设置初始余额 |
| 附件 | 开启文件上传、配置存储目录 |
| 预算 | 设置支出限额，支持按周/月/年/自定义周期和标签过滤 |
| 目标 | 设置收入目标，支持按周期和标签过滤 |
| 统计 | 周期模式（按日/周/月/年）、自定义起始日期 |
| 路径 | 包含/排除 Vault 路径 |

## 系统要求

- Obsidian v1.7.2+

## 许可证

MIT
