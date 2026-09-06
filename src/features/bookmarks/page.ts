import { featureTips } from '../onboarding/feature-tips';
import { debounce } from 'radashi';
import Sortable from 'sortablejs';
import { createBookmarkCache } from './bookmark-cache';
import { getCachedCardColors, setCachedCardColors } from './card-colors';
import { createBookmarkQrCode } from './qr-modal';
import { getBookmarksBarId } from './root';
import { pruneDefaultFolders } from './default-folders';
import { initGestureNavigation } from './gesture-navigation';
import {
  createFolderSwiper,
  getActiveBookmarksContainer,
  getActiveBookmarksList,
  getActiveFolderName,
  queryBookmarksList,
  type FolderSwiperHandle,
  type PinnedFolderSlide,
} from './folder-swiper';
import { applySavedBackgroundColor } from '../wallpaper/background';
import {
  getBooleanProperty,
  getDefaultFolders,
  getNumberProperty,
  getOpenMultipleTabsResponse,
  isUnknownRecord,
} from './page-parsers';
import type { BookmarkColors } from './page-parsers';
import { getIconHtml, ICONS, replaceIconsWithSvg } from '../../shared/icons';
import { createFaviconUrl } from '../../shared/favicon';
import { updateBookmarkCard } from './card-update';
import { refreshBookmarkOrder, startBookmarkChangeSync } from './order-sync';
import { initializeSearchInteractions } from '../search/interactions';
import {
  SearchEngineManager,
  updateSearchEngineIcon,
  setSearchEngineIcon,
  createSearchEngineDropdown,
  initializeSearchEngineDialog,
  createTemporarySearchTabs
} from '../search/dropdown';

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode;
type QuickLink = {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly icon?: string;
};
type CurrentBookmark = (BookmarkNode | QuickLink) & { readonly type?: string };
type DeleteTarget = {
  readonly type: 'bookmark' | 'quickLink';
  readonly data: CurrentBookmark;
};
type BookmarkDisplay = {
  readonly id: string;
  readonly children?: readonly BookmarkNode[];
};
type FolderSlide = PinnedFolderSlide;
type FolderSlideSelection = {
  readonly slides: readonly FolderSlide[];
  readonly temporary: FolderSlide | undefined;
};
declare global {
  interface Window {
    updateBookmarksDisplay(parentId: string, movedItemId?: string, newIndex?: number): Promise<void>;
  }
}

declare function deleteQuickLink(quickLink: CurrentBookmark): void;
declare function updateContainerHeight(): void;

type ElementConstructor<T extends Element> = new () => T;

function requireElement<T extends Element>(
  element: Element | null,
  constructor: ElementConstructor<T>,
  description: string,
): T {
  if (!(element instanceof constructor)) {
    throw new TypeError(`Missing or invalid ${description}`);
  }
  return element;
}

let bookmarkTreeNodes: BookmarkNode[] = [];
let defaultSearchEngine = 'google';
let contextMenu: HTMLElement | null = null;
let currentBookmark: CurrentBookmark | null = null;
let folderSwiper: FolderSwiperHandle | null = null;
let wheelSwitchingInitialized = false;
let pinnedFolderSlides: readonly FolderSlide[] = [];
let temporaryFolderSlide: FolderSlide | undefined;
const folderNameUpdateVersions = new WeakMap<HTMLElement, number>();

// 使用单一的状态变量
let itemToDelete: DeleteTarget | null = null;

// Define and initialize the variables
let bookmarkFolderContextMenu: HTMLElement | null = null;
let currentBookmarkFolder: HTMLElement | null = null;

// 编辑书签对话框函数
function openEditDialog(bookmark: CurrentBookmark) {
  const bookmarkId = bookmark.id;
  const bookmarkTitle = bookmark.title;
  const bookmarkUrl = bookmark.url ?? '';

  const editNameInput = requireElement(document.getElementById('edit-name'), HTMLInputElement, '#edit-name');
  const editUrlInput = requireElement(document.getElementById('edit-url'), HTMLInputElement, '#edit-url');
  const editDialog = requireElement(document.getElementById('edit-dialog'), HTMLElement, '#edit-dialog');
  const editForm = requireElement(document.getElementById('edit-form'), HTMLFormElement, '#edit-form');
  const cancelButton = requireElement(document.querySelector('.cancel-button'), HTMLElement, '.cancel-button');
  const closeButton = requireElement(document.querySelector('.close-button'), HTMLElement, '.close-button');

  editNameInput.value = bookmarkTitle;
  editUrlInput.value = bookmarkUrl;
  editDialog.style.display = 'block';

  // 设置提交事件
  editForm.onsubmit = function (event) {
    event.preventDefault();
    const newTitle = editNameInput.value;
    const newUrl = editUrlInput.value;
    chrome.bookmarks.update(bookmarkId, { title: newTitle, url: newUrl }, function () {
      if (chrome.runtime.lastError) {
        console.error('Error updating bookmark:', chrome.runtime.lastError);
        return;
      }
      editDialog.style.display = 'none';

      if ('parentId' in bookmark) {
        bookmarksCache.delete(bookmark.parentId);
      }
      updateBookmarkCard(bookmarkId, newTitle, newUrl, { getColors, applyColors });
    });
  };

  // 添加取消按钮的事件监听
  cancelButton.addEventListener('click', function () {
    editDialog.style.display = 'none';
  });

  // 添加关闭按钮的事件监听
  closeButton.addEventListener('click', function () {
    editDialog.style.display = 'none';
  });
}

document.addEventListener('DOMContentLoaded', function () {
  // 初始化手势导航，传入 updateBookmarksDisplay 函数
  initGestureNavigation(updateBookmarksDisplay);
   // 初始化功能提示
  featureTips.initAllTips();
  // 替换所有图标
  replaceIconsWithSvg();

  // 或者在动态创建元素时使用
  const button = document.createElement('button');
  button.innerHTML = getIconHtml('settings') + ' Settings';

  // 更新这部分代码
  updateSearchEngineIcon(defaultSearchEngine);

  const searchEngineIcon = document.getElementById('search-engine-icon');
  if (searchEngineIcon instanceof HTMLImageElement && searchEngineIcon.src === '') {
    searchEngineIcon.src = '../images/placeholder-icon.svg';
  }
});

function getLocalizedMessage(messageName: string) {
  const message = chrome.i18n.getMessage(messageName);
  return message || messageName;
}

// Define the context menu creation function
function createContextMenu() {
  console.log('Creating context menu');

  // 移除任何已存在的上下文菜单
  const existingMenu = document.querySelector<HTMLElement>('.custom-context-menu');
  if (existingMenu) {
    existingMenu.remove();
  }

  const menu = document.createElement('div');
  menu.className = 'custom-context-menu';
  document.body.appendChild(menu);

  const menuItems = [
    { text: getLocalizedMessage('openInNewTab'), icon: 'open_in_new', action: () => currentBookmark?.url && window.open(currentBookmark.url, '_blank') },
    { text: getLocalizedMessage('openInNewWindow'), icon: 'launch', action: () => currentBookmark?.url && openInNewWindow(currentBookmark.url) },
    { text: getLocalizedMessage('openInIncognito'), icon: 'visibility_off', action: () => currentBookmark?.url && openInIncognito(currentBookmark.url) },
    { text: getLocalizedMessage('editQuickLink'), icon: 'edit', action: () => currentBookmark && openEditDialog(currentBookmark) },
    {
      text: getLocalizedMessage('deleteQuickLink'),
      icon: 'delete',
      action: () => {
        console.log('Delete action triggered. Current item:', currentBookmark);

        if (!currentBookmark) {
          console.error('No item selected for deletion');
          return;
        }

        itemToDelete = {
          type: currentBookmark.type === 'quickLink' ? 'quickLink' : 'bookmark',
          data: {
            id: currentBookmark.id,
            title: currentBookmark.title,
            url: currentBookmark.url ?? ''
          }
        };

        console.log('Set itemToDelete:', itemToDelete);

        const message = itemToDelete.type === 'quickLink'
          ? chrome.i18n.getMessage("confirmDeleteQuickLink", [`<strong>${itemToDelete.data.title}</strong>`])
          : chrome.i18n.getMessage("confirmDeleteBookmark", [`<strong>${itemToDelete.data.title}</strong>`]);

        showConfirmDialog(message, () => {
          if (itemToDelete && itemToDelete.data) {
            if (itemToDelete.type === 'quickLink') {
              deleteQuickLink(itemToDelete.data);
            } else {
              deleteBookmark(itemToDelete.data.id, itemToDelete.data.title);
            }
          }
        });
      }
    },
    { text: getLocalizedMessage('copyLink'), icon: 'content_copy', action: () => currentBookmark && Utilities.copyBookmarkLink(currentBookmark) },
    { text: getLocalizedMessage('createQRCode'), icon: 'qr_code', action: () => currentBookmark?.url && createBookmarkQrCode(currentBookmark.url, currentBookmark.title, getLocalizedMessage) }
  ];

  menuItems.forEach((item, index) => {
    // 在特定位置添加分隔线
    if (index === 3 || index === 5) {
      const divider = document.createElement('div');
      divider.className = 'custom-context-menu-divider';
      menu.appendChild(divider);
    }

    const menuItem = document.createElement('div');
    menuItem.className = 'custom-context-menu-item';

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.innerHTML = getIconHtml(item.icon);
    icon.style.marginRight = '8px';
    icon.style.fontSize = '18px';

    const text = document.createElement('span');
    text.textContent = item.text;

    menuItem.appendChild(icon);
    menuItem.appendChild(text);

    menuItem.addEventListener('click', () => {
      if (typeof item.action === 'function') {
        item.action();
      }
      menu.style.display = 'none';
    });

    menu.appendChild(menuItem);
  });

  return menu;
}

applySavedBackgroundColor();

// 文件夹卡颜色是恒定默认值（无 favicon 可采样），直接应用即可；
// 书签卡颜色走 card-colors.ts 的内存缓存 + 延迟落盘，不再有第二套 localStorage 缓存

const DEFAULT_FOLDER_COLORS: BookmarkColors = {
  primary: [230, 230, 230],
  secondary: [240, 240, 240],
};

function scheduleIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => callback());
  } else {
    setTimeout(callback, 0);
  }
}



// 页面加载时更新图标
document.addEventListener('DOMContentLoaded', () => {
  const defaultEngine = SearchEngineManager.getDefaultEngine();
  if (defaultEngine) {
    updateSearchEngineIcon(defaultEngine);
  }
});

// 同样，将这个函数也移到全作用域


// 合并 DOMContentLoaded 事件监听器
document.addEventListener('DOMContentLoaded', function() {
  const activeContainer = getActiveBookmarksContainer();
  const activeList = getActiveBookmarksList();
  if (activeContainer && activeList) ensureScrollIndicator(activeContainer, activeList);

  // 其他初始化代码...
  startBookmarkSync();
  setupSpecialLinks();
  console.log('[Init] Starting initialization...');

  // 只调用一次搜索引擎初始化
  createSearchEngineDropdown();
  initializeSearchEngineDialog();



  // 加载保存的背景颜色
  const savedBg = localStorage.getItem('selectedBackground');
  const useDefaultBackground = localStorage.getItem('useDefaultBackground');
  const hasWallpaper = localStorage.getItem('originalWallpaper');

  console.log('[Background] Initial load state:', {
    savedBg,
    useDefaultBackground,
    hasWallpaper
  });

  // 清除所有选项的 active 状态
  document.querySelectorAll<HTMLElement>('.settings-bg-option').forEach(opt => {
    opt.classList.remove('active');
  });

  if (savedBg) {
    if (useDefaultBackground === 'true') {
      console.log('[Background] Activating saved background color:', savedBg);
      document.documentElement.className = savedBg;
      const activeOption = document.querySelector<HTMLElement>(`[data-bg="${savedBg}"]`);
      if (activeOption) {
        activeOption.classList.add('active');
      }
    } else if (hasWallpaper) {
      console.log('[Background] Wallpaper is active, keeping background options unselected');
    }
  } else {
    console.log('[Background] No saved background, checking wallpaper state');
    if (!hasWallpaper && useDefaultBackground !== 'false') {
      console.log('[Background] No wallpaper, using default background');
      document.documentElement.className = 'gradient-background-7';
      const defaultOption = document.querySelector<HTMLElement>('[data-bg="gradient-background-7"]');
      if (defaultOption) {
        defaultOption.classList.add('active');
      }
    } else {
      console.log('[Background] Wallpaper exists, skipping default background');
      document.documentElement.className = '';
    }
  }

  // 如果有壁纸，激活对应的壁纸选项
  if (hasWallpaper) {
    const wallpaperOption = document.querySelector<HTMLElement>(`.wallpaper-option[data-wallpaper-url="${hasWallpaper}"]`);
    if (wallpaperOption) {
      console.log('[Background] Activating wallpaper option');
      wallpaperOption.classList.add('active');
    }
  }

  // 背景选项点击事件
  const bgOptions = document.querySelectorAll<HTMLElement>('.settings-bg-option');
  bgOptions.forEach(option => {
    option.addEventListener('click', function() {
      const bgClass = this.getAttribute('data-bg') ?? '';
      console.log('[Background] Color option clicked:', {
        bgClass,
        previousBackground: document.documentElement.className,
        previousWallpaper: localStorage.getItem('originalWallpaper')
      });

      // 移除所有背景选项的 active 状态
      bgOptions.forEach(opt => {
        opt.classList.remove('active');
        console.log('[Background] Removing active state from:', opt.getAttribute('data-bg'));
      });

      // 添加当前选项的 active 状态
      this.classList.add('active');
      console.log('[Background] Setting active state for:', bgClass);

      document.documentElement.className = bgClass;
      localStorage.setItem('selectedBackground', bgClass);
      localStorage.setItem('useDefaultBackground', 'true');

      // 清除壁纸相关的状态
      document.querySelectorAll<HTMLElement>('.wallpaper-option').forEach(opt => {
        opt.classList.remove('active');
      });

      // 清除壁纸
      const mainElement = document.querySelector<HTMLElement>('main');
      if (mainElement) {
        mainElement.style.backgroundImage = 'none';
        document.body.style.backgroundImage = 'none';
        console.log('[Background] Cleared wallpaper');
      }
      localStorage.removeItem('originalWallpaper');

      // 使用 WelcomeManager 更新欢迎消息颜色
      const welcomeElement = document.getElementById('welcome-message');
      if (welcomeElement && window.WelcomeManager) {
        window.WelcomeManager.adjustTextColor(welcomeElement);
      }
    });
  });

  // 监听主题变化
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class') {
        // 当背景类发生变化时，调整文字颜色
        requestAnimationFrame(() => {
          const welcomeElement = document.getElementById('welcome-message');
          if (welcomeElement && window.WelcomeManager) {
            window.WelcomeManager.adjustTextColor(welcomeElement);
          }
        });
      }
    });
  });

  // 开始观察 documentElement 的 class 变化
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  });

  // 启动时一次批量读取全部 sync 配置，减少 IPC 往返
  chrome.storage.sync.get(
    [
      'bookmarkCardHeight',
      'enableQuickLinks',
      'bookmarkWidth',
      'bookmarkContainerWidth',
      'bookmarkContainerHeight',
      'pageTopSpacing',
      'pageBottomSpacing',
      'showSearchBox',
      'showWelcomeMessage',
      'showFooter',
      'showHistoryLink',
      'showDownloadsLink',
      'showPasswordsLink',
      'showExtensionsLink'
    ],
    (rawResult: unknown) => {
      applyBookmarkCardHeight(rawResult);
      applyQuickLinksVisibility(rawResult);
      applyBookmarkWidth(rawResult);
      applyBookmarkContainerSize(rawResult);
      applyPageSpacing(rawResult);
      applyElementVisibility(rawResult);
    }
  );
});

