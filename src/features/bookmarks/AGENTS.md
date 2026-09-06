# 书签页面模块

面包屑：`src/features/bookmarks` ← `src/features` ← 项目根。

## 职责

管理书签树、目录切换、拖拽排序、默认目录和手势导航；`page.ts` 是遗留页面控制器，含 DOM 与 Chrome Bookmarks API 的副作用。

## 入口与对外接口

- 页面入口由 [`../../main.ts`](../../main.ts) 的 `import './features/bookmarks/page'` 触发。
- `root.ts` 导出 `getBookmarksBarId`；`order-sync.ts` 导出 `refreshBookmarkOrder` 与事件驱动的 `startBookmarkChangeSync`（监听 bookmarks 变更事件触发同步，无轮询）。
- `page-parsers.ts` 导出页面所用的存储/消息边界解析器和相关类型。
- `folder-swiper.ts` 用 Swiper 管理固定目录整屏滑动，并导出当前书签列表查询。
- `card-colors.ts` 是书签卡颜色缓存的内存层：首次访问一次性载入 `bookmark-colors-*` localStorage 键，写操作延迟批量落盘；卡片渲染路径不得再逐卡同步读写 localStorage。
- `root.ts` 的 `getBookmarksBarId` 结果按会话缓存；`order-sync.ts` 用逐字段浅比较判断变化，`startBookmarkChangeSync` 接受可选 `quietPeriodMs`（page.ts 传 100）合流书签事件风暴。

## 关键依赖与数据

- Chrome `bookmarks`、`storage`、`history`、`tabs` API；`sortablejs`、`radashi` 和 `swiper`。
- `default-folders.ts` 只读写 `chrome.storage.local.defaultFolders`；不要改回 `storage.sync`。
- `page.ts` 依赖真实页面 DOM、`window` 全局契约及模块加载顺序，避免在未做页面验收时移动其初始化逻辑。
- 启动性能契约：固定目录 slide 只渲染激活页，其余在首次滑入时由 `onPinnedSlideChange` 惰性渲染；书签/文件夹右键菜单均为首次右键时惰性创建；`ensureScrollIndicator` 的全局监听在列表脱离 DOM 后自释放，修改 rebuild 流程时不要破坏该回收路径。
- 事件契约：书签卡的 click/contextmenu 走 document 级委托（`setupBookmarkCardDelegation`），卡片元素必须携带 `data-id`/`data-url`（card-update 编辑后同步刷新）；侧边栏树只构建首层，子层级在首次展开时从 `bookmarkTreeNodes` 懒构建（`buildSubfolderItems`）并按需绑定嵌套 Sortable；`displayBookmarks` 在子项 id/URL/标题序列与 DOM 一致时跳过重建，外部改名依赖该比对刷新视图。

## 测试与质量

- 相关测试：`tests/bookmark-root.test.ts`、`bookmark-order-sync.test.ts`、`bookmark-page-parsers.test.ts`、`default-folders.test.ts`。
- 修改纯 helper 优先补 Node 测试；修改 `page.ts` 的 DOM/Chrome 行为须执行扩展页手工验收。

## 常见问题

- `page.ts` 是大控制器；拆分前先锁定现有 DOM 事件与全局函数的顺序。
- `BookmarkTreeNode` 的 ID 是字符串，默认目录数据缺失或过期时必须安全降级。

## 相关文件清单

- `page.ts`、`page-parsers.ts`、`root.ts`、`order-sync.ts`
- `card-colors.ts`、`card-update.ts`、`default-folders.ts`、`gesture-navigation.ts`、`folder-swiper.ts`、`bookmark-cache.ts`、`qr-modal.ts`
- `../../main.ts`、`../../../tests/bookmark-*.test.ts`、`../../../tests/default-folders.test.ts`

## 变更记录

- 2026-09-06：书签卡 favicon URL 收敛到 `shared/favicon.ts`（`size=64`）。
- 2026-08-23（二轮）：书签卡点击/右键改文档级委托（卡片零监听，dataset 携带 url）、侧边栏点击委托 + 子层级懒构建 + Sortable 按需绑定、displayBookmarks 序列一致跳过重建、删除 ColorCache v2 双轨（文件夹卡用恒定默认色）、懒渲染 promise 补 catch。
- 2026-08-23：性能整改——启动只渲染激活 slide（其余滑入惰性渲染）、书签事件合流（quietPeriodMs=100）+ 浅比较替代 JSON.stringify、颜色缓存内存层（card-colors.ts）、右键菜单与侧边栏计数惰性化、scroll indicator 观察器自释放、hover 改 CSS。
- 2026-08-21：固定目录切换改为 Swiper 垂直整屏滑动。
- 2026-08-21：书签排序从 30 秒轮询改为 Chrome 事件驱动；删除失效的虚拟滚动机制；取色改为 64×64 降采样。
- 2026-08-20：从根级 TypeScript 文件迁入功能目录并建立模块索引。
