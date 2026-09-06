# 页面共享模块

面包屑：`src/shared` ← `src` ← 项目根。

## 职责

提供跨功能模块使用的全局类型、图标、国际化和共享数据类型。

## 入口与对外接口

- `localization.ts` 由 `src/main.ts` 首先加载并注册本地化能力。
- `icons.ts` 导出图标映射与 HTML/SVG helper；`global.d.ts` 扩展页面全局类型；`types.ts` 存放共享 TypeScript 类型。

## 关键依赖与配置

- 国际化消息来自 `src/_locales/`（manifest `default_locale` 为 `en`，含 `zh_CN` 在内 9 种语言）与 Chrome i18n。
- 图标映射是 UI 运行时契约，新增图标时同步使用端并保持 `IconName` 约束。

## 测试与质量

- `tests/icons.test.ts` 覆盖图标入口和 SVG 输出。
- 修改全局声明必须运行 `npm run typecheck`。

## 常见问题

- `global.d.ts` 只有类型作用，不能替代实际全局函数的初始化。
- `localization.ts` 的加载顺序早于使用 `getLocalizedMessage` 的页面模块。

## 相关文件清单

- `global.d.ts`、`icons.ts`、`favicon.ts`、`localization.ts`、`types.ts`
- `../main.ts`、`../_locales/`

## 变更记录

- 2026-09-06：新增 `favicon.ts` 统一 MV3 `_favicon/` URL 构造（`size=64`，无 `cache` 参数——该参数在 Chromium 中不存在）；快捷链接、书签、搜索建议全部收敛到该 helper。
- 2026-08-23：修正测试引用（task4-typescript-entry 已并入 `tests/icons.test.ts`）与多语言目录描述。
- 2026-08-20：跨模块文件从根级迁入 `shared`。