function applyBookmarkCardHeight(rawResult: unknown): void {
  const bookmarkCardHeight = getNumberProperty(rawResult, 'bookmarkCardHeight');
  if (!bookmarkCardHeight) return;

  let styleElement = document.getElementById('custom-card-height');
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = 'custom-card-height';
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = `
    .card {
      height: ${bookmarkCardHeight}px !important;
    }
  `;
}

function applyQuickLinksVisibility(rawResult: unknown): void {
  const enableQuickLinks = getBooleanProperty(rawResult, 'enableQuickLinks');
  const quickLinksWrapper = document.querySelector<HTMLElement>('.quick-links-wrapper');
  if (quickLinksWrapper) {
    quickLinksWrapper.style.display = enableQuickLinks !== false ? 'flex' : 'none';
  }
}

function applyBookmarkWidth(rawResult: unknown): void {
  const savedWidth = getNumberProperty(rawResult, 'bookmarkWidth') || 190;
  document.documentElement.style.setProperty('--bookmark-width', `${savedWidth}px`);
  document.querySelectorAll<HTMLElement>('.bookmarks-list').forEach((list) => {
    list.style.gridTemplateColumns = `repeat(auto-fill, minmax(${savedWidth}px, 1fr))`;
  });
}

function applyBookmarkContainerSize(rawResult: unknown): void {
  const savedWidth = getNumberProperty(rawResult, 'bookmarkContainerWidth') || 85; // 默认85%
  document.documentElement.style.setProperty('--bookmark-container-width', `${savedWidth}%`);
  document.querySelectorAll<HTMLElement>('.bookmarks-container').forEach((container) => {
    container.style.width = `${savedWidth}%`;
  });

  const stored = isUnknownRecord(rawResult) ? rawResult["bookmarkContainerHeight"] : undefined;
  const parsed = typeof stored === 'number' ? stored : typeof stored === 'string' ? Number(stored) : Number.NaN;
  const savedHeight = Number.isFinite(parsed) ? parsed : 100;
  document.documentElement.style.setProperty('--bookmark-container-height', `${savedHeight}%`);
}

function applyPageSpacing(rawResult: unknown): void {
  const top = isUnknownRecord(rawResult) ? rawResult['pageTopSpacing'] : undefined;
  const bottom = isUnknownRecord(rawResult) ? rawResult['pageBottomSpacing'] : undefined;
  const parsedTop = typeof top === 'number' ? top : typeof top === 'string' ? Number(top) : Number.NaN;
  const parsedBottom = typeof bottom === 'number' ? bottom : typeof bottom === 'string' ? Number(bottom) : Number.NaN;
  document.documentElement.style.setProperty(
    '--page-top-spacing',
    `${Number.isFinite(parsedTop) ? parsedTop : 96}px`,
  );
  document.documentElement.style.setProperty(
    '--page-bottom-spacing',
    `${Number.isFinite(parsedBottom) ? parsedBottom : 32}px`,
  );
}

function applyElementVisibility(rawResult: unknown): void {
  const showSearchBox = getBooleanProperty(rawResult, 'showSearchBox');
  const showWelcomeMessage = getBooleanProperty(rawResult, 'showWelcomeMessage');
  const showFooter = getBooleanProperty(rawResult, 'showFooter');
  const showHistoryLink = getBooleanProperty(rawResult, 'showHistoryLink');
  const showDownloadsLink = getBooleanProperty(rawResult, 'showDownloadsLink');
  const showPasswordsLink = getBooleanProperty(rawResult, 'showPasswordsLink');
  const showExtensionsLink = getBooleanProperty(rawResult, 'showExtensionsLink');

  // 应用搜索框显示设置 - 修改为默认隐藏
  const searchContainer = document.querySelector<HTMLElement>('.search-container');
  if (searchContainer) {
    searchContainer.style.display = showSearchBox === true ? '' : 'none';
  }

  // 应用欢迎语显示设置
  const welcomeMessage = document.getElementById('welcome-message');
  if (welcomeMessage) {
    // 先移除初始的 visibility: hidden
    welcomeMessage.style.visibility = 'visible';
    // 然后根据设置决定是否显示
    welcomeMessage.style.display = showWelcomeMessage !== false ? '' : 'none';
  }

  // 应用页脚显示设置
  const footer = document.querySelector<HTMLElement>('footer');
  if (footer) {
    footer.style.display = showFooter !== false ? '' : 'none';
  }

  // 应用快捷链接图标显示设置
  const toggleElementVisibility = (selector: string, isVisible: boolean) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      element.style.display = isVisible ? '' : 'none';
    }
  };

  toggleElementVisibility('#history-link', showHistoryLink !== false);
  toggleElementVisibility('#downloads-link', showDownloadsLink !== false);
  toggleElementVisibility('#passwords-link', showPasswordsLink !== false);
  toggleElementVisibility('#extensions-link', showExtensionsLink !== false);

  // 检查是否所有链接都被隐藏
  const linksContainer = document.querySelector<HTMLElement>('.links-icons');
  if (linksContainer) {
    const allLinksHidden =
      showHistoryLink === false &&
      showDownloadsLink === false &&
      showPasswordsLink === false &&
      showExtensionsLink === false;

    linksContainer.style.display = allLinksHidden ? 'none' : '';
  }
}

const bookmarksCache = createBookmarkCache<BookmarkNode>();

async function updateBookmarkCards() {
  const bookmarksList = requireElement(getActiveBookmarksList(), HTMLElement, '#bookmarks-list');
  const defaultBookmarkId = localStorage.getItem('defaultBookmarkId');
  let parentId = defaultBookmarkId || bookmarksList.dataset["parentId"];

  if (!parentId) {
    parentId = await getBookmarksBarId(chrome.bookmarks);
  }

  let bookmarks: BookmarkNode[];
  try {
    bookmarks = await chrome.bookmarks.getChildren(parentId);
  } catch {
    parentId = await getBookmarksBarId(chrome.bookmarks);
    bookmarks = await chrome.bookmarks.getChildren(parentId);
  }

  displayBookmarks({ id: parentId, children: bookmarks });

  // 在显示书签后更新默认书签指示器
  updateDefaultBookmarkIndicator();
  updateSidebarDefaultBookmarkIndicator();

  // 更新 bookmarks-list 的 data-parent-id
  bookmarksList.dataset["parentId"] = parentId;
}

document.addEventListener('DOMContentLoaded', function () {
  // 书签右键菜单在首次右键时由 showContextMenu 惰性创建，不再启动即构建
  const searchEngineIcon = document.getElementById('search-engine-icon');
  const defaultSearchEngine = localStorage.getItem('selectedSearchEngine') || 'google';
  console.log('[Init] Default search engine:', localStorage.getItem('selectedSearchEngine'));
  let deletedBookmark = null;
    void deletedBookmark;
  let deletedCategory = null; // 添加这行
    void deletedCategory;
  let deleteTimeout = null;
    void deleteTimeout;
  let bookmarkTreeNodes: BookmarkNode[] = []; // 定义全局变量
    void bookmarkTreeNodes;
  // 调用 updateBookmarkCards
  updateBookmarkCards().catch(error => {
    console.error('Error updating bookmark cards:', error);
  });

  updateSearchEngineIcon(defaultSearchEngine);

  if (searchEngineIcon instanceof HTMLImageElement && searchEngineIcon.src === '') {
    searchEngineIcon.src = '../images/placeholder-icon.svg';
  }

  // 修改 updateSearchEngineIcon 函数
  function updateSearchEngineIcon(engineName: string) {
    setSearchEngineIcon(engineName);
  }

  // 更新侧边栏默认书签指示器和选中状态
  updateSidebarDefaultBookmarkIndicator();

  // ... 其他代码 ...





  // 优化后的更新显示函数


  // 添加分页控制
  // 化书顺序步


  // 文件夹卡片的右键菜单由 createFolderCard 内的 contextmenu 监听处理
  // （其中调用了 stopPropagation），document 级兜底监听永远不会命中，已移除。

  // 在点击其他地方时重置状态
  document.addEventListener('click', function () {
    // 延迟处理点击事件，让菜单项的点击事件先执行
    setTimeout(() => {
    if (contextMenu) {
      contextMenu.style.display = 'none';
        currentBookmark = null;
      }

      if (bookmarkFolderContextMenu) {
        bookmarkFolderContextMenu.style.display = 'none';
        currentBookmarkFolder = null;
      }
    }, 200);
  });
});

function showMovingFeedback(element: HTMLElement) {
  element.style.opacity = '0.5';
}

function hideMovingFeedback(element: HTMLElement) {
  element.style.opacity = '1';
}

function showSuccessFeedback(element: HTMLElement) {
  element.style.backgroundColor = '#e6ffe6';
  setTimeout(() => {
    element.style.backgroundColor = '';
  }, 1000);
}

function showErrorFeedback(element: HTMLElement) {
  element.style.backgroundColor = '#ffe6e6';
  setTimeout(() => {
    element.style.backgroundColor = '';
  }, 1000);
}


// 移除所有 defaultBookmarkId 相关的代码
// 修改 waitForFirstCategory 函数
async function waitForFirstCategory(attemptsLeft = 5) {
  try {
    // 1. 先隐藏书签列表，避免闪烁
    const bookmarksList = getActiveBookmarksList();
    const bookmarksContainer = getActiveBookmarksContainer();
    if (bookmarksList && bookmarksContainer) {
      bookmarksContainer.style.opacity = '0';
      bookmarksContainer.style.transition = 'opacity 0.3s ease';
    }

    // 2. 尝试获取上次访问的文件夹
    const { lastViewedFolder } = await chrome.storage.local.get('lastViewedFolder');

    if (typeof lastViewedFolder === 'string') {
      try {
        const results = await chrome.bookmarks.get(lastViewedFolder);
        if (results && results.length > 0) {
          await updateBookmarksDisplay(lastViewedFolder);
          updateFolderName(lastViewedFolder);
          selectSidebarFolder(lastViewedFolder);
          // 显示内容
          if (bookmarksContainer) bookmarksContainer.style.opacity = '1';
          return;
        }
      } catch { // no-excuse-ok: catch
        await chrome.storage.local.remove('lastViewedFolder');
      }
    }

    // 3. 尝试使用用户设置的默认文件夹
    const defaultFolders = await pruneDefaultFolders(chrome.bookmarks, chrome.storage);
    const firstDefaultFolder = defaultFolders[0];
    if (firstDefaultFolder) {
      const defaultFolderId = firstDefaultFolder.id;
      try {
        const results = await chrome.bookmarks.get(defaultFolderId);
        if (results && results.length > 0) {
          await updateBookmarksDisplay(defaultFolderId);
          updateFolderName(defaultFolderId);
          selectSidebarFolder(defaultFolderId);
          // 显示内容
          if (bookmarksContainer) bookmarksContainer.style.opacity = '1';
          return;
        }
      } catch (error) {
        if (error instanceof Error) void error;
        // The folder was removed after the default-folder list was validated.
      }
    }

    // 4. 兜底方案：使用实际存在的书签栏目录
    await showBookmarksBar();
    // 显示内容
    if (bookmarksContainer) bookmarksContainer.style.opacity = '1';

  } catch (error) {
    console.error('Error in waitForFirstCategory:', error instanceof Error ? error : String(error));
    if (attemptsLeft > 0) {
      setTimeout(() => {
        waitForFirstCategory(attemptsLeft - 1).catch(error => {
          console.error('Error retrying first category:', error);
        });
      }, 1000);
    } else {
      // 重试次数用完，使用实际存在的书签栏目录
      await showBookmarksBar();
      // 显示内容
      const bookmarksContainer = getActiveBookmarksContainer();
      if (bookmarksContainer) {
        bookmarksContainer.style.opacity = '1';
      }
    }
  }
}

async function showBookmarksBar() {
  const folderId = await getBookmarksBarId(chrome.bookmarks);
  await updateBookmarksDisplay(folderId);
  updateFolderName(folderId);
  selectSidebarFolder(folderId);
}

function ensureFolderSwiper(): FolderSwiperHandle {
  if (folderSwiper) return folderSwiper;
  const container = document.querySelector('.folder-swiper');
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('Missing folder swiper container');
  }
  folderSwiper = createFolderSwiper(container, onPinnedSlideChange);
  return folderSwiper;
}

