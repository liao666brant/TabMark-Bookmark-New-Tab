# 设置模块

面包屑：`src/features/settings` ← `src/features` ← 项目根。

## 职责

负责设置侧栏、外观与布局选项、链接打开方式、快捷链接和手势配置的页面交互。

## 入口与对外接口

- `src/main.ts` 通过目录入口加载 `index.ts`。
- 该模块以页面副作用为主，未发现稳定的独立业务 API。

## 关键依赖与数据

- 依赖 Chrome storage、页面设置侧栏 DOM 以及其他功能模块暴露的全局行为。
- 性能契约：构造函数只做 init 调度，全部 DOM 查询在 `init()`（空闲回调）内执行，不要把查询挪回构造函数；滑块 input 处理经 `coalesceInputFrame` 按帧合流；`.bookmarks-list` 引用缓存带 `isConnected` 自检（folder-swiper rebuild 会替换节点）；wheel-switching 标签只走通用 tab 绑定，勿再单独绑定 click。

## 测试与质量

- `tests/settings-typescript-entry.test.ts` 保护入口接线。
- 修改设置值、侧栏或布局后，在扩展页逐项确认保存和重新打开后的状态。

## 常见问题

- `index.ts` 是目录入口命名，不代表无副作用；保持 `main.ts` 的导入顺序。

## 相关文件清单

- `index.ts`
- `../../main.ts`、`../../index.html`
- `../../../tests/settings-typescript-entry.test.ts`

## 变更记录

- 2026-09-06：布局 tab 新增自定义欢迎语输入框（`customWelcomeMessage` 键，输入 300ms 防抖落盘，欢迎语模块经 onChanged 即时应用）。
- 2026-08-23（二轮）：init 幂等守卫 + 打开侧栏时未初始化则同步补初始化（修复空闲初始化完成前点击设置静默失效）。
- 2026-08-23：性能整改——DOM 查询移入空闲 init、删除滚轮切换 tab 双绑定、滑块 rAF 合帧 + 单次 getComputedStyle + 列表引用缓存、resize 仅侧栏打开时工作、首启默认值单次 set、matchMedia 标准 API。
- 2026-08-20：设置入口收紧为目录 `index.ts`。
- 2026-08-21：初始化改为一次批量读取 sync 配置；侧栏整体初始化推迟到浏览器空闲时（requestIdleCallback）执行。
