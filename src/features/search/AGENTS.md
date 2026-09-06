# 搜索模块

面包屑：`src/features/search` ← `src/features` ← 项目根。

## 职责

维护内置与自定义搜索引擎、下拉选择、搜索标签和跨引擎临时搜索。

## 入口与对外接口

- `src/main.ts` 加载 `dropdown.ts`；书签页面调用 `interactions.ts` 初始化搜索输入、建议和跨引擎搜索。
- 对外导出包括 `SearchEngineManager`、`createSearchEngineDropdown`、`initializeSearchEngineDialog`、`createTemporarySearchTabs` 与图标 helper。

## 关键依赖与数据

- Chrome `storage`、`tabs` API，页面搜索 DOM 与本地化函数。
- 自定义搜索引擎使用 localStorage；URL 模板以 `%s` 作为查询占位。
- 性能契约：搜索框只绑一个 focus/blur 处理器（`.focused` 切换 + 建议查询合一），不要重复绑定；建议设置（`showHistorySuggestions` 等）走模块级缓存 + `storage.onChanged` 失效；输入链路用递增 `suggestionQueryId` 丢弃过期查询，新增异步查询必须接入；`getRecentHistory` 有 60 秒 TTL 内存缓存；`createDropdownUI` 复用容器，iconContainer/document 监听只绑一次。

## 测试与质量

- 页面搜索和引擎选择缺独立单测；变更后至少验证搜索输入、引擎切换和 Cmd/Ctrl+Enter 多标签行为。

## 常见问题

- `dropdown.ts` 管理引擎选择，`interactions.ts` 管理页面搜索交互；CSS 类名 `search-engine-dropdown` 不是文件路径，不要随文件重命名而改动。
- qrcode 库在两个 `qr-modal.ts` 中均为动态 `import()`（点击生成时才加载），不要改回静态导入。

## 相关文件清单

- `dropdown.ts`
- `interactions.ts`
- `../bookmarks/page.ts`、`../../main.ts`、`../../index.html`

## 变更记录

- 2026-09-06：搜索建议 favicon URL 收敛到 `shared/favicon.ts`（`size=64`，移除无效的 `cache` 参数）。
- 2026-08-23（三轮）：行为表（userSearchBehavior）内存缓存 + 防抖落盘 + onChanged 失效 + pagehide 兜底刷新（相关性计算不再逐键读 storage）；引擎开关重建改 300ms 防抖合并。
- 2026-08-23：性能整改——focus/Sortable 去重、设置缓存、过期查询丢弃、去重 Map 化、Levenshtein 剪枝、favicon cache=1、下拉监听器不再累积、文本图标改 data URL、远程图标 Promise.any。
- 2026-08-20：入口文件名收紧为 `dropdown.ts`。