function selectFolderSlide(
  pinnedFolders: readonly FolderSlide[],
  folder: FolderSlide,
): FolderSlideSelection {
  const temporary = pinnedFolders.some((pinnedFolder) => pinnedFolder.id === folder.id)
    ? undefined
    : folder;
  return {
    slides: temporary ? [...pinnedFolders, temporary] : pinnedFolders,
    temporary,
  };
}

function renderFolderTabs(): void {
  const tabsContainer = document.querySelector<HTMLElement>('.tabs-container');
  if (!tabsContainer) return;

  tabsContainer.replaceChildren();
  const folders = temporaryFolderSlide
    ? [...pinnedFolderSlides, temporaryFolderSlide]
    : pinnedFolderSlides;
  for (const folder of folders) {
    const tab = document.createElement('div');
    tab.className = 'folder-tab';
    tab.dataset["folderId"] = folder.id;
    tab.dataset["name"] = folder.name;
    tab.role = 'button';
    tab.tabIndex = 0;
    tab.ariaLabel = folder.name;
    if (folder.id === temporaryFolderSlide?.id) tab.dataset["temporary"] = 'true';
    const activate = () => {
      void switchToFolder(folder.id);
    };
    tab.addEventListener('click', activate);
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
    tabsContainer.appendChild(tab);
  }
  updateDefaultFoldersTabsVisibility();
}

function onPinnedSlideChange(folderId: string): void {
  // 惰性渲染：首次滑入或被未固定目录替换内容后，拉取书签并构建卡片
  const listForSlide = queryBookmarksList(folderId);
  if (listForSlide && listForSlide.dataset["parentId"] !== folderId) {
    updateBookmarksDisplay(folderId).catch(error => {
      console.error('Error lazily rendering pinned slide:', error instanceof Error ? error : String(error));
    });
  }

  document.querySelectorAll<HTMLElement>('.folder-tab').forEach((tab) => {
    const isActive = tab.dataset["folderId"] === folderId;
    tab.classList.toggle('active', isActive);
  });
  const list = queryBookmarksList(folderId);
  const shownId = list?.dataset["parentId"] ?? folderId;
  updateFolderName(shownId);
  selectSidebarFolder(shownId);
  void chrome.storage.local.set({
    lastViewedFolder: folderId,
    lastViewedTime: Date.now(),
  });
  setupActiveBookmarkListSortable();
  const activeContainer = getActiveBookmarksContainer();
  const activeList = getActiveBookmarksList();
  if (activeContainer && activeList) ensureScrollIndicator(activeContainer, activeList);
}

async function initDefaultFoldersTabs() {
  const tabsContainer = document.querySelector<HTMLElement>('.tabs-container');
  const defaultFoldersTabs = document.querySelector<HTMLElement>('.default-folders-tabs');

  if (!tabsContainer || !defaultFoldersTabs) {
    console.error('Tabs container not found');
    return;
  }

  const [{ lastViewedFolder }, folders] = await Promise.all([
    chrome.storage.local.get('lastViewedFolder'),
    pruneDefaultFolders(chrome.bookmarks, chrome.storage),
  ]);
  const defaultFolders = folders.sort((a, b) => a.order - b.order);
  const swiper = ensureFolderSwiper();

  pinnedFolderSlides = defaultFolders.map((folder) => ({
    id: folder.id,
    name: folder.name,
  }));
  temporaryFolderSlide = undefined;
  renderFolderTabs();

  const bookmarksBarId = await getBookmarksBarId(chrome.bookmarks);
  chrome.bookmarks.getTree(function (nodes) {
    bookmarkTreeNodes = nodes;
    displayBookmarkCategories(bookmarkTreeNodes[0]?.children ?? [], 0, null, bookmarksBarId);
  });

  if (defaultFolders.length > 0) {
    const folderToActivate = typeof lastViewedFolder === 'string'
      && defaultFolders.some((folder) => folder.id === lastViewedFolder)
      ? lastViewedFolder
      : defaultFolders[0]?.id ?? await getBookmarksBarId(chrome.bookmarks);

    swiper.rebuild(pinnedFolderSlides, folderToActivate);

    // 只渲染激活的 slide，其余 slide 首次滑入时由 onPinnedSlideChange 惰性渲染
    await switchToFolder(folderToActivate);
  } else {
    const folderToActivate = await getBookmarksBarId(chrome.bookmarks);
    swiper.rebuild([{ id: folderToActivate, name: 'Bookmarks' }], folderToActivate);
    await switchToFolder(folderToActivate);
  }

  initWheelSwitching();
  updateDefaultFoldersTabsVisibility();

  return defaultFolders;
}

function initWheelSwitching() {
  const swiper = folderSwiper;
  if (!swiper) return;

  const apply = (enabled: boolean): void => {
    swiper.setMousewheelEnabled(enabled);
  };

  chrome.storage.sync.get({ enableWheelSwitching: false }, (rawResult: unknown) => {
    apply(getBooleanProperty(rawResult, 'enableWheelSwitching') === true);
  });

  if (wheelSwitchingInitialized) return;
  wheelSwitchingInitialized = true;

  document.addEventListener('wheelSwitchingChanged', (event) => {
    if (!(event instanceof CustomEvent)) return;
    const enabled = getBooleanProperty(event.detail, 'enabled');
    if (enabled === undefined) return;
    apply(enabled);
  });
}

async function switchToFolder(folderId: string) {
  try {
    const results = await chrome.bookmarks.get(folderId);
    const selectedFolder = results[0];
    if (!selectedFolder) {
      throw new Error('Folder not found');
    }

    if (pinnedFolderSlides.length > 0) {
      const selection = selectFolderSlide(pinnedFolderSlides, { id: folderId, name: selectedFolder.title });
      temporaryFolderSlide = selection.temporary;
      renderFolderTabs();
      folderSwiper?.rebuild(selection.slides, folderId);
    }

    document.querySelectorAll<HTMLElement>('.folder-tab').forEach((tab) => {
      const isActive = tab.dataset["folderId"] === folderId;
      tab.classList.toggle('active', isActive);
    });

    await Promise.all([
      updateBookmarksDisplay(folderId),
      updateFolderName(folderId),
      selectSidebarFolder(folderId),
    ]);
    await chrome.storage.local.set({
      lastViewedFolder: folderId,
      lastViewedTime: Date.now(),
    });
  } catch (error) {
    console.error('Error switching folder:', error instanceof Error ? error : String(error));
    await showBookmarksBar();
  }
}

function updateBookmarksDisplay(parentId: string, movedItemId?: string, _newIndex?: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // 首先检查缓存
    const cached = bookmarksCache.get(parentId);
    if (cached && !movedItemId) {
      // 如果有缓存且不是移动操作，直接使用缓存数据
      console.log('Using cached bookmarks for:', parentId);
      displayBookmarks({ id: parentId, children: cached.bookmarks }, true);
      resolve();
      return;
    }

    // 如果没有缓存或是移动操作，从 Chrome API 获取数据
    chrome.bookmarks.getChildren(parentId, (bookmarks) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }

      // 更新缓存
      bookmarksCache.set(parentId, bookmarks);

      // 显示书签
      displayBookmarks({ id: parentId, children: bookmarks }, movedItemId === undefined);

      if (movedItemId) {
        highlightBookmark(movedItemId);
      }

      // 更新文件夹名称
      updateFolderName(parentId);

      resolve();
    });
  });
}

window.updateBookmarksDisplay = updateBookmarksDisplay;

// 获取书签栏的本地化名称；优先复用已缓存的整棵树，避免每次面包屑更新都拉全树
function getBookmarksBarName(): Promise<string> {
  const cachedBar = bookmarkTreeNodes[0]?.children?.find(child => child.id === '1');
  if (cachedBar) {
    return Promise.resolve(cachedBar.title);
  }

  return new Promise<string>(resolve => {
    chrome.bookmarks.getTree(function(tree) {
      if (tree && tree[0] && tree[0].children) {
        bookmarkTreeNodes = tree;
        const bookmarksBar = tree[0].children.find(child => child.id === '1');
        if (bookmarksBar) {
          resolve(bookmarksBar.title);
        } else {
          resolve('Bookmarks Bar'); // 默认英文名称
        }
      } else {
        resolve('Bookmarks Bar'); // 默认英文名称
      }
    });
  });
}

function getBookmarkPath(bookmarkId: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    getBookmarksBarName().then(bookmarksBarName => {
      function getParentRecursive(id: string, path: string[] = []) {
        chrome.bookmarks.get(id, function(results) {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
            return;
          }
          if (results && results[0]) {
            path.unshift(results[0].title);
            if (results[0].parentId && results[0].parentId !== '0') {
              getParentRecursive(results[0].parentId, path);
            } else {
              // 确保书签栏名称总是作为第一个元素
              if (path[0] !== bookmarksBarName) {
                path.unshift(bookmarksBarName);
              }
              resolve(path);
            }
          } else {
            reject(new Error('Bookmark not found'));
          }
        });
      }
      getParentRecursive(bookmarkId);
    });
  });
}

function updateFolderName(bookmarkId: string) {
  const list = queryBookmarksList(bookmarkId);
  const folderNameElement = list?.closest('.bookmarks-container')?.querySelector<HTMLElement>('.folder-name')
    ?? getActiveFolderName();
  if (!folderNameElement) return;

  const updateVersion = (folderNameUpdateVersions.get(folderNameElement) ?? 0) + 1;
  folderNameUpdateVersions.set(folderNameElement, updateVersion);

  // 检查 bookmarkId 是否有效
  if (!bookmarkId || bookmarkId === 'undefined') {
    folderNameElement.textContent = getLocalizedMessage('bookmarks');
    return;
  }

  // 尝试获取书签路径
  getBookmarkPath(bookmarkId).then((pathArray: string[]) => {
    if (folderNameUpdateVersions.get(folderNameElement) !== updateVersion) return;

    let breadcrumbHtml = '';
    let currentPath = '';

    pathArray.forEach((part: string, index: number) => {
      currentPath += (index > 0 ? ' > ' : '') + part;
      breadcrumbHtml += `<span class="breadcrumb-item" data-path="${currentPath}">${getLocalizedMessage(part)}</span>`;
      if (index < pathArray.length - 1) {
        breadcrumbHtml += '<span class="breadcrumb-separator">&gt;</span>';
      }
    });

    folderNameElement.innerHTML = breadcrumbHtml;
    addBreadcrumbClickListeners();
  }).catch(error => {
    if (folderNameUpdateVersions.get(folderNameElement) !== updateVersion) return;

    console.warn('Error updating folder name:', error);
    // 设置默认文本，并确保它被本地化
    folderNameElement.textContent = getLocalizedMessage('bookmarks');
  });
}

function addBreadcrumbClickListeners() {
  const breadcrumbItems = document.querySelectorAll<HTMLElement>('.breadcrumb-item');
  breadcrumbItems.forEach(item => {
    item.addEventListener('click', function () {
      const path = this.dataset["path"];
      if (path !== undefined) navigateToPath(path);
    });
  });
}

function navigateToPath(path: string) {
  const pathParts = path.split(' > ');

  // 获取书签栏的名称
  getBookmarksBarName().then(bookmarksBarName => {
    let currentId = '1'; // 默认从根目录开始
    let startIndex = 0;

    // 如果路径不是从书签栏开始，我们需要找到正确的起始点
    const firstPathPart = pathParts[0];
    if (firstPathPart !== bookmarksBarName && firstPathPart !== undefined) {
      chrome.bookmarks.search({title: firstPathPart}, function(results) {
        const firstResult = results[0];
        if (firstResult) {
          currentId = firstResult.id;
        }
        navigateRecursive(startIndex);
      });
    } else {
      startIndex = 1; // 如果从书签栏开始，跳过第一个元素
      navigateRecursive(startIndex);
    }

    function navigateRecursive(index: number) {
      if (index >= pathParts.length) {
        updateBookmarksDisplay(currentId);
        return;
      }

      chrome.bookmarks.getChildren(currentId, function(children) {
        const matchingChild = children.find(child => child.title === pathParts[index]);
        if (matchingChild) {
          currentId = matchingChild.id;
          navigateRecursive(index + 1);
        } else {
          updateBookmarksDisplay(currentId);
        }
      });
    }
  });
}

function displayBookmarks(bookmark: BookmarkDisplay, _animate = true) {
  const bookmarksList = queryBookmarksList(bookmark.id);
  const bookmarksContainer = bookmarksList?.closest('.bookmarks-container');
  if (!bookmarksList || !(bookmarksContainer instanceof HTMLElement)) {
    return;
  }

  const itemsToDisplay = [...(bookmark.children ?? [])];

  itemsToDisplay.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // 子项 id 序列与当前 DOM 一致时跳过重建：书签事件同步（已合流）在无实际
  // 变化时不再付出全量重建与 favicon 重载的代价；标题/URL 的单卡更新走 card-update
  if (
    bookmarksList.dataset["parentId"] === bookmark.id &&
    sameBookmarkSequence(bookmarksList, itemsToDisplay)
  ) {
    return;
  }

  const fragment = document.createDocumentFragment();

  itemsToDisplay.forEach((child: BookmarkNode) => {
    if (child.url) {
      fragment.appendChild(createBookmarkCard(child, child.index ?? 0));
    } else {
      fragment.appendChild(createFolderCard(child, child.index ?? 0));
    }
  });

  bookmarksList.innerHTML = '';
  bookmarksList.appendChild(fragment);
  bookmarksList.dataset["parentId"] = bookmark.id;
  bookmarksList.scrollTop = 0;
  bindBookmarkListSortable(bookmarksList);
  ensureScrollIndicator(bookmarksContainer, bookmarksList);
}

// 比较 list 现有卡片与目标书签序列是否完全一致（id 顺序、URL 与标题）。
// 标题/URL 也需比对：外部改名/改址的书签事件依赖此处差异触发重建来刷新 DOM
function sameBookmarkSequence(bookmarksList: HTMLElement, items: readonly BookmarkNode[]): boolean {
  const cards = bookmarksList.children;
  if (cards.length !== items.length) return false;
  for (const [index, item] of items.entries()) {
    const card = cards[index];
    if (!(card instanceof HTMLElement)) return false;
    if (card.dataset["id"] !== item.id) return false;
    if ((card.dataset["url"] ?? '') !== (item.url ?? '')) return false;
    if ((card.querySelector<HTMLElement>('.card-title')?.textContent ?? '') !== item.title) return false;
  }
  return true;
}

