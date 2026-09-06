// 导入所需的依赖
import { ICONS } from '../../shared/icons';
import { debounce } from 'radashi';
import { getActiveBookmarksList } from '../bookmarks/folder-swiper';

type Dimension = string | number;
type StoredSettings = Readonly<Record<string, unknown>>;

function getInput(id: string): HTMLInputElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
}

function getSelect(id: string): HTMLSelectElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLSelectElement ? element : null;
}

function getStoredBoolean(
  result: Readonly<Record<string, unknown>>,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = result[key];
  return typeof value === 'boolean' ? value : defaultValue;
}

function getStoredDimension(
  result: Readonly<Record<string, unknown>>,
  key: string,
  defaultValue: number,
): Dimension {
  const value = result[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return defaultValue;
}

function getStoredString(
  result: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = result[key];
  return typeof value === 'string' ? value : '';
}

function coalesceInputFrame(apply: () => void): () => void {
  let frame: number | null = null;
  const run = (): void => {
    frame = null;
    apply();
  };
  return () => {
    if (frame !== null) {
      return;
    }
    frame = requestAnimationFrame(run);
  };
}

// 设置管理器类
// allow: SIZE_OK — 行为保持型 TypeScript 迁移保留既有单一设置控制器，拆分会扩大本任务的回归面。
class SettingsManager {
  private settingsSidebar: HTMLElement | null = null;
  private settingsIcon: HTMLAnchorElement | null = null;
  private closeButton: HTMLElement | null = null;
  private tabButtons: NodeListOf<HTMLElement> | null = null;
  private tabContents: NodeListOf<HTMLElement> | null = null;
  private bgOptions: NodeListOf<HTMLElement> | null = null;
  private enableQuickLinksCheckbox: HTMLInputElement | null = null;
  private openInNewTabCheckbox: HTMLInputElement | null = null;
  private widthSlider: HTMLInputElement | null = null;
  private widthValue: HTMLElement | null = null;
  private widthPreviewCount: HTMLElement | null = null;
  private showHistorySuggestionsCheckbox: HTMLInputElement | null = null;
  private showBookmarkSuggestionsCheckbox: HTMLInputElement | null = null;
  private enableWheelSwitchingCheckbox: HTMLInputElement | null = null;
  private openSearchInNewTabCheckbox: HTMLInputElement | null = null;
  private bookmarksLists: HTMLElement[] = [];
  private heightSlider: HTMLInputElement | null = null;
  private heightValue: HTMLElement | null = null;
  private containerWidthSlider: HTMLInputElement | null = null;
  private containerWidthValue: HTMLElement | null = null;
  private showSearchBoxCheckbox: HTMLInputElement | null = null;
  private showWelcomeMessageCheckbox: HTMLInputElement | null = null;
  private showFooterCheckbox: HTMLInputElement | null = null;
  private showHistoryLinkCheckbox: HTMLInputElement | null = null;
  private showDownloadsLinkCheckbox: HTMLInputElement | null = null;
  private showPasswordsLinkCheckbox: HTMLInputElement | null = null;
  private showExtensionsLinkCheckbox: HTMLInputElement | null = null;

  private initialized = false;
  private themeIconIsDark: boolean | null = null;

  constructor() {
    // 设置侧栏非首屏必需：把 DOM 查询、绑定与配置读取推迟到浏览器空闲时执行
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => this.init(), { timeout: 2000 });
    } else {
      setTimeout(() => this.init(), 0);
    }
  }

  // 幂等初始化：空闲回调与用户提前打开侧栏两条路径只生效一次，避免重复绑定监听
  init() {
    if (this.initialized) return;
    this.initialized = true;
    // DOM 查询统一延迟到空闲回调，构造期只负责调度初始化
    this.settingsSidebar = document.getElementById('settings-sidebar');
    this.settingsIcon = document.querySelector<HTMLAnchorElement>('.settings-icon a');
    this.closeButton = document.querySelector('.settings-sidebar-close');
    this.tabButtons = document.querySelectorAll<HTMLElement>('.settings-tab-button');
    this.tabContents = document.querySelectorAll<HTMLElement>('.settings-tab-content');
    this.bgOptions = document.querySelectorAll<HTMLElement>('.settings-bg-option');
    this.enableQuickLinksCheckbox = getInput('enable-quick-links');
    this.openInNewTabCheckbox = getInput('open-in-new-tab');

    this.widthSlider = getInput('width-slider');
    this.widthValue = document.getElementById('width-value');
    this.widthPreviewCount = document.getElementById('width-preview-count');
    this.showHistorySuggestionsCheckbox = getInput('show-history-suggestions');
    this.showBookmarkSuggestionsCheckbox = getInput('show-bookmark-suggestions');
    this.enableWheelSwitchingCheckbox = getInput('enable-wheel-switching');
    this.openSearchInNewTabCheckbox = getInput('open-search-in-new-tab');

    this.loadSavedSettings();
    this.initEventListeners();
    this.initTheme();

    this.loadStoredSettings();
  }

  // 启动时一次批量读取全部 sync 配置，各初始化方法从共享结果取值；写入仍按各自键进行
  private loadStoredSettings(): void {
    chrome.storage.sync.get(
      [
        'enableQuickLinks',
        'openInNewTab',
        'enableWheelSwitching',
        'bookmarkWidth',
        'bookmarkCardHeight',
        'bookmarkContainerWidth',
        'bookmarkContainerHeight',
        'pageTopSpacing',
        'pageBottomSpacing',
        'showSearchBox',
        'showWelcomeMessage',
        'customWelcomeMessage',
        'showFooter',
        'showHistoryLink',
        'showDownloadsLink',
        'showPasswordsLink',
        'showExtensionsLink',
        'showHistorySuggestions',
        'showBookmarkSuggestions',
        'openSearchInNewTab',
      ],
      (stored: StoredSettings) => {
        // 与原逻辑一致：仅在对应元素存在时初始化
        if (this.enableQuickLinksCheckbox) {
          this.initQuickLinksSettings(stored);
        }
        if (this.openInNewTabCheckbox) {
          this.initLinkOpeningSettings(stored);
        }
        if (this.widthSlider && this.widthValue) {
          this.initBookmarkWidthSettings(stored);
        }
        const heightSlider = getInput('height-slider');
        const heightValue = document.getElementById('height-value');
        if (heightSlider && heightValue) {
          this.initCardHeightSettings(stored);
        }
        if (getInput('container-width-slider')) {
          this.initContainerWidthSettings(stored);
        }
        this.initContainerHeightSettings(stored);
        this.initPageSpacingSettings(stored);
        if (getInput('show-search-box') || getInput('show-welcome-message') || getInput('show-footer')) {
          this.initLayoutSettings(stored);
        }
        if (this.showHistorySuggestionsCheckbox || this.showBookmarkSuggestionsCheckbox) {
          this.initSearchSuggestionsSettings(stored);
        }
        if (this.enableWheelSwitchingCheckbox) {
          this.initWheelSwitchingTab(stored);
        }
      },
    );
  }

  initEventListeners(): void {
    const settingsIcon = this.settingsIcon;
    const settingsSidebar = this.settingsSidebar;
    if (!settingsIcon || !settingsSidebar) return;

    // 打开设置侧边栏
    settingsIcon.addEventListener('click', (e) => {
      e.preventDefault();
      this.openSettingsSidebar();
    });

    // 关闭设置侧边栏
    if (this.closeButton) {
      this.closeButton.addEventListener('click', () => {
        this.closeSettingsSidebar();

        // 关闭侧边栏时更新欢迎消息
        if (window.WelcomeManager) {
          window.WelcomeManager.updateWelcomeMessage();
        }
      });
    }

    // 标签切换
    this.tabButtons?.forEach(button => {
      button.addEventListener('click', () => {
        const tabName = button.getAttribute('data-tab');
        this.switchTab(tabName);
      });
    });

    // 背景颜色选择
    this.bgOptions?.forEach(option => {
      option.addEventListener('click', () => this.handleBackgroundChange(option));
    });

    // 添加键盘事件监听，按ESC关闭侧边栏
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.settingsSidebar && this.settingsSidebar.classList.contains('open')) {
        this.closeSettingsSidebar();
      }
    });

    // 添加点击侧边栏外部关闭功能
    document.addEventListener('click', (e) => {
      // 如果侧边栏已打开，且点击的不是侧边栏内部元素
      if (this.settingsSidebar &&
          this.settingsSidebar.classList.contains('open') &&
          e.target instanceof Node &&
          !settingsSidebar.contains(e.target) &&
          !settingsIcon.contains(e.target)) {
        this.closeSettingsSidebar();

        // 关闭侧边栏时更新欢迎消息
        if (window.WelcomeManager) {
          window.WelcomeManager.updateWelcomeMessage();
        }
      }
    });

    // 阻止侧边栏内部点击事件冒泡到文档
    settingsSidebar.addEventListener('click', (e) => {
      // 如果点击的是链接，不阻止事件冒泡
      if (e.target instanceof Element && (e.target.tagName === 'A' || e.target.closest('a'))) {
        return; // 允许链接点击事件正常传播
      }
      e.stopPropagation();
    });

    // 阻止设置图标点击事件冒泡到文档
    settingsIcon.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // 打开设置侧边栏
  openSettingsSidebar(): void {
    // 空闲初始化完成前用户就打开侧栏时同步补初始化，避免点击静默失效
    if (!this.settingsSidebar) {
      this.init();
    }
    if (this.settingsSidebar) {
      this.settingsSidebar.classList.add('open');
      document.getElementById('settings-overlay')?.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  // 关闭设置侧边栏
  closeSettingsSidebar(): void {
    if (this.settingsSidebar) {
      this.settingsSidebar.classList.remove('open');
      document.getElementById('settings-overlay')?.classList.remove('open');
      document.body.style.overflow = '';
    }
  }

  switchTab(tabName: string | null): void {
    if (!tabName) return;
    // 移除所有标签的 active 类
    this.tabButtons?.forEach(button => {
      button.classList.remove('active');
    });

    // 移除所有内容的 active 类
    this.tabContents?.forEach(content => {
      content.classList.remove('active');
    });

    // 添加当前标签的 active 类
    const selectedButton = document.querySelector(`[data-tab="${tabName}"]`);
    const selectedContent = document.getElementById(`${tabName}-settings`);

    if (selectedButton && selectedContent) {
      selectedButton.classList.add('active');
      selectedContent.classList.add('active');
      // 更新 UI 语言
      window.updateUILanguage();

      // 确保欢迎消息也被更新
      if (window.WelcomeManager) {
        window.WelcomeManager.updateWelcomeMessage();
      }
    }
  }

  handleBackgroundChange(option: HTMLElement): void {
    const bgClass = option.getAttribute('data-bg');
    if (!bgClass) return;

    // 移除所有背景选项的 active 状态
    this.bgOptions?.forEach(opt => opt.classList.remove('active'));

    // 添加当前选项的 active 状态
    option.classList.add('active');

    document.documentElement.className = bgClass;
    localStorage.setItem('selectedBackground', bgClass);
    localStorage.setItem('useDefaultBackground', 'true');

    // 清除壁纸相关的状态
    this.clearWallpaper();

    // 更新欢迎消息
    if (window.WelcomeManager) {
      window.WelcomeManager.updateWelcomeMessage();
    }
  }

  clearWallpaper(): void {
    document.querySelectorAll<HTMLElement>('.wallpaper-option').forEach(opt => {
      opt.classList.remove('active');
    });

    const mainElement = document.querySelector<HTMLElement>('main');
    if (mainElement) {
      mainElement.style.backgroundImage = 'none';
      document.body.style.backgroundImage = 'none';
    }
    localStorage.removeItem('originalWallpaper');

    // 更新欢迎消息颜色
    const welcomeElement = document.getElementById('welcome-message');
    if (welcomeElement && window.WelcomeManager) {
      window.WelcomeManager.adjustTextColor(welcomeElement);
    }
  }

  loadSavedSettings(): void {
    // 加载背景设置
    const savedBg = localStorage.getItem('selectedBackground');
    if (savedBg) {
      document.documentElement.className = savedBg;
      this.bgOptions?.forEach(option => {
        if (option.getAttribute('data-bg') === savedBg) {
          option.classList.add('active');
        }
      });
    }
  }

  initTheme(): void {
    const themeSelect = getSelect('theme-select');
    if (!themeSelect) return;
    const savedTheme = localStorage.getItem('theme') || 'auto';

    // 设置下拉菜单的初始值
    themeSelect.value = savedTheme;

    // 如果是自动模式，根据系统主题设置初始主题
    if (savedTheme === 'auto') {
      this.setThemeBasedOnSystem();
    } else {
      document.documentElement.setAttribute('data-theme', savedTheme);
      this.updateThemeIcon(savedTheme === 'dark');
    }

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (localStorage.getItem('theme') === 'auto') {
        const isDark = e.matches;
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        this.updateThemeIcon(isDark);
      }
    });

    // 监听主题选择变化
    themeSelect.addEventListener('change', () => {
      const selectedTheme = themeSelect.value;
      localStorage.setItem('theme', selectedTheme);

      if (selectedTheme === 'auto') {
        this.setThemeBasedOnSystem();
      } else {
        document.documentElement.setAttribute('data-theme', selectedTheme);
        this.updateThemeIcon(selectedTheme === 'dark');
      }
    });

    // 保留原有的主题切换按钮功能
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        themeSelect.value = newTheme;

        this.updateThemeIcon(newTheme === 'dark');
      });
    }
  }

  setThemeBasedOnSystem(): void {
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = isDarkMode ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeIcon(isDarkMode);
  }

  updateThemeIcon(isDark: boolean): void {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (!themeToggleBtn) return;
    // 图标未变化时不重写 innerHTML，避免每次主题切换重建 SVG 节点
    if (this.themeIconIsDark === isDark) return;
    this.themeIconIsDark = isDark;
    themeToggleBtn.innerHTML = isDark ? ICONS.dark_mode : ICONS.light_mode;
  }

  initQuickLinksSettings(stored: StoredSettings): void {
    const checkbox = this.enableQuickLinksCheckbox;
    if (!checkbox) return;

    checkbox.checked = getStoredBoolean(stored, 'enableQuickLinks', true);
    this.toggleQuickLinksVisibility(checkbox.checked);

    // 监听快捷链接设置变化
    checkbox.addEventListener('change', () => {
      const isEnabled = checkbox.checked;
      chrome.storage.sync.set({ enableQuickLinks: isEnabled }, () => {
        this.toggleQuickLinksVisibility(isEnabled);
      });
    });
  }

  toggleQuickLinksVisibility(show: boolean): void {
    const quickLinksWrapper = document.querySelector<HTMLElement>('.quick-links-wrapper');
    if (quickLinksWrapper) {
      quickLinksWrapper.style.display = show ? 'flex' : 'none';
    }
  }

  initLinkOpeningSettings(stored: StoredSettings): void {
    // 检查元素是否存在
    const checkbox = this.openInNewTabCheckbox;
    if (!checkbox) {
      console.log('openInNewTabCheckbox not found, skipping settings initialization');
      return;
    }

    checkbox.checked = getStoredBoolean(stored, 'openInNewTab', true);

    // 监听设置变化
    checkbox.addEventListener('change', () => {
      const isEnabled = checkbox.checked;
      chrome.storage.sync.set({ openInNewTab: isEnabled });
    });

  }

  initWheelSwitchingTab(stored: StoredSettings): void {
    // 标签按钮的 click 已由 initEventListeners 的通用 .settings-tab-button 绑定处理，这里不再重复绑定
    const checkbox = this.enableWheelSwitchingCheckbox;
    if (!checkbox) return;

    checkbox.checked = getStoredBoolean(stored, 'enableWheelSwitching', false);

    checkbox.addEventListener('change', () => {
      const isEnabled = checkbox.checked;
      chrome.storage.sync.set({ enableWheelSwitching: isEnabled });

      // 触发自定义事件，通知滚轮切换状态变化
      document.dispatchEvent(new CustomEvent('wheelSwitchingChanged', {
        detail: { enabled: isEnabled }
      }));
    });
  }

  // 添加 debounce 方法来优化性能
  debounce(func: () => void, wait: number): () => void {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function executedFunction(): void {
      const later = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        func();
      };
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  initBookmarkWidthSettings(stored: StoredSettings): void {
    // 获取元素引用
    this.widthSlider = getInput('width-slider');
    this.widthValue = document.getElementById('width-value');
    this.widthPreviewCount = document.getElementById('width-preview-count');

    if (!this.widthSlider || !this.widthValue) {
      console.log('Width slider elements not found, skipping bookmark width settings initialization');
      return;
    }
    const slider = this.widthSlider;
    const valueElement = this.widthValue;

    const savedWidth = getStoredDimension(stored, 'bookmarkWidth', 190); // 默认190px
    slider.value = String(savedWidth);
    valueElement.textContent = String(savedWidth);
    this.updatePreviewCount(savedWidth);
    this.updateBookmarkWidth(savedWidth);

    // 监听滑块的变化：拖动为高频事件，用 rAF 合帧，一帧最多执行一次预览与宽度更新
    slider.addEventListener('input', coalesceInputFrame(() => {
      const width = slider.value;
      valueElement.textContent = width;
      this.updatePreviewCount(width);
      this.updateBookmarkWidth(width);
    }));

    // 监听滑块的鼠标释放事件
    slider.addEventListener('mouseup', () => {
      // 保存设置
      chrome.storage.sync.set({ bookmarkWidth: slider.value });
    });

    // 添加窗口大小改变的监听：侧栏未打开时无需刷新预览
    const debouncedUpdate = this.debounce(() => {
      if (!this.settingsSidebar || !this.settingsSidebar.classList.contains('open')) {
        return;
      }
      this.updatePreviewCount(slider.value);
    }, 250);
    window.addEventListener('resize', debouncedUpdate);
  }

  // 新增书签卡片高度设置函数
  initCardHeightSettings(stored: StoredSettings): void {
    // 获取滑块和显示元素
    this.heightSlider = getInput('height-slider');
    this.heightValue = document.getElementById('height-value');

    if (!this.heightSlider || !this.heightValue) {
      console.log('Height slider elements not found, skipping card height settings initialization');
      return;
    }
    const slider = this.heightSlider;
    const valueElement = this.heightValue;

    const savedHeight = getStoredDimension(stored, 'bookmarkCardHeight', 48); // 默认值为48px
    slider.value = String(savedHeight);
    valueElement.textContent = String(savedHeight);
    this.updateCardHeight(savedHeight);

    // 监听滑块的变化：与宽度滑块一致，用 rAF 合帧避免高频样式重算
    slider.addEventListener('input', coalesceInputFrame(() => {
      const height = slider.value;
      valueElement.textContent = height;
      this.updateCardHeight(height);
    }));

    // 监听滑块的鼠标释放事件
    slider.addEventListener('mouseup', () => {
      // 保存设置
      chrome.storage.sync.set({ bookmarkCardHeight: slider.value });
    });
  }

  // 更新书签卡片高度
  updateCardHeight(height: Dimension): void {
    // 创建或更新自定义样式
    let styleElement = document.getElementById('custom-card-height');
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = 'custom-card-height';
      document.head.appendChild(styleElement);
    }

    // 设置卡片高度
    styleElement.textContent = `
      .card {
        height: ${height}px !important;
      }
    `;
  }

  updatePreviewCount(width: Dimension): void {
    // 获取书签列表容器
    const bookmarksList = getActiveBookmarksList();
    if (!bookmarksList) return;

    // 单次读取计算样式即可：padding 与 display 无关，offsetWidth 也只读一次复用
    const originalDisplay = bookmarksList.style.display;
    const containerStyle = getComputedStyle(bookmarksList);
    if (containerStyle.display === 'none') {
      bookmarksList.style.display = 'grid';
    }
    const containerWidth = bookmarksList.offsetWidth
      - parseFloat(containerStyle.paddingLeft)
      - parseFloat(containerStyle.paddingRight);

    // 还原容器显示状态
    bookmarksList.style.display = originalDisplay;

    // 使用与 CSS Grid 相同的计算逻辑
    const gap = 16; // gap: 1rem
    const minWidth = parseInt(String(width), 10);

    // 计算一行能容纳的最大数量
    // 使用 Math.floor 确保不会超出容器宽度
    const count = Math.floor((containerWidth + gap) / (minWidth + gap));

    // 更新显示 - 使用本地化文本
    const previewText = chrome.i18n.getMessage("bookmarksPerRow", [String(count)]) || `${count} 个/行`;
    if (this.widthPreviewCount) this.widthPreviewCount.textContent = previewText;
  }

  // 缓存 .bookmarks-list 引用：folder swiper 重建会替换列表节点，缓存失联时才重新查询
  private getBookmarksLists(): HTMLElement[] {
    const cached = this.bookmarksLists;
    if (cached.length > 0 && cached.every((list) => list.isConnected)) {
      return cached;
    }
    this.bookmarksLists = Array.from(document.querySelectorAll<HTMLElement>('.bookmarks-list'));
    return this.bookmarksLists;
  }

  updateBookmarkWidth(width: Dimension): void {
    // 更新CSS变量
    document.documentElement.style.setProperty('--bookmark-width', width + 'px');

    for (const list of this.getBookmarksLists()) {
      list.style.gridTemplateColumns = `repeat(auto-fit, minmax(${width}px, 1fr))`;
      list.style.gap = '1rem';
    }
  }

  initContainerWidthSettings(stored: StoredSettings): void {
    // 获取元素引用
    this.containerWidthSlider = getInput('container-width-slider');
    this.containerWidthValue = document.getElementById('container-width-value');

    if (!this.containerWidthSlider || !this.containerWidthValue) {
      console.log('Container width slider elements not found, skipping container width settings initialization');
      return;
    }
    const slider = this.containerWidthSlider;
    const valueElement = this.containerWidthValue;

    const savedWidth = getStoredDimension(stored, 'bookmarkContainerWidth', 85); // 默认85%
    slider.value = String(savedWidth);
    valueElement.textContent = String(savedWidth);
    this.updateContainerWidth(savedWidth);

    // 监听滑块的变化
    slider.addEventListener('input', () => {
      const width = slider.value;
      valueElement.textContent = width;
      this.updateContainerWidth(width);
    });

    // 监听滑块的鼠标释放事件，保存设置
    slider.addEventListener('mouseup', () => {
      // 保存设置
      chrome.storage.sync.set({ bookmarkContainerWidth: slider.value });
    });
  }

  // 更新书签容器宽度的方法
  updateContainerWidth(widthPercent: Dimension): void {
    document.documentElement.style.setProperty('--bookmark-container-width', `${widthPercent}%`);
    document.querySelectorAll<HTMLElement>('.bookmarks-container').forEach((container) => {
      container.style.width = `${widthPercent}%`;
    });
  }

  initContainerHeightSettings(stored: StoredSettings): void {
    this.bindPxSlider(
      stored,
      'container-height-slider',
      'container-height-value',
      'bookmarkContainerHeight',
      100,
      (height) => this.updateContainerHeight(height),
    );
  }

  updateContainerHeight(heightPercent: Dimension): void {
    document.documentElement.style.setProperty('--bookmark-container-height', `${heightPercent}%`);
  }

  initPageSpacingSettings(stored: StoredSettings): void {
    this.bindPxSlider(stored, 'page-top-spacing-slider', 'page-top-spacing-value', 'pageTopSpacing', 96, (px) => {
      document.documentElement.style.setProperty('--page-top-spacing', `${px}px`);
    });
    this.bindPxSlider(stored, 'page-bottom-spacing-slider', 'page-bottom-spacing-value', 'pageBottomSpacing', 32, (px) => {
      document.documentElement.style.setProperty('--page-bottom-spacing', `${px}px`);
    });
  }

  bindPxSlider(
    stored: StoredSettings,
    sliderId: string,
    valueId: string,
    storageKey: string,
    defaultValue: number,
    apply: (value: Dimension) => void,
  ): void {
    const slider = getInput(sliderId);
    const valueElement = document.getElementById(valueId);
    if (!slider || !valueElement) {
      return;
    }

    const saved = getStoredDimension(stored, storageKey, defaultValue);
    slider.value = String(saved);
    valueElement.textContent = String(saved);
    apply(saved);

    slider.addEventListener('input', () => {
      valueElement.textContent = slider.value;
      apply(slider.value);
    });

    slider.addEventListener('change', () => {
      chrome.storage.sync.set({ [storageKey]: slider.value });
    });
  }

  initLayoutSettings(stored: StoredSettings): void {
    // 获取元素引用
    this.showSearchBoxCheckbox = getInput('show-search-box');
    this.showWelcomeMessageCheckbox = getInput('show-welcome-message');
    this.showFooterCheckbox = getInput('show-footer');

    // 添加快捷链接图标的设置
    this.showHistoryLinkCheckbox = getInput('show-history-link');
    this.showDownloadsLinkCheckbox = getInput('show-downloads-link');
    this.showPasswordsLinkCheckbox = getInput('show-passwords-link');
    this.showExtensionsLinkCheckbox = getInput('show-extensions-link');

    const showSearchBoxCheckbox = this.showSearchBoxCheckbox;
    const showWelcomeMessageCheckbox = this.showWelcomeMessageCheckbox;
    const showFooterCheckbox = this.showFooterCheckbox;
    const showHistoryLinkCheckbox = this.showHistoryLinkCheckbox;
    const showDownloadsLinkCheckbox = this.showDownloadsLinkCheckbox;
    const showPasswordsLinkCheckbox = this.showPasswordsLinkCheckbox;
    const showExtensionsLinkCheckbox = this.showExtensionsLinkCheckbox;
    if (
      !showSearchBoxCheckbox ||
      !showWelcomeMessageCheckbox ||
      !showFooterCheckbox ||
      !showHistoryLinkCheckbox ||
      !showDownloadsLinkCheckbox ||
      !showPasswordsLinkCheckbox ||
      !showExtensionsLinkCheckbox
    ) return;

    const showSearchBox = getStoredBoolean(stored, 'showSearchBox', false);
    const showWelcomeMessage = getStoredBoolean(stored, 'showWelcomeMessage', true);
    const showFooter = getStoredBoolean(stored, 'showFooter', true);
    const showHistoryLink = getStoredBoolean(stored, 'showHistoryLink', true);
    const showDownloadsLink = getStoredBoolean(stored, 'showDownloadsLink', true);
    const showPasswordsLink = getStoredBoolean(stored, 'showPasswordsLink', true);
    const showExtensionsLink = getStoredBoolean(stored, 'showExtensionsLink', true);

    // 设置复选框状态 - 修改搜索框的默认值为 false
    showSearchBoxCheckbox.checked = showSearchBox; // 默认为 false
    showWelcomeMessageCheckbox.checked = showWelcomeMessage;
    showFooterCheckbox.checked = showFooter;

    // 设置快捷链接图标的状态
    showHistoryLinkCheckbox.checked = showHistoryLink;
    showDownloadsLinkCheckbox.checked = showDownloadsLink;
    showPasswordsLinkCheckbox.checked = showPasswordsLink;
    showExtensionsLinkCheckbox.checked = showExtensionsLink;

    // 应用设置到界面
    this.toggleElementVisibility('#history-link', showHistoryLink);
    this.toggleElementVisibility('#downloads-link', showDownloadsLink);
    this.toggleElementVisibility('#passwords-link', showPasswordsLink);
    this.toggleElementVisibility('#extensions-link', showExtensionsLink);

    // 检查是否所有链接都被隐藏
    const linksContainer = document.querySelector<HTMLElement>('.links-icons');
    if (linksContainer) {
      const allLinksHidden =
        !showHistoryLink &&
        !showDownloadsLink &&
        !showPasswordsLink &&
        !showExtensionsLink;

      linksContainer.style.display = allLinksHidden ? 'none' : '';
    }

    // 监听设置变化
    showSearchBoxCheckbox.addEventListener('change', () => {
      const isVisible = showSearchBoxCheckbox.checked;
      chrome.storage.sync.set({ showSearchBox: isVisible });

      // 立即应用设置
      const searchContainer = document.querySelector<HTMLElement>('.search-container');
      if (searchContainer) {
        searchContainer.style.display = isVisible ? '' : 'none';
      }

      // 立即更新欢迎语显示
      if (window.WelcomeManager) {
        window.WelcomeManager.updateWelcomeMessage();
      }
    });

    showWelcomeMessageCheckbox.addEventListener('change', () => {
      const isVisible = showWelcomeMessageCheckbox.checked;
      chrome.storage.sync.set({ showWelcomeMessage: isVisible });

      // 立即应用设置
      const welcomeMessage = document.getElementById('welcome-message');
      if (welcomeMessage) {
        welcomeMessage.style.display = isVisible ? '' : 'none';
      }
    });

    // 自定义欢迎语：输入防抖落盘，welcome 模块经 storage.onChanged 即时应用
    const customWelcomeInput = getInput('custom-welcome-message');
    if (customWelcomeInput) {
      customWelcomeInput.value = getStoredString(stored, 'customWelcomeMessage');
      customWelcomeInput.addEventListener(
        'input',
        debounce({ delay: 300 }, () => {
          chrome.storage.sync.set({ customWelcomeMessage: customWelcomeInput.value.trim() });
        }),
      );
    }

    showFooterCheckbox.addEventListener('change', () => {
      const isVisible = showFooterCheckbox.checked;
      chrome.storage.sync.set({ showFooter: isVisible });

      // 立即应用设置
      const footer = document.querySelector<HTMLElement>('footer');
      if (footer) {
        footer.style.display = isVisible ? '' : 'none';
      }
    });

    // 添加事件监听器
    showHistoryLinkCheckbox.addEventListener('change', () => {
      const isVisible = showHistoryLinkCheckbox.checked;
      chrome.storage.sync.set({ showHistoryLink: isVisible });
      this.toggleElementVisibility('#history-link', isVisible);
    });

    showDownloadsLinkCheckbox.addEventListener('change', () => {
      const isVisible = showDownloadsLinkCheckbox.checked;
      chrome.storage.sync.set({ showDownloadsLink: isVisible });
      this.toggleElementVisibility('#downloads-link', isVisible);
    });

    showPasswordsLinkCheckbox.addEventListener('change', () => {
      const isVisible = showPasswordsLinkCheckbox.checked;
      chrome.storage.sync.set({ showPasswordsLink: isVisible });
      this.toggleElementVisibility('#passwords-link', isVisible);
    });

    showExtensionsLinkCheckbox.addEventListener('change', () => {
      const isVisible = showExtensionsLinkCheckbox.checked;
      chrome.storage.sync.set({ showExtensionsLink: isVisible });
      this.toggleElementVisibility('#extensions-link', isVisible);
    });
  }

  // 辅助方法：切换元素可见性
  toggleElementVisibility(selector: string, isVisible: boolean): void {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      element.style.display = isVisible ? '' : 'none';

      // 特殊处理 links-icons 容器
      if (selector.includes('link')) {
        const linksContainer = document.querySelector<HTMLElement>('.links-icons');
        if (linksContainer) {
          // 检查是否所有链接都被隐藏
          const visibleLinks = Array.from(linksContainer.querySelectorAll<HTMLAnchorElement>('a')).filter(
            link => link.style.display !== 'none'
          ).length;

          linksContainer.style.display = visibleLinks === 0 ? 'none' : '';
        }
      }
    }
  }

  initSearchSuggestionsSettings(stored: StoredSettings): void {
    // 获取元素引用
    this.showHistorySuggestionsCheckbox = getInput('show-history-suggestions');
    this.showBookmarkSuggestionsCheckbox = getInput('show-bookmark-suggestions');
    this.openSearchInNewTabCheckbox = getInput('open-search-in-new-tab');
    const historyCheckbox = this.showHistorySuggestionsCheckbox;
    const bookmarkCheckbox = this.showBookmarkSuggestionsCheckbox;
    const newTabCheckbox = this.openSearchInNewTabCheckbox;
    if (!historyCheckbox || !bookmarkCheckbox || !newTabCheckbox) return;

    // 如果设置不存在(undefined)或者没有明确设置为 false,则默认为 true
    historyCheckbox.checked = getStoredBoolean(stored, 'showHistorySuggestions', true);
    bookmarkCheckbox.checked = getStoredBoolean(stored, 'showBookmarkSuggestions', true);
    newTabCheckbox.checked = getStoredBoolean(stored, 'openSearchInNewTab', true);

    // 初始化时如果是新用户(设置不存在),则保存默认值：缺失项合并为一次写入
    const defaults: {
      showHistorySuggestions?: boolean;
      showBookmarkSuggestions?: boolean;
      showSearchBox?: boolean;
      openSearchInNewTab?: boolean;
    } = {};
    if (!Object.hasOwn(stored, 'showHistorySuggestions')) {
      defaults.showHistorySuggestions = true;
    }
    if (!Object.hasOwn(stored, 'showBookmarkSuggestions')) {
      defaults.showBookmarkSuggestions = true;
    }
    if (!Object.hasOwn(stored, 'showSearchBox')) {
      defaults.showSearchBox = false;
    }
    if (!Object.hasOwn(stored, 'openSearchInNewTab')) {
      defaults.openSearchInNewTab = true;
    }
    if (Object.keys(defaults).length > 0) {
      chrome.storage.sync.set(defaults);
    }

    // 监听设置变化
    historyCheckbox.addEventListener('change', () => {
      const isEnabled = historyCheckbox.checked;
      chrome.storage.sync.set({ showHistorySuggestions: isEnabled });
    });

    bookmarkCheckbox.addEventListener('change', () => {
      const isEnabled = bookmarkCheckbox.checked;
      chrome.storage.sync.set({ showBookmarkSuggestions: isEnabled });
    });

    newTabCheckbox.addEventListener('change', () => {
      const isEnabled = newTabCheckbox.checked;
      chrome.storage.sync.set({ openSearchInNewTab: isEnabled });
    });
  }

}

// 导出设置管理器实例
export const settingsManager = new SettingsManager();

document.addEventListener('markstart:open-settings', () => settingsManager.openSettingsSidebar());
