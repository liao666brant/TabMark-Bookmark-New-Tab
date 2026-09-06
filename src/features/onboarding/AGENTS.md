# 欢迎与提示模块

面包屑：`src/features/onboarding` ← `src/features` ← 项目根。

## 职责

显示欢迎语和版本功能提示，并在页面加载期间绑定相关交互。

## 入口与对外接口

- `src/main.ts` 先加载 `welcome.ts`，随后加载 `feature-tips.ts`。
- `feature-tips.ts` 导出 `featureTips` 单例，存在模块求值期副作用。

## 关键依赖与配置

- 使用 Chrome i18n、存储和页面 DOM；依赖加载顺序与页面节点存在。
- 性能契约：`adjustTextColor` 缓存命中即返回（每分钟刷新不再重复解码壁纸采样）；非 `url(...)` 背景跳过 Image 加载；`showWelcomeMessage` 走模块级缓存 + `storage.onChanged` 同步；文本 MutationObserver 以 `lastAppliedMessage` 比对而非硬编码中文；分钟定时器在 `visibilitychange` 重新可见时立即刷新；提示状态机的展示触发用 `setTimeout(0)`（rAF 在后台标签页不触发会卡死队列）。

## 测试与质量

- 当前由页面入口与构建测试覆盖接线；修改交互后须在扩展新标签页检查欢迎语和提示展示。

## 常见问题

- 不要把单例创建延后或提前到不同入口，避免改变 `DOMContentLoaded` 注册顺序。

## 相关文件清单

- `welcome.ts`、`feature-tips.ts`、`index.ts`（progress 年度进度）
- `../../main.ts`、`../../../tests/task4-typescript-entry.test.ts`

## 变更记录

- 2026-09-06：新增自定义欢迎语——`customWelcomeMessage` 模块级缓存 + onChanged 同步，非空时替换默认分段问候并支持 `{name}` 占位符；文本仍经 `updateWelcomeMessage` 写入以维持 `lastAppliedMessage` 比对机制。
- 2026-08-23：性能整改——取色缓存命中早退、渐变背景跳过采样、showWelcomeMessage 内存缓存、observer 去语言依赖、visibilitychange 立即刷新、提示样式单例复用、状态机后台标签页卡死修复、提示 DOM 改 createElement/textContent。
- 2026-08-21：欢迎语刷新从常驻分钟 interval 改为对齐分钟边界的单次 setTimeout 链，页面隐藏时跳过刷新。
- 2026-08-20：从根级页面脚本迁入 onboarding 功能目录。