// 取色前先降采样到 64×64 离屏画布，避免对原图逐像素扫描产生海量字符串分配与排序
const COLOR_SAMPLE_SIZE = 64;

function getColors(img: HTMLImageElement): BookmarkColors {
  const defaultColors: BookmarkColors = { primary: [200, 200, 200], secondary: [220, 220, 220] };
  const canvas = document.createElement('canvas');
  canvas.width = COLOR_SAMPLE_SIZE;
  canvas.height = COLOR_SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return defaultColors;

  ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
  const data = ctx.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE).data;
  const colorCounts = new Map<number, number>();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // 跳过完全透明的像素
    const key = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
  }

  const sortedColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]);
  const primaryKey = sortedColors[0]?.[0];
  if (primaryKey === undefined) {
    // 如果图片完全透明，返回默认颜色
    return defaultColors;
  }

  const toRgb = (key: number): readonly number[] => [(key >> 16) & 255, (key >> 8) & 255, key & 255];
  const secondaryKey = sortedColors[1]?.[0];

  return {
    primary: toRgb(primaryKey),
    secondary: secondaryKey !== undefined
      ? toRgb(secondaryKey)
      : toRgb(primaryKey).map(c => Math.min(255, c + 20)), // 如果只有一种颜色，创建一个稍微亮的次要颜色
  };
}



// 修改现有的颜色处理函数


// 修改创建书签卡片时的颜色处理
function createBookmarkCard(bookmark: BookmarkNode, index: number) {
  const bookmarkUrl = bookmark.url ?? '';
  const card = document.createElement('a');
  card.href = bookmarkUrl;
  card.className = 'bookmark-card card';
  card.dataset["id"] = bookmark.id;
  card.dataset["parentId"] = bookmark.parentId;
  card.dataset["index"] = index.toString();
  // 委托监听器从 dataset 取 URL（card-update 编辑后会同步刷新该值）
  card.dataset["url"] = bookmarkUrl;

  const img = document.createElement('img');
  img.className = 'w-6 h-6 mr-2';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = createFaviconUrl(bookmarkUrl);

  // 尝试从缓存获取颜色
  const cachedColors = getCachedCardColors(bookmark.id);

  if (cachedColors) {
    // 如果有缓存，直接应用缓存的颜色，只加载 favicon 不重新计算颜色
    applyColors(card, cachedColors);
  } else {
    // 只在没有缓存时计算颜色，取色挪到空闲时段避免与渲染同帧
    img.onload = function() {
      scheduleIdle(() => {
        const colors = getColors(img);
        applyColors(card, colors);
        setCachedCardColors(bookmark.id, colors);
      });
    };
  }

  img.onerror = function() {
    // 处 favicon 加载失败的情况
    const defaultColors = { primary: [200, 200, 200], secondary: [220, 220, 220] };
    applyColors(card, defaultColors);
    setCachedCardColors(bookmark.id, defaultColors);
  };

  const favicon = document.createElement('div');
  favicon.className = 'favicon';
  favicon.appendChild(img);
  card.appendChild(favicon);

  const content = document.createElement('div');
  content.className = 'card-content';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = bookmark.title;

  content.appendChild(title);
  card.appendChild(content);

  // 右键菜单、点击与悬停均不逐卡绑定：contextmenu/click 走文档级事件委托
  //（见 setupBookmarkCardDelegation），悬停效果由 src/styles/theme-dark.less 的
  // .bookmark-card.card:hover 提供

  return card;
}

// 书签卡的点击与右键菜单：document 级事件委托，全量重建卡片时不再重复创建监听器
const BOOKMARK_CARD_CLICK_COOLDOWN = 500;
let lastBookmarkCardClickAt = 0;

function setupBookmarkCardDelegation(): void {
  document.addEventListener('contextmenu', function (event) {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest<HTMLElement>('.bookmark-card');
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event, card, 'bookmark');
  });

  document.addEventListener('click', function (event) {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest<HTMLElement>('.bookmark-card');
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();

    if (Date.now() - lastBookmarkCardClickAt < BOOKMARK_CARD_CLICK_COOLDOWN) return;
    lastBookmarkCardClickAt = Date.now();

    const bookmarkUrl = card.dataset['url'] ?? '';
    if (!bookmarkUrl) return;

    const isInternalUrl = bookmarkUrl.startsWith('chrome://') ||
                         bookmarkUrl.startsWith('chrome-extension://') ||
                         bookmarkUrl.startsWith('edge://') ||
                         bookmarkUrl.startsWith('about:');

    if (isInternalUrl) {
      chrome.tabs.create({
        url: bookmarkUrl,
        active: true
      }).catch(error => {
        console.error('[Bookmark Click] Failed to create internal tab:', error);
      });
      return;
    }

    chrome.storage.sync.get(['openInNewTab'], (rawResult: unknown) => {
      if (getBooleanProperty(rawResult, 'openInNewTab') !== false) {
        window.open(bookmarkUrl, '_blank');
      } else {
        window.location.href = bookmarkUrl;
      }
    });
  });
}

setupBookmarkCardDelegation();

function adjustColor(r: number, g: number, b: number) {
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  let factor = 1;

  if (brightness < 128) {
    // 如果颜色太暗，增加亮度
    factor = 1 + (128 - brightness) / 128;
  } else if (brightness > 200) {
    // 如果颜色太亮，减少亮度
    factor = 1 - (brightness - 200) / 55;
  }

  return {
    r: Math.min(255, Math.round(r * factor)),
    g: Math.min(255, Math.round(g * factor)),
    b: Math.min(255, Math.round(b * factor))
  };
}

function applyColors(card: HTMLElement, colors: BookmarkColors) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const adjustedPrimary = adjustColor(colors.primary[0] ?? 0, colors.primary[1] ?? 0, colors.primary[2] ?? 0);
  const adjustedSecondary = adjustColor(colors.secondary[0] ?? 0, colors.secondary[1] ?? 0, colors.secondary[2] ?? 0);

  const opacity = isDark ? '0.1' : '0.06';
  card.style.background = `linear-gradient(135deg,
    rgba(${adjustedPrimary.r}, ${adjustedPrimary.g}, ${adjustedPrimary.b}, ${opacity}),
    rgba(${adjustedSecondary.r}, ${adjustedSecondary.g}, ${adjustedSecondary.b}, ${opacity}))`;
  card.style.border = `1px solid rgba(${adjustedPrimary.r}, ${adjustedPrimary.g}, ${adjustedPrimary.b}, ${isDark ? '0.1' : '0.01'})`;
}

function openInNewWindow(url: string) {
  chrome.windows.create({ url: url }, function (window) {
    console.log('New window opened with id: ' + window?.id);
  });
}

function openInIncognito(url: string) {
  chrome.windows.create({ url: url, incognito: true }, function (window) {
    console.log('New incognito window opened with id: ' + window?.id);
  });
}

// Encapsulate toast and bookmark link copier functionality in a closure
const Utilities = (function() {
  let toastTimeout: ReturnType<typeof setTimeout> | undefined;

  function showToast(message = getLocalizedMessage('moreSearchSupportToast'), duration = 1500) {
    const toast = document.getElementById('more-button-toast');
    if (!toast) {
      console.error('Toast element not found');
      return;
    }

    // If toast is already showing, clear the previous timeout
    if (toast.classList.contains('show')) {
      clearTimeout(toastTimeout);
      toast.classList.remove('show');
      setTimeout(() => showToast(message, duration), 300); // Try showing again after a short delay
      return;
    }

    const toastMessage = toast.querySelector<HTMLElement>('p');
    if (toastMessage) {
      toastMessage.textContent = message;
    }

    toast.classList.add('show');

    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  function copyBookmarkLink(bookmark: CurrentBookmark) {
    try {
      if (!bookmark || !bookmark.url) {
        throw new Error('No valid bookmark link found');
      }
      navigator.clipboard.writeText(bookmark.url).then(() => {
        showToast(getLocalizedMessage('linkCopied'));
      }).catch(err => {
        console.error('Failed to copy link:', err);
        showToast(getLocalizedMessage('copyLinkFailed'));
      });
    } catch (error) {
      console.error('Error copying bookmark link:', error);
      if (error instanceof Error && error.message === 'Extension context invalidated.') {
        showToast(getLocalizedMessage('extensionReloaded'));
      } else {
        showToast(getLocalizedMessage('copyLinkFailed'));
      }
    }
  }

  return {
    showToast: showToast,
    copyBookmarkLink: copyBookmarkLink
  };
})();

// 修改 showContextMenu 函数
function showContextMenu(event: MouseEvent, item: CurrentBookmark | HTMLElement, type = 'bookmark') {
  // 先关闭所有已存在的上下文菜单
  const existingMenus = document.querySelectorAll<HTMLElement>('.custom-context-menu');
  existingMenus.forEach(menu => {
    if (menu !== contextMenu && menu.style.display !== 'none') {
      menu.style.display = 'none';
    }
  });

  // 如果上下文菜单不存在，则创建一个新的
  if (!contextMenu) {
    contextMenu = createContextMenu();
  }

  if (!contextMenu) {
    console.error('Failed to create context menu');
    return;
  }

  // 清除之前的状态
  itemToDelete = null;
  currentBookmark = null;

  // 设置当前项目，确保包含类型信息
  const itemElement = item instanceof HTMLElement ? item : null;
  const bookmarkItem = item instanceof HTMLElement ? null : item;
  currentBookmark = {
    id: bookmarkItem?.id ?? itemElement?.dataset['id'] ?? '',
    title: bookmarkItem?.title ?? itemElement?.querySelector('.card-title')?.textContent ?? itemElement?.querySelector('span')?.textContent ?? '',
    url: bookmarkItem?.url ?? itemElement?.dataset['url'] ?? '',
    type: bookmarkItem?.type ?? type
  };

  // 先显示菜单但设为不可见，以便获取其尺寸
  contextMenu.style.display = 'block';
  contextMenu.style.visibility = 'hidden';
  contextMenu.style.left = '0';
  contextMenu.style.top = '0';

  // 获取视窗尺寸
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // 等待一下以确保菜单已渲染
  const activeMenu = contextMenu;
  setTimeout(() => {
    const menuRect = activeMenu.getBoundingClientRect();

    // 计算最佳位置
    let left = event.clientX;
    let top = event.clientY;

    // 检查右侧空间
    if (left + menuRect.width > viewportWidth) {
      // 如果右侧空间不足，尝试将菜单放在点击位置的左侧
      left = Math.max(5, left - menuRect.width);
    }

    // 检查底部空间
    if (top + menuRect.height > viewportHeight) {
      // 如果底部空间不足，尝试将菜单放在点击位置的上方
      top = Math.max(5, viewportHeight - menuRect.height - 5);
    }

    // 应用计算后的位置
    activeMenu.style.left = `${left}px`;
    activeMenu.style.top = `${top}px`;

    // 使菜单可见
    activeMenu.style.visibility = 'visible';
  }, 0);
}



// 新增函数：根据类型创建菜单项



// 在创建快捷链接卡片时


// 在确认对话框关闭时清理数据


// 分别定义两个函数处理不同类型的删除



// 新增：清理所有删除相关的状态


// 修改 showConfirmDialog 函数
function showConfirmDialog(message: string, callback: () => void | Promise<void>) {
  // 先保存当前状态的副本
  const currentState = {
    itemToDelete: itemToDelete ? { ...itemToDelete } : null,
    currentBookmark: currentBookmark ? { ...currentBookmark } : null,
    type: itemToDelete ? itemToDelete.type : 'unknown'  // 从 itemToDelete 获取类型
  };

  console.log('Current state:', currentState);

  const confirmDialog = document.getElementById('confirm-dialog');
  const confirmMessage = document.getElementById('confirm-dialog-message');
  const confirmQuickLinkMessage = document.getElementById('confirm-delete-quick-link-message');
  const confirmButton = document.getElementById('confirm-delete-button');
  const cancelButton = document.getElementById('cancel-delete-button');

  if (!confirmDialog || !confirmMessage || !confirmButton || !cancelButton) {
    console.error('Required dialog elements not found');
    return;
  }

  // 清空所有确认消息
  confirmMessage.innerHTML = '';
  if (confirmQuickLinkMessage) {
    confirmQuickLinkMessage.innerHTML = '';
    confirmQuickLinkMessage.style.display = 'none';
  }

  // 根据 itemToDelete 的类型显示相应的消息
  if (itemToDelete && itemToDelete.type === 'quickLink') {
    if (confirmQuickLinkMessage) {
      confirmQuickLinkMessage.innerHTML = message;
      confirmQuickLinkMessage.style.display = 'block';
      confirmMessage.style.display = 'none';
    }
  } else {
    confirmMessage.innerHTML = message;
    confirmMessage.style.display = 'block';
    if (confirmQuickLinkMessage) {
      confirmQuickLinkMessage.style.display = 'none';
    }
  }

  confirmDialog.style.display = 'block';

  const handleConfirm = () => {
    console.log('Confirm clicked. Current state:', currentState);
    if (typeof callback === 'function') {
      callback();
    }
    confirmDialog.style.display = 'none';
    cleanup();
  };

  const handleCancel = () => {
    console.log('Cancel clicked. Clearing state...');
    confirmDialog.style.display = 'none';

    // 清空所有确认消息
    confirmMessage.innerHTML = '';
    confirmMessage.style.display = 'block';
    if (confirmQuickLinkMessage) {
      confirmQuickLinkMessage.innerHTML = '';
      confirmQuickLinkMessage.style.display = 'none';
    }

    // 使用之前保存的状态副本记录日志
    console.log('State before cancel:', currentState);

    clearAllStates();
    cleanup();
  };

  const cleanup = () => {
    console.log('Cleaning up event listeners');
    confirmButton.removeEventListener('click', handleConfirm);
    cancelButton.removeEventListener('click', handleCancel);
  };

  // 移除旧的事件监听器并添加新的
  confirmButton.removeEventListener('click', handleConfirm);
  cancelButton.removeEventListener('click', handleCancel);
  confirmButton.addEventListener('click', handleConfirm);
  cancelButton.addEventListener('click', handleCancel);
}

// 新增一个函数来清理所有状态
function clearAllStates() {
  itemToDelete = null;
  currentBookmark = null;

  // 隐藏上下文菜单
  if (contextMenu) {
    contextMenu.style.display = 'none';
  }
}


function deleteBookmark(bookmarkId: string, _bookmarkTitle: string) {
  if (!bookmarkId) {
    console.error('No bookmark ID provided for deletion');
    return;
  }

  // 先从界面上移除书签卡片
  const bookmarkCard = document.querySelector<HTMLElement>(`.bookmark-card[data-id="${bookmarkId}"]`);
  if (bookmarkCard) {
    // 添加淡出动画
    bookmarkCard.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    bookmarkCard.style.opacity = '0';
    bookmarkCard.style.transform = 'scale(0.95)';

    // 等待动画完成后移除元素
    setTimeout(() => {
      bookmarkCard.remove();
    }, 300);
  }

  // 然后调用 Chrome API 删除书签
  chrome.bookmarks.remove(bookmarkId, function() {
    if (chrome.runtime.lastError) {
      console.error('Error deleting bookmark:', chrome.runtime.lastError);
      Utilities.showToast(getLocalizedMessage('deleteBookmarkError'));

      // 如果删除失败，恢复书签卡片
      if (bookmarkCard && bookmarkCard.parentNode) {
        bookmarkCard.style.opacity = '1';
        bookmarkCard.style.transform = 'scale(1)';
      }
    } else {
      // 保留成功删除的日志，但简化
      Utilities.showToast(getLocalizedMessage('deleteSuccess'));

      // 只清除受影响父目录的缓存，避免全量失效后所有文件夹重新 IPC
      const activeParentId = getActiveBookmarksList()?.dataset["parentId"];
      if (activeParentId) {
        bookmarksCache.delete(activeParentId);

        // 不需要完全刷新，因为我们已经从界面上移除了书签卡片
        // 但我们需要更新缓存和排序
        chrome.bookmarks.getChildren(activeParentId, (bookmarks) => {
          if (!chrome.runtime.lastError) {
            bookmarkOrderCache[activeParentId] = bookmarks.map(b => b.id);
          }
        });
      }
    }
  });
}

function showToast(message: string, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) {
    console.error('Toast element not found');
    return;
  }
  toast.textContent = message;
  toast.style.display = 'block';
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.style.display = 'none';
    }, 300);
  }, duration);
}



function createFolderCard(folder: BookmarkNode, index: number) {
  const card = document.createElement('div');
  card.className = 'bookmark-folder card';
  card.dataset["id"] = folder.id;
  card.dataset["parentId"] = folder.parentId;
  card.dataset["index"] = index.toString();

  const icon = document.createElement('span');
  icon.className = 'material-icons mr-2';
  icon.innerHTML = ICONS.folder;

  const content = document.createElement('div');
  content.className = 'card-content';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = folder.title;

  content.appendChild(title);
  card.appendChild(icon);
  card.appendChild(content);

  // Add click event handler to display folder contents
  card.addEventListener('click', function() {
    updateBookmarksDisplay(folder.id);
    updateFolderName(folder.id);
  });

  // 文件夹卡颜色为恒定默认值，无需缓存
  applyColors(card, DEFAULT_FOLDER_COLORS);

  // 修改右键点击事件，使用文件夹的上下文菜单
  card.addEventListener('contextmenu', async function (event) {
    event.preventDefault();
    event.stopPropagation();

    console.log('Folder card right click:', {
      folderId: card.dataset["id"],
      folderTitle: card.querySelector<HTMLElement>('.card-title')?.textContent
    });

    // 确保文件夹上下文菜单存在
    if (!bookmarkFolderContextMenu) {
      bookmarkFolderContextMenu = createBookmarkFolderContextMenu();
    }

    if (!bookmarkFolderContextMenu) {
      console.error('Failed to create bookmark folder context menu');
      return;
    }

    // 更新当前文件夹
    currentBookmarkFolder = card;

    // 重新创建菜单项以反映当前文件夹的状态
    await createMenuItems(bookmarkFolderContextMenu);

    // 先显示菜单但设为不可见，以便获取其尺寸
    bookmarkFolderContextMenu.style.display = 'block';
    bookmarkFolderContextMenu.style.visibility = 'hidden';
    bookmarkFolderContextMenu.style.left = '0';
    bookmarkFolderContextMenu.style.top = '0';

    // 获取视窗尺寸
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // 等待一下以确保菜单已渲染
    const activeFolderMenu = bookmarkFolderContextMenu;
    setTimeout(() => {
      const menuRect = activeFolderMenu.getBoundingClientRect();

      // 计算最佳位置
      let left = event.clientX;
      let top = event.clientY;

      // 检查右侧空间
      if (left + menuRect.width > viewportWidth) {
        // 如果右侧空间不足，尝试将菜单放在点击位置的左侧
        left = Math.max(5, left - menuRect.width);
      }

      // 检查底部空间
      if (top + menuRect.height > viewportHeight) {
        // 如果底部空间不足，尝试将菜单放在点击位置的上方
        top = Math.max(5, viewportHeight - menuRect.height - 5);
      }

      // 应用计算后的位置
      activeFolderMenu.style.left = `${left}px`;
      activeFolderMenu.style.top = `${top}px`;

      // 使菜单可见
      activeFolderMenu.style.visibility = 'visible';
    }, 0);

    // 隐藏其他上下文菜单
    if (contextMenu) {
      contextMenu.style.display = 'none';
    }
  });

  return card;
}

const bookmarkListSortables = new WeakMap<HTMLElement, Sortable>();
let categoriesListSortable: Sortable | null = null;
const nestedFolderSortables: Sortable[] = [];

function bindBookmarkListSortable(bookmarksList: HTMLElement): void {
  if (bookmarkListSortables.has(bookmarksList)) return;
  const sortable = new Sortable(bookmarksList, {
    animation: 150,
    onEnd: function (evt) {
      const itemId = evt.item.dataset["id"];
      const newParentId = bookmarksList.dataset["parentId"];
      const newIndex = evt.newIndex;

      showMovingFeedback(evt.item);

      if (itemId === undefined || newParentId === undefined || newIndex === undefined) return;
      moveBookmark(itemId, newParentId, newIndex)
        .then(() => {
          hideMovingFeedback(evt.item);
          showSuccessFeedback(evt.item);
        })
        .catch(error => {
          console.error('Error moving bookmark:', error);
          hideMovingFeedback(evt.item);
          showErrorFeedback(evt.item);
          syncBookmarkOrder(newParentId);
        });
    }
  });
  bookmarkListSortables.set(bookmarksList, sortable);
}

function setupActiveBookmarkListSortable(): void {
  const bookmarksList = getActiveBookmarksList();
  if (bookmarksList) bindBookmarkListSortable(bookmarksList);
}

// 嵌套子列表的拖拽排序：仅在懒构建发生时按需绑定，不再对整棵树预建实例
function bindNestedFolderSortable(folder: HTMLUListElement): void {
  nestedFolderSortables.push(new Sortable(folder, {
    group: 'nested',
    animation: 150,
    fallbackOnBody: true,
    swapThreshold: 0.65,
    onStart: function (evt) {
      console.log('Subfolder drag started:', evt.item.dataset["id"]);
    },
    onEnd: function (evt) {
      const itemEl = evt.item;
      const newIndex = evt.newIndex;
      const bookmarkId = itemEl.dataset["id"];
      const newParentId = evt.to.closest<HTMLElement>('li')?.dataset["id"] ?? '1';

      console.log('Subfolder item moved:', {
        bookmarkId: bookmarkId,
        newParentId: newParentId,
        oldIndex: evt.oldIndex,
        newIndex: newIndex,
        fromList: evt.from.id,
        toList: evt.to.id
      });

      if (evt.oldIndex !== evt.newIndex || evt.from !== evt.to) {
        if (bookmarkId !== undefined && newIndex !== undefined) moveBookmark(bookmarkId, newParentId, newIndex);
      }
    }
  }));
}

function setupSidebarSortable(): void {
  const categoriesList = document.getElementById('categories-list');
  if (!categoriesList) {
    console.error('Categories list element not found');
    return;
  }

  categoriesListSortable?.destroy();
  nestedFolderSortables.forEach((sortable) => sortable.destroy());
  nestedFolderSortables.length = 0;

  categoriesListSortable = new Sortable(categoriesList, {
    animation: 150,
    group: 'nested',
    fallbackOnBody: true,
    swapThreshold: 0.65,
    onStart: function (evt) {
      console.log('Category drag started:', evt.item.dataset["id"]);
    },
    onEnd: function (evt) {
      const itemEl = evt.item;
      const newIndex = evt.newIndex;
      const bookmarkId = itemEl.dataset["id"];
      const newParentId = evt.to.closest<HTMLElement>('li')?.dataset["id"] ?? '1';

      console.log('Category moved:', {
        bookmarkId: bookmarkId,
        newParentId: newParentId,
        oldIndex: evt.oldIndex,
        newIndex: newIndex,
        fromList: evt.from.id,
        toList: evt.to.id
      });

      if (evt.oldIndex !== evt.newIndex || evt.from !== evt.to) {
        if (bookmarkId !== undefined && newIndex !== undefined) moveBookmark(bookmarkId, newParentId, newIndex);
      }
    }
  });
}

function moveBookmark(itemId: string, newParentId: string, newIndex: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.bookmarks.move(itemId, { index: newIndex }, (result) => {
      if (chrome.runtime.lastError) {
        console.error('Error moving bookmark:', chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
      } else {
        console.log(`Bookmark ${itemId} moved to index ${result.index}`);
        updateAffectedBookmarks(newParentId, itemId, result.index ?? newIndex)
          .then(() => {
            console.log(`Bookmark ${itemId} position updated in UI`);
            resolve();
          })
          .catch(reject);
      }
    });
  });
}

function updateAffectedBookmarks(parentId: string, movedItemId: string | undefined, newIndex: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const bookmarksList = getActiveBookmarksList();
    if (!bookmarksList) {
      reject(new Error('Bookmarks list not found'));
      return;
    }
    const bookmarkElements = Array.from(bookmarksList.children);
    const movedElement = bookmarksList.querySelector<HTMLElement>(`[data-id="${movedItemId}"]`);

    if (!movedElement) {
      console.error('Moved element not found');
      reject(new Error('Moved element not found'));
      return;
    }

    const oldIndex = bookmarkElements.indexOf(movedElement);

    // 如置没有变化，不需要更新
    if (oldIndex === newIndex) {
      resolve();
      return;
    }

    // 移动元素到新位置
    if (newIndex >= bookmarkElements.length) {
      bookmarksList.appendChild(movedElement);
    } else {
      bookmarksList.insertBefore(movedElement, bookmarksList.children[newIndex] ?? null);
    }

    // 更新所有书签的索引
    bookmarkElements.forEach((element, index) => {
      if (element instanceof HTMLElement) element.dataset["index"] = index.toString();
    });

    // 更新本地缓存
    bookmarkOrderCache[parentId] = bookmarkElements
      .map(el => el instanceof HTMLElement ? el.dataset["id"] : undefined)
      .filter((id): id is string => id !== undefined);

    if (movedItemId !== undefined) highlightBookmark(movedItemId);
    console.log(`UI updated: Bookmark ${movedItemId} moved from ${oldIndex} to ${newIndex}`);
    resolve();
  });
}

function highlightBookmark(itemId: string) {
  const bookmarkElement = document.querySelector<HTMLElement>(`[data-id="${itemId}"]`);
  if (bookmarkElement) {
    bookmarkElement.style.transition = 'background-color 0.5s ease';
    bookmarkElement.style.backgroundColor = '#ffff99';
    setTimeout(() => {
      bookmarkElement.style.backgroundColor = '';
    }, 1000);
  }
}

// 修改 displayBookmarkCategories 函数，添加清理逻辑
// 侧边栏书签树：只构建当前层级，子层级首次展开时懒构建；
// 点击用 #categories-list 上的事件委托，不再逐 li 绑定监听器
let sidebarClickDelegationBound = false;

function ensureSidebarClickDelegation(): void {
  if (sidebarClickDelegationBound) return;
  const categoriesList = document.getElementById('categories-list');
  if (!categoriesList) return;
  sidebarClickDelegationBound = true;

  categoriesList.addEventListener('click', function (event) {
    if (!(event.target instanceof Element)) return;
    const li = event.target.closest<HTMLElement>('li');
    if (!li || !categoriesList.contains(li)) return;
    event.stopPropagation();

    const folderId = li.dataset["id"];
    if (folderId === undefined) return;

    const sublist = li.nextElementSibling instanceof HTMLUListElement ? li.nextElementSibling : null;
    if (sublist) {
      const isExpanded = sublist.style.display === 'block';
      sublist.style.display = isExpanded ? 'none' : 'block';
      const arrowIcon = li.querySelector<HTMLElement>('.material-icons.ml-auto');
      if (arrowIcon) {
        arrowIcon.innerHTML = isExpanded ? ICONS.chevron_right : ICONS.expand_less;
      }
      // 首次展开时从缓存的整棵树懒构建子层级，并按需绑定嵌套拖拽
      if (!isExpanded && sublist.dataset["built"] !== '1') {
        buildSubfolderItems(sublist, folderId);
      }
    }

    document.querySelectorAll<HTMLElement>('#categories-list li').forEach(function (item) {
      item.classList.remove('bg-emerald-500');
    });
    li.classList.add('bg-emerald-500');

    void switchToFolder(folderId);
  });
}

// 侧边栏单个文件夹条目：li 与（仅有子文件夹可展开时的）空 sublist 占位
function createSidebarFolderItem(
  bookmark: BookmarkNode,
  level: number,
  expandedFolderId?: string,
): {
  readonly li: HTMLLIElement;
  readonly sublist: HTMLUListElement | null;
  readonly isInitiallyExpanded: boolean;
} {
  const li = document.createElement('li');
  li.className = 'cursor-pointer p-2 hover:bg-emerald-500 rounded-lg flex items-center folder-item';
  li.style.paddingLeft = `${(level * 20) + 8}px`;
  li.dataset["title"] = bookmark.title;
  li.dataset["id"] = bookmark.id;
  li.dataset["level"] = level.toString();

  const span = document.createElement('span');
  span.textContent = bookmark.title;

  const folderIcon = document.createElement('span');
  folderIcon.className = 'material-icons mr-2';
  folderIcon.innerHTML = ICONS.folder;
  li.insertBefore(folderIcon, li.firstChild);

  const hasSubfolders = bookmark.children?.some((child: BookmarkNode) => child.children) ?? false;
  const isInitiallyExpanded = bookmark.id === expandedFolderId;
  let sublist: HTMLUListElement | null = null;
  if (hasSubfolders) {
    const arrowIcon = document.createElement('span');
    arrowIcon.className = 'material-icons ml-auto';
    arrowIcon.innerHTML = isInitiallyExpanded ? ICONS.expand_less : ICONS.chevron_right;
    li.appendChild(arrowIcon);

    sublist = document.createElement('ul');
    sublist.className = 'pl-4 space-y-2';
    sublist.style.display = isInitiallyExpanded ? 'block' : 'none';
    sublist.dataset["built"] = '0';
  }

  li.appendChild(span);
  return { li, sublist, isInitiallyExpanded };
}

function appendSidebarFolderItems(
  container: HTMLElement,
  nodes: readonly BookmarkNode[],
  level: number,
  expandedFolderId?: string,
): void {
  for (const bookmark of nodes) {
    if (!bookmark.children || bookmark.children.length === 0) continue;
    const item = createSidebarFolderItem(bookmark, level, expandedFolderId);
    container.appendChild(item.li);
    if (item.sublist) container.appendChild(item.sublist);
    if (item.sublist && item.isInitiallyExpanded) buildSubfolderItems(item.sublist, bookmark.id);
  }
}

function buildSubfolderItems(sublist: HTMLUListElement, folderId: string): void {
  sublist.dataset["built"] = '1';
  const level = Number.parseInt(sublist.previousElementSibling instanceof HTMLElement
    ? sublist.previousElementSibling.dataset["level"] ?? '1'
    : '1', 10);
  appendSidebarFolderItems(sublist, findFolderNodeInTree(folderId)?.children ?? [], Number.isFinite(level) ? level + 1 : 1);
  bindNestedFolderSortable(sublist);
}

function displayBookmarkCategories(bookmarkNodes: BookmarkNode[], level: number, parentUl: HTMLUListElement | null, parentId: string) {
  const categoriesList = parentUl || document.getElementById('categories-list');
  if (!categoriesList) return;

  // 如果是根级调用，先清空现有内容
  if (!parentUl) {
    categoriesList.innerHTML = '';
  }

  if (parentId === '1') {
    categoriesList.style.display = 'block';
  }

  // 只构建首层；深层级由首次展开时的懒构建补齐
  appendSidebarFolderItems(categoriesList, bookmarkNodes, level, parentId);

  if (!parentUl) {
    ensureSidebarClickDelegation();
    setupSidebarSortable();
  }
}

// 添加一个获取文件夹内书签数量的函数

// 新增辅助函数

// 创建文件夹上下文菜单
function createBookmarkFolderContextMenu() {
  console.log('Creating folder context menu');

  // 移除任何已存在的上下文菜单
  const existingMenu = document.querySelector<HTMLElement>('.bookmark-folder-context-menu');
  if (existingMenu) {
    existingMenu.remove();
  }

  const menu = document.createElement('div');
  menu.className = 'bookmark-folder-context-menu custom-context-menu';
  document.body.appendChild(menu);

  // 异步创建菜单项
  createMenuItems(menu).catch(error => {
    console.error('Error creating menu items:', error);
  });

  return menu;
}

async function createMenuItems(menu: HTMLElement) {
  console.log('=== Creating Menu Items ===');
  console.log('Current bookmark folder:', currentBookmarkFolder);

  // 清空现有菜单项
  menu.innerHTML = '';

  // 每次创建菜单时重新检查当前文件夹的状态
  let isDefault = false;
  if (currentBookmarkFolder?.dataset?.["id"]) {
    try {
      // 确保在获取状态前等待 chrome.storage.local.get 完成
      const data = await chrome.storage.local.get('defaultFolders');
      const defaultFolders = getDefaultFolders(data["defaultFolders"]);
      isDefault = defaultFolders.some(folder => folder.id === currentBookmarkFolder?.dataset["id"]);

      console.log('Folder status check:', {
        folderId: currentBookmarkFolder.dataset["id"],
        isDefault: isDefault,
        defaultFolders: defaultFolders,
        folderTitle: currentBookmarkFolder.querySelector<HTMLElement>('.card-title')?.textContent
      });
    } catch (error) {
      console.error('Error checking default folder status:', error instanceof Error ? error : String(error));
      isDefault = false;
    }
  }

  const menuItems = [
    {
      text: getLocalizedMessage('openAllBookmarks'),
      icon: 'open_in_new',
      action: () => {
        if (currentBookmarkFolder) {
          const folderId = currentBookmarkFolder.dataset["id"];
          const folderTitle = currentBookmarkFolder.querySelector<HTMLElement>('.card-title')?.textContent ?? '';

          if (folderId === undefined) return;
          chrome.bookmarks.getChildren(folderId, (bookmarks) => {
            // 过滤出有效的书签URL
            const validUrls = bookmarks
              .filter(bookmark => bookmark.url)
              .map(bookmark => bookmark.url);

            if (validUrls.length > 0) {
              // 使用 chrome.runtime.sendMessage 发送消息给后台脚本
              chrome.runtime.sendMessage({
                action: 'openMultipleTabsAndGroup',
                urls: validUrls,
                groupName: folderTitle // 使用文件夹名称作为标签组名称
              }, (rawResponse: unknown) => {
                const response = getOpenMultipleTabsResponse(rawResponse);
                if (response?.success) {
                  console.log('Bookmarks opened in new tab group');
                } else {
                  console.error('Error opening bookmarks:', response?.error);
                }
              });
            }
          });
        }
      }
    },
    // 原有的菜单项
    { text: getLocalizedMessage('rename'), icon: 'edit', action: () => currentBookmarkFolder && openEditBookmarkFolderDialog(currentBookmarkFolder) },
    { text: getLocalizedMessage('delete'), icon: 'delete', action: () => {
      if (currentBookmarkFolder) {
        const folderId = currentBookmarkFolder.dataset["id"];
        const folderTitle = currentBookmarkFolder.querySelector<HTMLElement>('.card-title')?.textContent ?? '';
          const parentId = currentBookmarkFolder.dataset["parentId"] || '1';

          showConfirmDialog(chrome.i18n.getMessage("confirmDeleteFolder", [`<strong>${folderTitle}</strong>`]), async () => {
            try {
              if (folderId === undefined) return;
              await chrome.bookmarks.removeTree(folderId);

            // 1. 立即从 UI 中移除文件夹卡片
            const folderCard = document.querySelector<HTMLElement>(`.bookmark-folder[data-id="${folderId}"]`);
            if (folderCard) {
              folderCard.remove();
            }

            // 2. 从侧边栏中移除对应的文件夹及其所有子文件夹
            const sidebarFolder = document.querySelector<HTMLElement>(`#categories-list li[data-id="${folderId}"]`);
            if (sidebarFolder) {
              // 获取并移除所有子文件夹
              const subFolders = sidebarFolder.querySelectorAll<HTMLElement>('ul');
              subFolders.forEach(ul => ul.remove());
              sidebarFolder.remove();
            }

            // 3. 清除相关缓存
            bookmarksCache.delete(folderId);
            bookmarksCache.delete(parentId);

            // 4. 显示删除成功的 toast 消息
            Utilities.showToast(getLocalizedMessage('deleteSuccess'));

            // 5. 如果删除的是当前显示的文件夹，则返回上一级并重新加载
            const bookmarksList = getActiveBookmarksList();
            if (bookmarksList?.dataset["parentId"] === folderId) {
              await updateBookmarksDisplay(parentId);
              updateFolderName(parentId);
              selectSidebarFolder(parentId);
            }

            // 6. 重新加载父文件夹的内容
            const parentFolder = document.querySelector<HTMLElement>(`.bookmark-folder[data-id="${parentId}"]`);
            if (parentFolder) {
              await updateBookmarksDisplay(parentId);
            }

          } catch (error) {
            console.error('Error deleting folder:', error instanceof Error ? error : String(error));
            Utilities.showToast(getLocalizedMessage('deleteFolderError'));
          }
        });
      }
    }},
    {
      // 根据当前状态设置文本
      text: isDefault ? getLocalizedMessage('removeFromDefaultFolders') : getLocalizedMessage('addToDefaultFolders'),
      icon: isDefault ? 'keep_off' : 'keep',
      action: async () => {
        const folder = currentBookmarkFolder;
        console.log('Toggle default folder action triggered:', {
          folder: folder,
          folderId: folder?.dataset?.["id"],
          currentIsDefault: isDefault
        });

        if (!folder?.dataset?.["id"]) {
          console.error('No valid folder selected');
          return;
        }

        await toggleDefaultFolder(folder);

        // 重新获取当前状态
        const data = await chrome.storage.local.get('defaultFolders');
        const defaultFolders = getDefaultFolders(data["defaultFolders"]);
        const newIsDefault = defaultFolders.some(f => f.id === folder.dataset["id"]);

        console.log('Menu item status update:', {
          oldState: isDefault,
          newState: newIsDefault,
          folderId: folder.dataset["id"],
          defaultFolders: defaultFolders
        });

        const menuItem = menu.querySelector<HTMLElement>(`[data-action="toggleDefault"]`);
        if (menuItem) {
          const newText = getLocalizedMessage(newIsDefault ? 'removeFromDefaultFolders' : 'addToDefaultFolders');
          console.log('Updating menu item text to:', newText);

          const textElement = menuItem.querySelector<HTMLElement>('.text');
          if (textElement) textElement.textContent = newText;
          const iconElement = menuItem.querySelector<HTMLElement>('.icon-svg');
          if (iconElement) {
            iconElement.innerHTML = ICONS[newIsDefault ? 'keep_off' : 'keep'];
          }
        }
      }
    }
  ];

  // 创建菜单项
  menuItems.forEach((item, index) => {
    console.log(`Creating menu item ${index}:`, {
      text: item.text,
      icon: item.icon
    });
    const menuItem = document.createElement('div');
    menuItem.className = 'custom-context-menu-item';

    if (item.icon === 'keep' || item.icon === 'keep_off') {
      menuItem.dataset["action"] = 'toggleDefault';
    }

    const icon = document.createElement('span');
    icon.className = 'icon-svg';
    icon.innerHTML = getIconHtml(item.icon);
    if (item.icon === 'keep' || item.icon === 'keep_off') {
      icon.classList.toggle('selected', isDefault);
    }

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = item.text;

    menuItem.appendChild(icon);
    menuItem.appendChild(text);
    menuItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      await item.action();
      setTimeout(() => {
      menu.style.display = 'none';
      }, 100);
    });

    menu.appendChild(menuItem);
  });
}


// 添加文件夹相关的全局变量
// Add event listeners or logic that uses these variables


function openEditBookmarkFolderDialog(folderElement: HTMLElement) {
  const folderId = folderElement.dataset["id"];
  const folderTitle = folderElement.querySelector<HTMLElement>('.card-title')?.textContent ?? '';

  const editCategoryNameInput = requireElement(document.getElementById('edit-category-name'), HTMLInputElement, '#edit-category-name');
  const editCategoryDialog = requireElement(document.getElementById('edit-category-dialog'), HTMLElement, '#edit-category-dialog');
  const editCategoryForm = requireElement(document.getElementById('edit-category-form'), HTMLFormElement, '#edit-category-form');

  editCategoryNameInput.value = folderTitle;
  editCategoryDialog.style.display = 'block';

  if (folderId === undefined) return;
  editCategoryForm.onsubmit = function (event) {
    event.preventDefault();
    const newTitle = editCategoryNameInput.value;
    chrome.bookmarks.update(folderId, { title: newTitle }, function () {
      console.log('Bookmark updated:', folderId, newTitle);
      updateCategoryUI(folderId, newTitle);
      updateFolderName(folderId);
      editCategoryDialog.style.display = 'none';
    });
  };
}

function updateCategoryUI(folderId: string, newTitle: string) {
  // 更新侧边栏中的文件夹名称
  const sidebarItem = document.querySelector<HTMLElement>(`#categories-list li[data-id="${folderId}"]`);
  if (sidebarItem) {
    // 更新文本内容
    const textSpan = sidebarItem.querySelector<HTMLElement>('span:not(.material-icons)');
    if (textSpan) {
      textSpan.textContent = newTitle;
    }

    // 更新 data-title 属性
    sidebarItem.setAttribute('data-title', newTitle);

    // 更新样式
    sidebarItem.classList.add('updated-folder');
    setTimeout(() => {
      sidebarItem.classList.remove('updated-folder');
    }, 2000); // 2秒后移除高亮效果
  }

  // 更新面包屑导航
  updateFolderName(folderId);

  // 更新文件夹卡片（如果在当前视图中）
  const folderCard = document.querySelector<HTMLElement>(`.bookmark-folder[data-id="${folderId}"]`);
  if (folderCard) {
    const titleElement = folderCard.querySelector<HTMLElement>('.card-title');
    if (titleElement) {
      titleElement.textContent = newTitle;
    }
  }
}



function updateSidebarDefaultBookmarkIndicator() {
  const defaultBookmarkId = localStorage.getItem('defaultBookmarkId');
  if (defaultBookmarkId !== null) selectSidebarFolder(defaultBookmarkId);

  const allCategories = document.querySelectorAll<HTMLElement>('#categories-list li');
  allCategories.forEach(category => {
    const indicator = category.querySelector<HTMLElement>('.default-indicator');
    if (indicator) {
      indicator.remove();
    }
    if (category.dataset["id"] === defaultBookmarkId) {
      const defaultIndicator = document.createElement('span');
      defaultIndicator.className = 'default-indicator material-icons';
      defaultIndicator.textContent = 'star';
      defaultIndicator.title = getLocalizedMessage('homepage');
      category.appendChild(defaultIndicator);
    }
  });
}

// 添加局变量来存储本地缓存
let bookmarkOrderCache: Record<string, string[]> = {};

// 添加一函数来同步本地缓存和 Chrome 书签
function syncBookmarkOrder(parentId: string) {
  refreshBookmarkOrder(chrome.bookmarks, bookmarksCache, parentId, (bookmarks) => {
    displayBookmarks({ id: parentId, children: bookmarks });
  });
}

// 添加一个定期同步函数
function startBookmarkSync() {
  startBookmarkChangeSync(
    [
      chrome.bookmarks.onCreated,
      chrome.bookmarks.onRemoved,
      chrome.bookmarks.onChanged,
      chrome.bookmarks.onMoved,
      chrome.bookmarks.onChildrenReordered,
    ],
    () => getActiveBookmarksList()?.dataset["parentId"],
    syncBookmarkOrder,
    (error) => console.error('Error during bookmark sync:', error instanceof Error ? error : String(error)),
    // 书签事件风暴（批量导入/删除目录树）时合流，避免每个事件全量拉取+重渲
    { quietPeriodMs: 100 },
  );
}

let isRequestPending = false;
  void isRequestPending;

function setupSpecialLinks() {
  const specialLinks = document.querySelectorAll<HTMLElement>('.links-icons a, .settings-icon a');
  let isProcessingClick = false;

  specialLinks.forEach(link => {
    link.addEventListener('click', async function (e) {
      e.preventDefault();
      if (isProcessingClick) return;

      isProcessingClick = true;

      const href = this.getAttribute('href');
      let chromeUrl;
      switch (href) {
        case '#history':
          chromeUrl = 'chrome://history';
          break;
        case '#downloads':
          chromeUrl = 'chrome://downloads';
          break;
        case '#passwords':
          chromeUrl = 'chrome://settings/passwords';
          break;
        case '#extensions':
          chromeUrl = 'chrome://extensions';
          break;
        case '#settings':
          document.dispatchEvent(new Event('markstart:open-settings'));
          isProcessingClick = false;
          return;
        default:
          console.error('Unknown special link:', href);
          isProcessingClick = false;
          return;
      }

      try {
        // 直接使用 chrome.tabs.create 打开新标签页
        chrome.tabs.create({ url: chromeUrl }, (_tab) => {
          if (chrome.runtime.lastError) {
            console.error('Failed to open tab:', chrome.runtime.lastError);
          }
        });
      } catch (error) {
        console.error('Error opening internal page:', error instanceof Error ? error : String(error));
      } finally {
        setTimeout(() => {
          isProcessingClick = false;
        }, 1000);
      }
    });
  });
}

function updateDefaultBookmarkIndicator() {
  const defaultBookmarkId = localStorage.getItem('defaultBookmarkId');
  const allBookmarks = document.querySelectorAll<HTMLElement>('.bookmark-card, .bookmark-folder');
  allBookmarks.forEach(bookmark => {
    const indicator = bookmark.querySelector<HTMLElement>('.default-indicator');
    if (indicator) {
      indicator.remove();
    }
    if (bookmark.dataset["id"] === defaultBookmarkId) {
      const defaultIndicator = document.createElement('span');
      defaultIndicator.className = 'default-indicator material-icons';
      defaultIndicator.textContent = 'star';
      defaultIndicator.title = getLocalizedMessage('homepage');
      bookmark.appendChild(defaultIndicator);
    }
  });
}

function selectSidebarFolder(folderId: string) {
  const allFolders = document.querySelectorAll<HTMLElement>('#categories-list li');
  allFolders.forEach(folder => {
    folder.classList.remove('bg-emerald-500');
    if (folder.dataset["id"] === folderId) {
      folder.classList.add('bg-emerald-500');
    }
  });
}

// 在缓存的整棵书签树里查找目标文件夹节点；树未加载时返回 undefined
function findFolderNodeInTree(folderId: string): BookmarkNode | undefined {
  const root = bookmarkTreeNodes[0];
  if (!root) return undefined;

  const pending: BookmarkNode[] = [...(root.children ?? [])];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (node.id === folderId) return node;
    if (node.children) pending.push(...node.children);
  }
  return undefined;
}

// 统计目标文件夹内的 http 书签数（含子层级）；树未加载时返回 null，由调用方回退到逐层 IPC 递归
function countHttpBookmarksInTree(folderId: string): number | null {
  const target = findFolderNodeInTree(folderId);
  if (!target?.children) return null;

  let count = 0;
  const countUrls = (nodes: readonly BookmarkNode[]): void => {
    for (const node of nodes) {
      if (node.url?.startsWith('http')) count += 1;
      if (node.children) countUrls(node.children);
    }
  };
  countUrls(target.children);
  return count;
}

// 确在 DOMContentLoaded 事件初始化上文菜单
// 文件夹右键菜单在首次右键时惰性创建，不再启动即构建




// 保留原有的DOMContentLoaded事件监听器，但移除其中的背景应用逻辑
document.addEventListener('DOMContentLoaded', function () {

  // 在页面加载完成后立即检查 folder-name 元素
  const folderNameElement = getActiveFolderName();
  if (!folderNameElement) return;


  function waitForFirstCategoryEdge(attemptsLeft: number) {
    waitForFirstCategory(attemptsLeft);
  }



  function isEdgeBrowser() {
    return /Edg/.test(navigator.userAgent);
  }

  if (isEdgeBrowser()) {
    waitForFirstCategoryEdge(10);
  } else {
    waitForFirstCategory(10);
  }

  const toggleSidebarButton = requireElement(document.getElementById('toggle-sidebar'), HTMLElement, '#toggle-sidebar');
  const sidebarContainer = requireElement(document.getElementById('sidebar-container'), HTMLElement, '#sidebar-container');

  // 读保存的侧边栏状态
  const isSidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';

  // 初状
  function setSidebarState(isCollapsed: boolean) {
    if (isCollapsed) {
      sidebarContainer.classList.add('collapsed');
      toggleSidebarButton.textContent = '>';
      toggleSidebarButton.style.left = '2rem'; // 收起时的位置
    } else {
      sidebarContainer.classList.remove('collapsed');
      toggleSidebarButton.textContent = '<';
      toggleSidebarButton.style.left = '14.75rem'; // 展开时的位置
    }
  }

  // 应用初始状态
  setSidebarState(isSidebarCollapsed);

  // 切换侧边状态的函数
  function toggleSidebar() {
    const isCollapsed = sidebarContainer.classList.toggle('collapsed');
    setSidebarState(isCollapsed);
    localStorage.setItem('sidebarCollapsed', String(isCollapsed));
  }

  // 添加点击事件监听器
  toggleSidebarButton.addEventListener('click', toggleSidebar);

  // 侧边栏文件夹点击由 displayBookmarkCategories 的 li 监听器处理
  //（其中调用了 stopPropagation），document 级重复监听已移除。
  // updateBookmarkCards 已在首个 DOMContentLoaded 块中调用，不再重复执行。

  const editDialog = requireElement(document.getElementById('edit-dialog'), HTMLElement, '#edit-dialog');
  const closeButton = requireElement(document.querySelector('.close-button'), HTMLElement, '.close-button');
  const cancelButton = requireElement(document.querySelector('.cancel-button'), HTMLElement, '.cancel-button');


  closeButton.onclick = function () {
    editDialog.style.display = 'none';
  };

  cancelButton.onclick = function () {
    editDialog.style.display = 'none';
  };

  window.onclick = function (event) {
    if (event.target == editDialog) {
      editDialog.style.display = 'none';
    }
  };








  let currentCategory: HTMLElement | null = null;
  // 递归获取所有书签数量的函数
  const getAllBookmarksCount = async (folderId: string, maxDepth = 5): Promise<number> => {
    let count = 0;
    let depth = 0;

    async function countBookmarks(id: string, currentDepth: number): Promise<number> {
      if (currentDepth > maxDepth) return 0;

      return new Promise<number>(resolve => {
        chrome.bookmarks.getChildren(id, async (items) => {
          let localCount = 0;

          for (const item of items) {
            if (item.url && item.url.startsWith('http')) {
              localCount++;
            } else if (currentDepth < maxDepth) {
              localCount += await countBookmarks(item.id, currentDepth + 1);
            }
          }

          resolve(localCount);
        });
      });
    }

    count = await countBookmarks(folderId, depth);
    return count;
  };
  // 1. 批量创建标签页的函数

  function createCategoryContextMenu() {
    const menu = document.createElement('div');
    menu.className = 'custom-context-menu';
    document.body.appendChild(menu);

    // 创建基本菜单项
    const createMenuItems = async (bookmarkCount: number) => {
      // 检查当前文件夹是否为默认文件夹
      let isDefault = false;
      if (currentCategory?.dataset?.["id"]) {
        try {
          const data = await chrome.storage.local.get('defaultFolders');
          const defaultFolders = getDefaultFolders(data["defaultFolders"]);
          isDefault = defaultFolders.some(folder => folder.id === currentCategory?.dataset["id"]);
        } catch (error) {
          console.error('Error checking default folder status:', error instanceof Error ? error : String(error));
        }
      }

      const menuItems = [
        {
          text: `${getLocalizedMessage('openAllBookmarks')} (${bookmarkCount})`,
          icon: 'open_in_new',
          action: () => {
            if (currentCategory) {
              const folderId = currentCategory.dataset["id"];
              const folderTitle = currentCategory.dataset["title"];

              // 递归获取所有书签 URL 的函数
              const getAllBookmarkUrls = async (folderId: string): Promise<string[]> => {
                return new Promise<string[]>(resolve => {
                  chrome.bookmarks.getChildren(folderId, async (items) => {
                    let urls: string[] = [];
                    for (const item of items) {
                      if (item.url) {
                        urls.push(item.url);
                      } else {
                        // 递归获取子文件夹的 URLs
                        const subUrls = await getAllBookmarkUrls(item.id);
                        urls = urls.concat(subUrls);
                      }
                    }
                    resolve(urls);
                  });
                });
              };

              // 获取并打开所有书签
              if (folderId === undefined) return;
              getAllBookmarkUrls(folderId).then((validUrls: string[]) => {
                if (validUrls.length > 0) {
                  // 使用 background.js 中的优化函数
                  chrome.runtime.sendMessage({
                    action: 'openMultipleTabsAndGroup',
                    urls: validUrls,
                    groupName: folderTitle
                  }, (rawResponse: unknown) => {
                    const response = getOpenMultipleTabsResponse(rawResponse);
                    if (response?.success) {
                      console.log('Bookmarks opened in new tab group');
                    } else {
                      console.error('Error opening bookmarks:', response?.error);
                    }
                  });
                }
              });
            }
          }
        },
        // 原有的菜单项保持不变
        { text: getLocalizedMessage('rename'), icon: 'edit' },
        { text: getLocalizedMessage('delete'), icon: 'delete' },
        {
          text: isDefault ? getLocalizedMessage('removeFromDefaultFolders') : getLocalizedMessage('addToDefaultFolders'),
          icon: isDefault ? 'keep_off' : 'keep',
          action: async () => {
            if (!currentCategory?.dataset?.["id"]) {
              console.error('No valid folder selected');
              return;
            }
            await toggleDefaultFolder(currentCategory);
          }
        }
      ];

      // 清空现有菜单项
      menu.innerHTML = '';

      // 创建菜单项的其余代码保持不变...
      menuItems.forEach(item => {
        const menuItem = document.createElement('div');
        menuItem.className = 'custom-context-menu-item';

        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.innerHTML = getIconHtml(item.icon);
        icon.style.marginRight = '8px';
        icon.style.fontSize = '18px';

        const text = document.createElement('span');
        text.textContent = item.text;

        menuItem.appendChild(icon);
        menuItem.appendChild(text);

        menuItem.addEventListener('click', function () {
          if (item.action) {
            item.action();
          } else {
            switch (item.text) {
              case getLocalizedMessage('rename'):
                if (currentCategory) openEditCategoryDialog(currentCategory);
                break;
              case getLocalizedMessage('delete'):
                if (!currentCategory) return;
                const category = currentCategory;
                const categoryId = category.dataset["id"];
                const categoryTitle = category.dataset["title"];
                showConfirmDialog(chrome.i18n.getMessage("confirmDeleteFolder", [`<strong>${categoryTitle}</strong>`]), () => {
                  if (categoryId === undefined) return;
                  chrome.bookmarks.removeTree(categoryId, function () {
                    category.remove();
                    Utilities.showToast(getLocalizedMessage('categoryDeleted'));
                  });
                });
                break;
            }
          }
          menu.style.display = 'none';
        });

        menu.appendChild(menuItem);
      });
    };

    return {
      menu: menu,
      updateMenuItems: createMenuItems
    };
  }

  const categoryContextMenu = createCategoryContextMenu();

  document.addEventListener('contextmenu', function (event) {
    if (!(event.target instanceof Element)) return;
    const targetCategory = event.target.closest<HTMLElement>('#categories-list li');
    if (targetCategory) {
      event.preventDefault();
      currentCategory = targetCategory;

      if (currentCategory) {
        const folderId = currentCategory.dataset["id"];
        if (folderId === undefined) return;

        const showMenu = (totalCount: number): void => {
          categoryContextMenu.updateMenuItems(totalCount);

          categoryContextMenu.menu.style.top = `${event.clientY}px`;
          categoryContextMenu.menu.style.left = `${event.clientX}px`;
          categoryContextMenu.menu.style.display = 'block';
        };

        // 优先用已缓存的整棵树在内存里数数，缓存缺失时回退到逐层 IPC 递归
        const cachedCount = countHttpBookmarksInTree(folderId);
        if (cachedCount !== null) {
          showMenu(cachedCount);
        } else {
          getAllBookmarksCount(folderId).then(showMenu);
        }
      }
    } else {
      categoryContextMenu.menu.style.display = 'none';
    }
  });

  document.addEventListener('click', function () {
    categoryContextMenu.menu.style.display = 'none';
  });

  const editCategoryDialog = requireElement(document.getElementById('edit-category-dialog'), HTMLElement, '#edit-category-dialog');
  const editCategoryForm = requireElement(document.getElementById('edit-category-form'), HTMLFormElement, '#edit-category-form');
  const editCategoryNameInput = requireElement(document.getElementById('edit-category-name'), HTMLInputElement, '#edit-category-name');
  const closeCategoryButton = requireElement(document.querySelector('.close-category-button'), HTMLElement, '.close-category-button');
  const cancelCategoryButton = requireElement(document.querySelector('.cancel-category-button'), HTMLElement, '.cancel-category-button');

  function openEditCategoryDialog(categoryElement: HTMLElement) {
    const categoryId = categoryElement.dataset["id"];
    const categoryTitle = categoryElement.dataset["title"];

    editCategoryNameInput.value = categoryTitle ?? '';

    editCategoryDialog.style.display = 'block';

    editCategoryForm.onsubmit = function (event) {
      event.preventDefault();
      const updatedTitle = editCategoryNameInput.value;

      if (categoryId === undefined) return;
      chrome.bookmarks.update(categoryId, {
        title: updatedTitle
      }, function (_result) {
        updateCategoryUI(categoryElement, updatedTitle);
        editCategoryDialog.style.display = 'none';
      });
    };
  }

  function updateCategoryUI(categoryElement: HTMLElement, newTitle: string) {
    // 更新侧边栏中的文件夹名称
    const sidebarItem = document.querySelector<HTMLElement>(`#categories-list li[data-id="${categoryElement.dataset["id"]}"]`);
    if (sidebarItem) {
      // 更新文本内容
      const textSpan = sidebarItem.querySelector<HTMLElement>('span:not(.material-icons)');
      if (textSpan) {
        textSpan.textContent = newTitle;
      }

      // 更新 data-title 属性
      sidebarItem.setAttribute('data-title', newTitle);

      // 更新样式
      sidebarItem.classList.add('updated-folder');
      setTimeout(() => {
        sidebarItem.classList.remove('updated-folder');
      }, 2000); // 2秒后移除高亮效果
    }

    // 更新面包屑导航
    const categoryId = categoryElement.dataset["id"];
    if (categoryId !== undefined) updateFolderName(categoryId);

    // 更新文件夹卡片（如果在当前视图中）
    const folderCard = document.querySelector<HTMLElement>(`.bookmark-folder[data-id="${categoryElement.dataset["id"]}"]`);
    if (folderCard) {
      const titleElement = folderCard.querySelector<HTMLElement>('.card-title');
      if (titleElement) {
        titleElement.textContent = newTitle;
      }
    }
  }

  closeCategoryButton.onclick = function () {
    editCategoryDialog.style.display = 'none';
  };

  cancelCategoryButton.onclick = function () {
    editCategoryDialog.style.display = 'none';
  };

  window.onclick = function (event) {
    if (event.target == editCategoryDialog) {
      editCategoryDialog.style.display = 'none';
    }
  };



  initializeSearchInteractions();
});



// 搜索引擎下拉已在首个 DOMContentLoaded 块中初始化，此处不再重复调用






  // setVersionNumber 由下方带 100ms 延迟的注册统一触发，不再重复注册

  // 修改文档点击事件监听器，同时处理书签和文件夹的上下文菜单
  document.addEventListener('click', function (_event) {
    // 关闭书签上下文菜单
    if (contextMenu) {
      contextMenu.style.display = 'none';
      currentBookmark = null;
    }

    // 关闭文件夹上下文菜单
    if (bookmarkFolderContextMenu) {
      bookmarkFolderContextMenu.style.display = 'none';
      currentBookmarkFolder = null;
    }
  });

  // 为上下文菜单添加阻止冒泡，防止点击菜单本身时关闭
  const activeContextMenu = document.querySelector<HTMLElement>('.custom-context-menu');
  if (activeContextMenu) {
    activeContextMenu.addEventListener('click', function(event: Event) {
      event.stopPropagation();
    });
  }

  const activeFolderContextMenu = document.querySelector<HTMLElement>('.bookmark-folder-context-menu');
  if (activeFolderContextMenu) {
    activeFolderContextMenu.addEventListener('click', function(event: Event) {
      event.stopPropagation();
    });
  }

  // 添加一个全局函数用于更新快捷链接显示状态
  function updateQuickLinksVisibility() {
    chrome.storage.sync.get(['enableQuickLinks'], function(rawResult: unknown) {
      const enableQuickLinks = getBooleanProperty(rawResult, 'enableQuickLinks');
      const quickLinksWrapper = document.querySelector<HTMLElement>('.quick-links-wrapper');
      if (quickLinksWrapper) {
        quickLinksWrapper.style.display = enableQuickLinks !== false ? 'flex' : 'none';
      }
    });
  }

  // 监听存储变化
  chrome.storage.onChanged.addListener(function(changes, namespace) {
    if (namespace === 'sync' && changes["enableQuickLinks"]) {
      updateQuickLinksVisibility();
    }
  });

  // 添加搜索引擎变更事件监听
  document.addEventListener('defaultSearchEngineChanged', (event) => {
    if (!(event instanceof CustomEvent) || !isUnknownRecord(event.detail)) return;
    const engine = event.detail['engine'];
    if (typeof engine !== 'string') return;
    console.log('[Search] Default engine changed:', engine);
    // 可以在这里添加其他需要响应搜索引擎变更的逻辑
    createTemporarySearchTabs(); // 添加这行以更新临时搜索标签
  });


  // 新增辅助函数


  async function toggleDefaultFolder(folder: HTMLElement) {
    if (!folder?.dataset?.["id"]) {
      console.error('Invalid folder object:', folder);
      return;
    }

    const folderId = folder.dataset["id"];
    // 根据不同的文件夹元素结构获取文件夹名称
    let folderName;
    if (folder.classList.contains('bookmark-folder')) {
        // 主内容区的文件夹卡片
        folderName = folder.querySelector<HTMLElement>('.card-title')?.textContent;
    } else {
        // 侧边栏的文件夹
        folderName = folder.dataset["title"] || folder.textContent.trim();
    }

    console.log('Toggle default folder:', {
        folderId,
        folderName,
        element: folder
    });

    if (!folderName) {
        console.error('Could not find folder name');
        return;
    }

    try {
        const data = await chrome.storage.local.get('defaultFolders');
        let defaultFolders = getDefaultFolders(data["defaultFolders"]);
        const isDefault = defaultFolders.some(f => f.id === folderId);

        if (isDefault) {
            defaultFolders = defaultFolders.filter(f => f.id !== folderId);
            defaultFolders = defaultFolders.map((f, index: number) => ({
                ...f,
                order: index
            }));
            showToast(chrome.i18n.getMessage("removedFromDefaultFolders", [folderName]));
        } else {
            if (defaultFolders.length >= 8) {
                showToast(chrome.i18n.getMessage("maxDefaultFoldersReached"));
                return;
            }
            defaultFolders.push({
                id: folderId,
                name: folderName,
                order: defaultFolders.length
            });
            showToast(chrome.i18n.getMessage("addedToDefaultFolders", [folderName]));
        }

        await chrome.storage.local.set({
            defaultFolders: {
                items: defaultFolders,
                lastUpdated: Date.now()
            }
        });

        // 立即更新UI
        await initDefaultFoldersTabs();

        // 如果是新添加的默认文件夹，自动切换到该文件夹
        if (!isDefault) {
            await switchToFolder(folderId);
        }

        // 触发更新事件
        document.dispatchEvent(new CustomEvent('defaultFoldersChanged', {
            detail: { folders: defaultFolders }
        }));

    } catch (error) {
        console.error('Error toggling default folder:', error instanceof Error ? error : String(error));
        showToast('操作失败，请重试');
    }
  }





  // 默认文件夹变化时，toggleDefaultFolder 已直接调用 initDefaultFoldersTabs，
  // 此处若再监听重建会导致一次点击两轮全量重建
  // 在文档加载完成后初始化
  document.addEventListener('DOMContentLoaded', async () => {
    await initDefaultFoldersTabs();
  });



// 获取版本号并设置
function setVersionNumber() {
  const manifest = chrome.runtime.getManifest();
  const versionElement = document.querySelector<HTMLElement>('.about-version');

  if (versionElement && manifest) {
    // 移除 data-i18n 属性，因为我们要直接设置完整的本地化文本
    versionElement.removeAttribute('data-i18n');

    // 获取本地化的版本号文本并设置
    const versionText = chrome.i18n.getMessage('version', [manifest.version]);
    versionElement.textContent = versionText;
  }
}

// 确保在 DOM 加载完成后调用
document.addEventListener('DOMContentLoaded', () => {
  // 延迟一小段时间执行，确保其他初始化完成
  setTimeout(setVersionNumber, 100);
});

function updateDefaultFoldersTabsVisibility() {
  const defaultFoldersTabs = document.querySelector<HTMLElement>('.default-folders-tabs');
  const tabsContainer = document.querySelector<HTMLElement>('.tabs-container');
  if (!defaultFoldersTabs || !tabsContainer) return;
  defaultFoldersTabs.classList.toggle('show', tabsContainer.querySelectorAll('.folder-tab').length > 0);
}

// 在标签更新时调用
document.addEventListener('defaultFoldersChanged', updateDefaultFoldersTabsVisibility);

// 添加滚动指示器功能
function ensureScrollIndicator(bookmarksContainer: HTMLElement, bookmarksList: HTMLElement): void {
  if (bookmarksContainer.querySelector('.scroll-indicator')) return;

  // 创建滚动指示器
  const scrollIndicator = document.createElement('div');
  scrollIndicator.className = 'scroll-indicator';
  scrollIndicator.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="7 13 12 18 17 13"></polyline>
      <polyline points="7 6 12 11 17 6"></polyline>
    </svg>
  `;
  bookmarksContainer.appendChild(scrollIndicator);

  // 滚动状态变量
  let scrollTimeout: ReturnType<typeof setTimeout> | undefined;
  let isScrolling = false;

  // 检查是否需要滚动
  function checkScrollable() {
    const isScrollable = bookmarksList.scrollHeight > bookmarksList.clientHeight;

    if (isScrollable) {
      scrollIndicator.style.display = 'flex';
      // 添加动画类
      if (!scrollIndicator.classList.contains('animate')) {
        scrollIndicator.classList.add('animate');
        // 5秒后移除动画
        setTimeout(() => {
          scrollIndicator.classList.remove('animate');
        }, 5000);
      }
    } else {
      scrollIndicator.style.display = 'none';
    }
  }

  // 监听滚动事件
  bookmarksList.addEventListener('scroll', () => {
    // 如果已经滚动到底部，隐藏指示器
    const isAtBottom = bookmarksList.scrollHeight - bookmarksList.scrollTop <= bookmarksList.clientHeight + 10;
    if (isAtBottom) {
      scrollIndicator.style.opacity = '0';
    } else {
      scrollIndicator.style.opacity = '';
    }

    // 添加滚动中的类
    if (!isScrolling) {
      isScrolling = true;
      bookmarksList.classList.add('scrolling');
    }

    // 清除之前的定时器
    clearTimeout(scrollTimeout);

    // 设置新的定时器，滚动停止1.5秒后移除滚动中的类
    scrollTimeout = setTimeout(() => {
      isScrolling = false;
      bookmarksList.classList.remove('scrolling');
    }, 1500);
  });

  // 鼠标进入书签列表时，如果可滚动，添加滚动中的类
  bookmarksList.addEventListener('mouseenter', () => {
    if (bookmarksList.scrollHeight > bookmarksList.clientHeight) {
      bookmarksList.classList.add('scrolling');

      // 鼠标离开时，如果不在滚动，移除滚动中的类
      const handleMouseLeave = () => {
        if (!isScrolling) {
          bookmarksList.classList.remove('scrolling');
        }
        bookmarksList.removeEventListener('mouseleave', handleMouseLeave);
      };

      bookmarksList.addEventListener('mouseleave', handleMouseLeave);
    }
  });

  // 初始检查和窗口大小变化时重新检查；列表被 swiper rebuild 替换后
  // 通过 isConnected 自检释放全局监听与观察器，避免旧 slide 整树无法回收
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    observer.disconnect();
    window.removeEventListener('resize', onResize);
  };

  const guardedCheckScrollable = (): void => {
    if (!bookmarksList.isConnected) {
      release();
      return;
    }
    checkScrollable();
  };

  const onResize = debounce({ delay: 200 }, guardedCheckScrollable);
  const observer = new MutationObserver(debounce({ delay: 200 }, guardedCheckScrollable));

  observer.observe(bookmarksList, { childList: true });
  window.addEventListener('resize', onResize);
  guardedCheckScrollable();

  // 点击指示器滚动到下一屏
  scrollIndicator.addEventListener('click', () => {
    const currentScroll = bookmarksList.scrollTop;
    const nextScroll = currentScroll + bookmarksList.clientHeight * 0.8;
    bookmarksList.scrollTo({
      top: nextScroll,
      behavior: 'smooth'
    });

    // 点击时添加滚动中的类
    bookmarksList.classList.add('scrolling');
    isScrolling = true;

    // 清除之前的定时器
    clearTimeout(scrollTimeout);

    // 设置新的定时器
    scrollTimeout = setTimeout(() => {
      isScrolling = false;
      bookmarksList.classList.remove('scrolling');
    }, 1500);
  });

  // 监听触摸事件，支持触摸设备
  bookmarksList.addEventListener('touchstart', () => {
    bookmarksList.classList.add('scrolling');
    isScrolling = true;

    // 清除之前的定时器
    clearTimeout(scrollTimeout);
  });

  bookmarksList.addEventListener('touchend', () => {
    // 设置新的定时器，触摸结束后1.5秒移除滚动中的类
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      isScrolling = false;
      bookmarksList.classList.remove('scrolling');
    }, 1500);
  });

  // 初始检查和窗口大小变化时重新检查
}
