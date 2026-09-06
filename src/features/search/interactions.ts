import Sortable from 'sortablejs';
import { SearchEngineManager, getSearchUrl, updateSearchEngineIcon } from './dropdown';
import { createFaviconUrl } from '../../shared/favicon';

type BookmarkNode = chrome.bookmarks.BookmarkTreeNode;
type SearchSuggestion = {
  readonly text: string;
  readonly type: 'search' | 'bookmark' | 'history' | 'bing_suggestion';
  readonly url?: string;
  relevance: number;
  readonly timestamp?: number;
  readonly userRelevance?: number;
};
type RecentHistorySuggestion = SearchSuggestion & {
  readonly domain: string;
  readonly url: string;
  readonly timestamp: number;
};
type SearchBehavior = {
  count: number;
  lastUsed: number;
};
type SearchBehaviorMap = Record<string, SearchBehavior>;
type OpenMultipleTabsResponse = {
  readonly success: boolean;
  readonly error?: string;
};
type ElementConstructor<T extends Element> = new () => T;

declare global {
  interface Window {
    lastSearchTrigger?: 'cmdCtrlEnter';
  }
}

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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getBooleanProperty(value: unknown, key: string): boolean | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const property = value[key];
  return typeof property === 'boolean' ? property : undefined;
}

function getOpenMultipleTabsResponse(value: unknown): OpenMultipleTabsResponse | null {
  if (!isUnknownRecord(value) || typeof value['success'] !== 'boolean') return null;
  const error = value['error'];
  return typeof error === 'string'
    ? { success: value['success'], error }
    : { success: value['success'] };
}

// 搜索建议设置（showHistorySuggestions / showBookmarkSuggestions）模块级缓存：
// 首次用到时读一次，storage 变更时通过 onChanged 失效，避免每次输入都读 chrome.storage
let suggestionSettingsCache: Record<string, unknown> | undefined;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes['showHistorySuggestions'] !== undefined || changes['showBookmarkSuggestions'] !== undefined) {
    suggestionSettingsCache = undefined;
  }
});

function getSuggestionSettings(): Promise<Record<string, unknown>> {
  if (suggestionSettingsCache !== undefined) {
    return Promise.resolve(suggestionSettingsCache);
  }
  return new Promise<Record<string, unknown>>(resolve => {
    chrome.storage.sync.get(
      ['showHistorySuggestions', 'showBookmarkSuggestions'],
      (rawResult: unknown) => {
        suggestionSettingsCache = isUnknownRecord(rawResult) ? rawResult : {};
        resolve(suggestionSettingsCache);
      }
    );
  });
}

export function initializeSearchInteractions(): void {
  const tabsContainer = requireElement(document.getElementById('tabs-container'), HTMLElement, '#tabs-container');
  const tabs = document.querySelectorAll<HTMLElement>('.tab');
  const defaultSearchEngine = localStorage.getItem('selectedSearchEngine') || 'Google';

  // 在文件的适当位置（可能在 DOMContentLoaded 事件监听器内）添加这个标志
  let isChangingSearchEngine = false;

  // 将 getSearchUrl 函数移到文件前面，在事件监听器之前定义




  tabs.forEach(tab => {
    tab.setAttribute('tabindex', '0');

    tab.addEventListener('click', function () {
        const selectedEngine = this.getAttribute('data-engine') ?? defaultSearchEngine;
        const searchInput = document.querySelector<HTMLTextAreaElement>('.search-input');
        if (!searchInput) return;
        const searchQuery = searchInput.value.trim();

        // 移除所有标签的激活状态
        tabs.forEach(t => t.classList.remove('active'));
        // 为当前点击的标签添加激活状态
        this.classList.add('active');

        // 如果搜索框有内容，立即执行搜索
        if (searchQuery) {
            const searchUrl = getSearchUrl(selectedEngine, searchQuery);
            window.open(searchUrl, '_blank');
            hideSuggestions();

            // 使用 setTimeout 延迟恢复默认搜索引擎状态
            setTimeout(restoreDefaultSearchEngine, 300);
        }
    });
  });

  new Sortable(tabsContainer, {
    animation: 150,
    onEnd: function (_evt) {
      const orderedEngines = Array.from(tabsContainer.children).map(tab => tab.getAttribute('data-engine'));
      localStorage.setItem('orderedSearchEngines', JSON.stringify(orderedEngines));
    }
  });

  const savedOrderValue: unknown = JSON.parse(localStorage.getItem('orderedSearchEngines') ?? 'null');
  if (Array.isArray(savedOrderValue) && savedOrderValue.every((value): value is string => typeof value === 'string')) {
    const savedOrder = savedOrderValue;
    savedOrder.forEach((engineName: string) => {
      const tab = Array.from(tabs).find(tab => tab.getAttribute('data-engine') === engineName);
      if (tab) {
        tabsContainer.appendChild(tab);
      }
    });
  }

  const searchForm = requireElement(document.getElementById('search-form'), HTMLElement, '#search-form');
  const searchInput = requireElement(document.querySelector('.search-input'), HTMLTextAreaElement, '.search-input');

  // 建议查询递增 id：异步查询返回时若已过期则丢弃，防止慢查询晚返回覆盖新结果
  let suggestionQueryId = 0;

  searchInput.addEventListener('focus', async function () {
    const requestId = ++suggestionQueryId;
    searchForm.classList.add('focused');
    if (searchInput.value.trim() === '') {
      await showDefaultSuggestions(requestId);
    } else {
      const suggestions = await getSuggestions(searchInput.value.trim());
      if (requestId !== suggestionQueryId) return;
      showSuggestions(suggestions);
    }
  });

  searchInput.addEventListener('blur', () => {
    const searchForm = requireElement(document.querySelector('.search-form'), HTMLElement, '.search-form');
    searchForm.classList.remove('focused');
    // 使用 setTimeout 来延迟隐藏建议列表，允许点击建议
    setTimeout(() => {
      if (!searchForm.contains(document.activeElement)) {
        hideSuggestions();
      }
    }, 200);
  });

  updateSubmitButtonState();





  let isSearching = false;
  let searchQueue: string[] = [];



  const debouncedPerformSearch = debounce(performSearch, 300);

  // Modify the search form submit event listener
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault(); // Prevent default form submission
    performSearch(searchInput.value.trim());
  });




  // 修改 performSearch 函数
  function performSearch(query: string) {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return;
    }

    isSearching = true;

    // 获取当前激活的搜索引擎用于本次搜索
    const activeTab = document.querySelector<HTMLElement>('.tab.active');
    const currentEngine = activeTab ? activeTab.getAttribute('data-engine') : defaultSearchEngine;
    console.log('[Search] Current engine for search:', currentEngine);

    // 获取真正的默认搜索引擎
    const defaultEngine = localStorage.getItem('selectedSearchEngine') || 'google';
    let url = getSearchUrl(currentEngine ?? defaultSearchEngine, query);

    // 在打开新窗口之前先恢复默认搜索引擎
    requestAnimationFrame(() => {
      // 1. 恢复 tabs-container 中的默认选中状态
      const tabs = document.querySelectorAll<HTMLElement>('.tab');
      console.log('[Search] Found tabs:', tabs.length);

      // 清除所有临时标记
      tabs.forEach(tab => {
        delete tab.dataset["temporary"];
        if (tab.getAttribute('data-engine')?.toLowerCase() === defaultEngine.toLowerCase()) {
          console.log('[Search] Setting active tab:', defaultEngine);
          tab.classList.add('active');
        } else {
          tab.classList.remove('active');
        }
      });

      // 根据设置决定打开方式
      chrome.storage.sync.get('openSearchInNewTab', (rawResult: unknown) => {
        const openInNewTab = getBooleanProperty(rawResult, 'openSearchInNewTab') !== false; // 默认为 true
        console.log('[Search] Opening URL:', url, 'in new tab:', openInNewTab);

        if (openInNewTab) {
          window.open(url, '_blank');
        } else {
          window.location.href = url;
        }

        hideSuggestions();
      });
    });

    setTimeout(() => {
      isSearching = false;
      processSearchQueue();
    }, 1000);
  }

  // 新增恢复默认搜索引擎的函数
  function restoreDefaultSearchEngine() {
    const defaultEngine = localStorage.getItem('selectedSearchEngine') || 'google';

    // 更新标签状态
    const tabs = document.querySelectorAll<HTMLElement>('.tab');
    tabs.forEach(tab => {
      if (tab.getAttribute('data-engine') === defaultEngine) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // 更新搜索引擎图标
    updateSearchEngineIcon(defaultEngine);
  }


  // 修改 getSearchUrl 函数,使用 SearchEngineManager 中的配置


  // 动态调整 textarea 度的函数
  function adjustTextareaHeight() {
    const searchInput = document.querySelector<HTMLElement>('.search-input');
    if (!searchInput) return;

    searchInput.style.height = 'auto'; // 重置高度
    const lineHeight = parseInt(getComputedStyle(searchInput).lineHeight) || 21;
    const maxHeight = 3 * lineHeight; // 最多显示 3 行
    const newHeight = Math.min(searchInput.scrollHeight, maxHeight);
    searchInput.style.height = `${newHeight}px`;
  }

  // 在输入事件中调用调整高度的函数
  searchInput.addEventListener('input', adjustTextareaHeight);

  // 初始化时调整高度
  adjustTextareaHeight();


  const searchSuggestions = requireElement(document.getElementById('search-suggestions'), HTMLElement, '#search-suggestions');

  // 防抖函


  // 在文件顶部定义 RELEVANCE_CONFIG
  const RELEVANCE_CONFIG = {
    titleExactMatchWeight: 6,
    urlExactMatchWeight: 1.5,
    titlePartialMatchWeight: 1.2,
    urlPartialMatchWeight: 0.3,
    timeDecayHalfLife: 60,
    fuzzyMatchThreshold: 0.6,
    fuzzyMatchWeight: 1.5,
    bookmarkRelevanceBoost: 1.2
  };

  // 获取搜索建议




  // 计算模糊匹配分数

  // 辅助函数：查找部分词匹配数量


  // Levenshtein 距离计算





  function updateSubmitButtonState() {
    if (searchInput.value.trim() === '') {
      tabsContainer.style.display = 'none';
    } else {
      // 只有当搜索建议列表不为空时才显示 tabs-container
      if (searchSuggestions.children.length > 0) {
        tabsContainer.style.display = 'flex';
      } else {
        tabsContainer.style.display = 'none';
      }
    }
  }






  function queueSearch() {
    const query = searchInput.value.trim();
    if (query === '') {
      return;
    }
    searchQueue.push(query);
    processSearchQueue();
  }

  function processSearchQueue() {
    if (isSearching || searchQueue.length === 0) {
      return;
    }

    const query = searchQueue.shift();
    if (query !== undefined) debouncedPerformSearch(query);
  }


  // 防抖函

  // 添加这个函数定义

  // 最近历史 60 秒内存缓存：focus 与清空输入场景高频复用；简单 TTL，不做主动失效
  const RECENT_HISTORY_TTL_MS = 60 * 1000;
  let recentHistoryCache: {
    limit: number;
    maxPerDomain: number;
    expiresAt: number;
    data: RecentHistorySuggestion[];
  } | null = null;

  async function getRecentHistory(limit = 100, maxPerDomain = 5): Promise<RecentHistorySuggestion[]> {
    if (
      recentHistoryCache &&
      recentHistoryCache.limit === limit &&
      recentHistoryCache.maxPerDomain === maxPerDomain &&
      Date.now() < recentHistoryCache.expiresAt
    ) {
      return recentHistoryCache.data;
    }
    return new Promise(resolve => {
      chrome.history.search({ text: '', maxResults: limit * 20 }, (historyItems) => {
        const now = Date.now();
        const domainCounts: Record<string, number> = {};
        const uniqueItems = new Map<string, RecentHistorySuggestion>();

        const recentHistory = historyItems
          // 映射并添加额外信息
          .filter((item): item is chrome.history.HistoryItem & { url: string; title: string; lastVisitTime: number } =>
            typeof item.url === 'string' && typeof item.title === 'string' && typeof item.lastVisitTime === 'number')
          .map((item): RecentHistorySuggestion => {
            const url = new URL(item.url);
            const domain = url.hostname;
            return {
              text: item.title,
              url: item.url,
              domain: domain,
              type: 'history',
              relevance: 1,
              timestamp: item.lastVisitTime
            };
          })
          // 按时间排序（最近的优先）
          .sort((a, b) => b.timestamp - a.timestamp)
          // 去重（基于URL和标题）并限制每个域名的数量
          .filter(item => {
            const key = `${item.url}|${item.text}`;
            if (uniqueItems.has(key)) return false;

            const domainCount = (domainCounts[item.domain] ?? 0) + 1;
            domainCounts[item.domain] = domainCount;
            if (domainCount > maxPerDomain) return false;

            uniqueItems.set(key, item);
            return true;
          })
          // 应用时间衰减因子
          .map(item => {
            const daysSinceLastVisit = (now - item.timestamp) / (1000 * 60 * 60 * 24);
            item.relevance *= Math.exp(-daysSinceLastVisit / RELEVANCE_CONFIG.timeDecayHalfLife);
            return item;
          })
          // 再次排序，这次基于相关性（考虑了时间衰减）
          .sort((a, b) => b.relevance - a.relevance)
          // 限制结果数量
          .slice(0, limit);

        recentHistoryCache = { limit, maxPerDomain, expiresAt: Date.now() + RECENT_HISTORY_TTL_MS, data: recentHistory };
        resolve(recentHistory);
      });
    });
  }

  function searchHistory(query: string, maxResults = 200): Promise<chrome.history.HistoryItem[]> {
    return new Promise(resolve => {
      const startTime = new Date().getTime() - (30 * 24 * 60 * 60 * 1000); // 搜索最近30天的历史
      chrome.history.search(
        {
          text: query,
          startTime: startTime,
          maxResults: maxResults
        },
        (results) => {

          // 对历史记录进行去重（Map 预建索引，O(n) 完成，避免 O(n²) 重复查找）
          const uniqueByUrl = new Map<string | undefined, chrome.history.HistoryItem>();
          for (const item of results) {
            if (!uniqueByUrl.has(item.url)) {
              uniqueByUrl.set(item.url, item);
            }
          }
          resolve(Array.from(uniqueByUrl.values()));
        }
      );
    });
  }
  // 获取搜索建议
  async function getSuggestions(query: string) {
    const maxHistoryResults = 200;
    const maxBookmarkResults = 50;
    const maxTotalSuggestions = 50;

    let suggestions: SearchSuggestion[] = [{ text: query, type: 'search', relevance: Infinity }];

    // 获取设置（模块级缓存 + storage 变更失效，避免每次输入都读 chrome.storage）
    const settings = await getSuggestionSettings();

    // 根据设置获取历史记录建议
    let historySuggestions: SearchSuggestion[] = [];
    if (settings['showHistorySuggestions'] !== false) {
      const historyItems = await searchHistory(query, maxHistoryResults);
      historySuggestions = historyItems
        .filter((item): item is chrome.history.HistoryItem & { title: string; url: string; lastVisitTime: number } =>
          typeof item.title === 'string' && typeof item.url === 'string' && typeof item.lastVisitTime === 'number')
        .map(item => ({
        text: item.title,
        url: item.url,
        type: 'history',
        relevance: calculateRelevance(query, item.title, item.url),
        timestamp: item.lastVisitTime
      }));
    }

    // 根据设置获取书签建议
    let bookmarkSuggestions: SearchSuggestion[] = [];
    if (settings['showBookmarkSuggestions'] !== false) {
      const bookmarkItems = await new Promise<BookmarkNode[]>(resolve => {
        chrome.bookmarks.search(query, resolve);
      });
      bookmarkSuggestions = bookmarkItems.filter((item): item is BookmarkNode & { url: string } => typeof item.url === 'string').slice(0, maxBookmarkResults).map(item => ({
        text: item.title,
        url: item.url,
        type: 'bookmark',
        relevance: calculateRelevance(query, item.title, item.url) * RELEVANCE_CONFIG.bookmarkRelevanceBoost
      }));
    }

    // 合并所有建议
    suggestions.push(
      ...historySuggestions,
      ...bookmarkSuggestions
    );

    // 对结果进行排序和去重（Map 预建索引保留首个匹配，O(n) 完成，避免 O(n²) 重复查找）
    const suggestionByUrl = new Map<string | undefined, SearchSuggestion>();
    for (const suggestion of suggestions) {
      if (!suggestionByUrl.has(suggestion.url)) {
        suggestionByUrl.set(suggestion.url, suggestion);
      }
    }
    const uniqueSuggestions = Array.from(suggestionByUrl.values())
      .sort((a, b) => b.relevance - a.relevance);

    // 平衡和交替显示结果
    const balancedResults = await balanceResults(uniqueSuggestions, maxTotalSuggestions);

    return balancedResults;
  }

  function calculateRelevance(query: string, title: string, url: string) {
    // 基础设置
    const weights = {
      exactTitleMatch: 100,    // 标题完全匹配权重
      exactUrlMatch: 80,       // URL完全匹配权重
      titleStartsWith: 70,     // 标题开头匹配权重
      urlStartsWith: 60,       // URL开头匹配权重
      titleIncludes: 50,       // 标题包含匹配权重
      urlIncludes: 40,         // URL包含匹配权重
      wordMatch: 30,           // 分词匹配权重
      fuzzyMatch: 20           // 模糊匹配权重
    };

    // 数据预处理
    const lowerQuery = query.toLowerCase().trim();
    const lowerTitle = (title || '').toLowerCase().trim();
    const lowerUrl = (url || '').toLowerCase().trim();
    const queryWords = lowerQuery.split(/\s+/);  // 将查询分词

    let score = 0;

    // 1. 完全匹配检查
    if (lowerTitle === lowerQuery) {
      score += weights.exactTitleMatch;
    }
    if (lowerUrl === lowerQuery) {
      score += weights.exactUrlMatch;
    }

    // 2. 开头匹配检查
    if (lowerTitle.startsWith(lowerQuery)) {
      score += weights.titleStartsWith;
    }
    if (lowerUrl.startsWith(lowerQuery)) {
      score += weights.urlStartsWith;
    }

    // 3. 包含匹配检查
    if (lowerTitle.includes(lowerQuery)) {
      score += weights.titleIncludes;
    }
    if (lowerUrl.includes(lowerQuery)) {
      score += weights.urlIncludes;
    }

    // 4. 分词匹配
    queryWords.forEach((word: string) => {
      if (word.length > 1) {  // 忽略单字符词
        if (lowerTitle.includes(word)) {
          score += weights.wordMatch;
        }
        if (lowerUrl.includes(word)) {
          score += weights.wordMatch / 2;  // URL分词匹配权重较低
        }
      }
    });

    // 5. 模糊匹配（编辑距离）
    if (title) {
      const fuzzyScore = calculateFuzzyMatch(lowerQuery, lowerTitle);
      if (fuzzyScore > 0.8) {  // 相似度阈值
        score += weights.fuzzyMatch * fuzzyScore;
      }
    }

    // 6. 长度惩罚因子（避免过长的结果）
    const lengthPenalty = Math.max(1, Math.log(lowerTitle.length / lowerQuery.length));
    score = score / lengthPenalty;

    return Math.round(score * 100) / 100;  // 保留两位小数
  }

  // 计算模糊匹配分数
  function calculateFuzzyMatch(query: string, text: string) {
    if (query.length === 0 || text.length === 0) return 0;
    if (query === text) return 1;

    const maxLength = Math.max(query.length, text.length);
    // 快速拒绝：编辑距离下限是长度差，若长度差已使最高可能相似度不超过 0.8 阈值
    // （调用处要求 fuzzyScore > 0.8 才计入得分），直接返回 0，跳过 Levenshtein DP
    if (maxLength - Math.abs(query.length - text.length) <= 0.8 * maxLength) return 0;
    const distance = levenshteinDistance(query, text);
    return (maxLength - distance) / maxLength;
  }

  // Levenshtein 距离计算


  // Levenshtein 距离函数（如果之前没有定义的话）
  function levenshteinDistance(a: string, b: string) {
    let previous = Array.from({ length: a.length + 1 }, (_, index) => index);
    for (let row = 1; row <= b.length; row++) {
      const current = [row];
      for (let column = 1; column <= a.length; column++) {
        current[column] = a.charAt(column - 1) === b.charAt(row - 1)
          ? previous[column - 1] ?? 0
          : Math.min(previous[column - 1] ?? 0, current[column - 1] ?? 0, previous[column] ?? 0) + 1;
      }
      previous = current;
    }
    return previous[a.length] ?? 0;
  }

  async function balanceResults(suggestions: SearchSuggestion[], maxResults: number) {
    const currentSuggestion = suggestions.filter(s => s.type === 'search');
    let bookmarks = suggestions.filter(s => s.type === 'bookmark');
    let histories = suggestions.filter(s => s.type === 'history');
    let bingSuggestions = suggestions.filter(s => s.type === 'bing_suggestion');

    // 应用时间衰减因子到历史记录
    const now = Date.now();
    histories = histories.map(h => {
      const daysSinceLastVisit = (now - (h.timestamp ?? now)) / (1000 * 60 * 60 * 24);
      if (daysSinceLastVisit < 7) { // 如果是最近7天内的记录
        h.relevance *= 1.5; // 为最近的记录提供额外的提升
      }
      h.relevance *= Math.exp(-daysSinceLastVisit / RELEVANCE_CONFIG.timeDecayHalfLife);
      return h;
    });

    // 为书签提供轻微的相关性提
    bookmarks = bookmarks.map(b => {
      b.relevance *= RELEVANCE_CONFIG.bookmarkRelevanceBoost;
      return b;
    });

    // 重新排序
    bookmarks.sort((a, b) => b.relevance - a.relevance);
    histories.sort((a, b) => b.relevance - a.relevance);
    bingSuggestions.sort((a, b) => b.relevance - a.relevance);

    const results = [...currentSuggestion];
    const maxEachType = Math.floor((maxResults - 1) / 4); // 现在我们有4种类型
    const appendFirst = (items: SearchSuggestion[]) => {
      const suggestion = items.shift();
      if (suggestion) results.push(suggestion);
    };

    // 交替添加不同类型的建议
    for (let i = 0; i < maxEachType * 4; i++) {
      if (i % 4 === 0 && bookmarks.length > 0) {
        appendFirst(bookmarks);
      } else if (i % 4 === 1 && histories.length > 0) {
        appendFirst(histories);
      } else if (i % 4 === 2 && bingSuggestions.length > 0) {
        appendFirst(bingSuggestions);
      } else if (histories.length > 0) {
        appendFirst(histories);
      }
    }

    // 如果还有空间，添加剩余的最相关项
    while (results.length < maxResults && (bookmarks.length > 0 || histories.length > 0 || bingSuggestions.length > 0)) {
      if (bookmarks.length === 0) {
        if (histories.length === 0) {
          appendFirst(bingSuggestions);
        } else if (bingSuggestions.length === 0) {
          appendFirst(histories);
        } else {
          appendFirst((histories[0]?.relevance ?? 0) > (bingSuggestions[0]?.relevance ?? 0) ? histories : bingSuggestions);
        }
      } else if (histories.length === 0) {
        if (bookmarks.length === 0) {
          appendFirst(bingSuggestions);
        } else if (bingSuggestions.length === 0) {
          appendFirst(bookmarks);
        } else {
          appendFirst((bookmarks[0]?.relevance ?? 0) > (bingSuggestions[0]?.relevance ?? 0) ? bookmarks : bingSuggestions);
        }
      } else if (bingSuggestions.length === 0) {
        appendFirst((bookmarks[0]?.relevance ?? 0) > (histories[0]?.relevance ?? 0) ? bookmarks : histories);
      } else {
        const maxRelevance = Math.max(bookmarks[0]?.relevance ?? 0, histories[0]?.relevance ?? 0, bingSuggestions[0]?.relevance ?? 0);
        if (maxRelevance === bookmarks[0]?.relevance) {
          appendFirst(bookmarks);
        } else if (maxRelevance === histories[0]?.relevance) {
          appendFirst(histories);
        } else {
          appendFirst(bingSuggestions);
        }
      }
    }

    // 计算用户相关性
    const suggestionsWithUserRelevance = await calculateUserRelevance(results);

    // 重新排序，使用 userRelevance 而不是 relevance
    suggestionsWithUserRelevance.sort((a, b) => (b.userRelevance ?? b.relevance) - (a.userRelevance ?? a.relevance));

    return suggestionsWithUserRelevance;
  }

  const USER_BEHAVIOR_KEY = 'userSearchBehavior';

  // 在文件顶部定义 MAX_BEHAVIOR_ENTRIES
  const MAX_BEHAVIOR_ENTRIES = 1000; // 你可以根据需要调整该值

  // 行为表内存缓存：建议相关性每次输入都要读，缓存 + onChanged 失效后
  // 热路径不再走 storage IPC；写路径更新缓存并防抖落盘
  let userBehaviorCache: SearchBehaviorMap | null = null;
  let userBehaviorSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingBehaviorSave: SearchBehaviorMap | null = null;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[USER_BEHAVIOR_KEY] !== undefined) {
      userBehaviorCache = null;
    }
  });

  function flushUserBehaviorSave(): void {
    if (userBehaviorSaveTimer !== undefined) {
      clearTimeout(userBehaviorSaveTimer);
      userBehaviorSaveTimer = undefined;
    }
    const toWrite = pendingBehaviorSave;
    pendingBehaviorSave = null;
    if (toWrite !== null) {
      chrome.storage.local.set({ [USER_BEHAVIOR_KEY]: toWrite });
    }
  }

  function scheduleUserBehaviorSave(behavior: SearchBehaviorMap): void {
    if (userBehaviorSaveTimer !== undefined) clearTimeout(userBehaviorSaveTimer);
    pendingBehaviorSave = behavior;
    userBehaviorSaveTimer = setTimeout(flushUserBehaviorSave, 1000);
  }

  // 页面关闭/丢弃前同步落盘，避免防抖窗口内的末次增量丢失
  window.addEventListener('pagehide', flushUserBehaviorSave);

  // 获取用户行为数据
  async function getUserBehavior(): Promise<SearchBehaviorMap> {
    if (userBehaviorCache !== null) {
      return userBehaviorCache;
    }
    return new Promise(resolve => {
      chrome.storage.local.get(USER_BEHAVIOR_KEY, (rawResult: unknown) => {
        const rawBehavior = isUnknownRecord(rawResult) ? rawResult[USER_BEHAVIOR_KEY] : undefined;
        const behavior: SearchBehaviorMap = {};
        if (typeof rawBehavior === 'object' && rawBehavior !== null) {
          for (const [key, value] of Object.entries(rawBehavior)) {
            if (typeof value === 'object' && value !== null && 'count' in value && 'lastUsed' in value &&
                typeof value.count === 'number' && typeof value.lastUsed === 'number') {
              behavior[key] = { count: value.count, lastUsed: value.lastUsed };
            }
          }
        }
        resolve(behavior); // 直接返回行为数据，不进行清理
        userBehaviorCache = behavior;
      });
    });
  }

  // 保存用户行为数据：写穿缓存，防抖落盘避免逐次点击整表 IPC 往返
  async function saveUserBehavior(key: string, increment = 1) {
    const behavior = await getUserBehavior();
    const now = Date.now();

    if (!behavior[key]) {
      behavior[key] = { count: 0, lastUsed: now };
    }

    behavior[key].count += increment; // 增加计数
    behavior[key].lastUsed = now; // 更新最后用时间

    // 检查条目数并清理
    if (Object.keys(behavior).length > MAX_BEHAVIOR_ENTRIES) {
      const sortedEntries = Object.entries(behavior)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed); // 按最后使用时间排序
      sortedEntries.slice(0, sortedEntries.length - MAX_BEHAVIOR_ENTRIES).forEach(([key]) => {
        delete behavior[key]; // 删除最旧的条目
      });
    }

    userBehaviorCache = behavior;
    scheduleUserBehaviorSave(behavior);
    return Promise.resolve();
  }

  // 计算用户相关性
  async function calculateUserRelevance(suggestions: SearchSuggestion[]) {
    const behavior = await getUserBehavior();
    const now = Date.now();

    return suggestions.map(suggestion => {
      const key = suggestion.url || suggestion.text;
      const behaviorData = behavior[key];

      if (!behaviorData) return { ...suggestion, userRelevance: suggestion.relevance };

      const daysSinceLastUse = (now - behaviorData.lastUsed) / (1000 * 60 * 60 * 24);
      const recencyFactor = Math.exp(-daysSinceLastUse / 30); // 30天的半衰期
      const behaviorScore = behaviorData.count * recencyFactor;

      return {
        ...suggestion,
        userRelevance: suggestion.relevance * (1 + behaviorScore * 0.1) // 增加最多10%的权重
      };
    });
  }

  let allSuggestions: SearchSuggestion[] = [];
  let displayedSuggestions = 0;
  const suggestionsPerLoad = 10; // 每次加载10个建议
    void suggestionsPerLoad;

  let isScrollListenerAttached = false;

  function showSuggestions(suggestions: SearchSuggestion[]) {
    if (suggestions.length === 0) {
      hideSuggestions();
      return;
    }

    allSuggestions = suggestions;
    displayedSuggestions = 0;
    searchSuggestions.innerHTML = '';

    const searchForm = requireElement(document.querySelector('.search-form'), HTMLElement, '.search-form');
    searchForm.classList.add('focused-with-suggestions');

    const suggestionsWrapper = document.querySelector<HTMLElement>('.search-suggestions-wrapper');
    if (suggestionsWrapper) {
      suggestionsWrapper.style.display = 'block';
    }
    searchSuggestions.style.display = 'block';

    // 显示 line-container
    const lineContainer = requireElement(document.getElementById('line-container'), HTMLElement, '#line-container');
    lineContainer.style.display = 'block'; // 显示线条

    // Set a fixed height for the suggestions container
    searchSuggestions.style.maxHeight = '390px'; // Adjust this value as needed
    searchSuggestions.style.overflowY = 'auto';

    loadMoreSuggestions();

    if (!isScrollListenerAttached) {
      searchSuggestions.addEventListener('scroll', throttledHandleScroll);
      isScrollListenerAttached = true;
    }
    setTimeout(() => {
    }, 0);
  }

  function loadMoreSuggestions() {
    if (!Array.isArray(allSuggestions) || allSuggestions.length === 0) {
      return;
    }

    const remainingSuggestions = allSuggestions.length - displayedSuggestions;
    const suggestionsToAdd = Math.min(remainingSuggestions, 10);

    if (suggestionsToAdd <= 0) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = displayedSuggestions; i < displayedSuggestions + suggestionsToAdd; i++) {
      const suggestion = allSuggestions[i];
      if (suggestion === undefined) continue;
      const li = createSuggestionElement(suggestion);
      fragment.appendChild(li);
    }

    searchSuggestions.appendChild(fragment);
    displayedSuggestions += suggestionsToAdd;

  }

  function throttle<TArgs extends unknown[]>(func: (...args: TArgs) => void, limit: number) {
    let inThrottle = false;
    return function(this: unknown, ...args: TArgs) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    }
  }

  const throttledHandleScroll = throttle(function() {
    const scrollPosition = searchSuggestions.scrollTop + searchSuggestions.clientHeight;
    const scrollHeight = searchSuggestions.scrollHeight;
    if (scrollPosition >= scrollHeight - 20 && displayedSuggestions < allSuggestions.length) {
      loadMoreSuggestions();
    }
  }, 200);  // 限制为每200毫秒最多执行一次


  // 修改创建建议元素的函数
  function createSuggestionElement(suggestion: SearchSuggestion) {
    const li = document.createElement('li');
    const displayUrl = suggestion.url ? formatUrl(suggestion.url) : '';
    li.setAttribute('data-type', suggestion.type);
    if (suggestion.url) {
      li.setAttribute('data-url', suggestion.url);
    }
    const searchSvgIcon = `<svg class="suggestion-icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <path d="M466.624 890.432a423.296 423.296 0 0 1-423.936-423.04C42.688 233.728 231.936 42.624 466.56 42.624a423.68 423.68 0 0 1 423.936 424.64 437.952 437.952 0 0 1-56.32 213.12 47.872 47.872 0 0 1-64.128 17.28 48 48 0 0 1-17.216-64.256c29.76-50.176 43.84-106.56 43.84-166.144-1.6-183.36-148.608-330.624-330.112-330.624a330.432 330.432 0 0 0-330.112 330.624 329.408 329.408 0 0 0 330.112 330.688c57.92 0 115.776-15.68 165.824-43.904a47.872 47.872 0 0 1 64.128 17.28 48 48 0 0 1-17.152 64.192 443.584 443.584 0 0 1-212.8 54.848z" fill="#334155"></path>
  <path d="M466.624 890.432a423.296 423.296 0 0 1-423.936-423.04c0-75.264 20.288-148.928 56.32-213.12a47.872 47.872 0 0 1 64.128-17.28 48 48 0 0 1 17.216 64.256 342.08 342.08 0 0 0-43.84 166.08c0 181.76 147.072 330.688 330.112 330.688a329.408 329.408 0 0 0 330.112-330.688A330.432 330.432 0 0 0 466.56 136.704c-57.856 0-115.776 15.68-165.824 43.84a47.872 47.872 0 0 1-64.128-17.216 48 48 0 0 1 17.216-64.256A436.032 436.032 0 0 1 466.56 42.688c233.088 0 422.4 189.568 422.4 424.64a422.016 422.016 0 0 1-422.4 423.104z" fill="#334155"></path>
  <path d="M934.4 981.312a44.992 44.992 0 0 1-32.832-14.08l-198.72-199.04c-18.752-18.816-18.752-48.576 0-65.792 18.752-18.816 48.512-18.816 65.728 0l198.656 199.04c18.816 18.752 18.816 48.576 0 65.792a47.68 47.68 0 0 1-32.832 14.08z" fill="#334155"></path>
</svg>`;
    // 限制建议文本的长度
    const maxTextLength = 20; // 你可以根据需要调整这个值
    const truncatedText = suggestion.text.length > maxTextLength
      ? suggestion.text.substring(0, maxTextLength) + '...'
      : suggestion.text;

    li.innerHTML = `
    ${suggestion.type === 'search' ? searchSvgIcon : '<span class="material-icons suggestion-icon"></span>'}
    <div class="suggestion-content">
      <span class="suggestion-text" title="${suggestion.text}">${truncatedText}</span>
      ${displayUrl ? `<span class="suggestion-dash">-</span><span class="suggestion-url">${displayUrl}</span>` : ''}
    </div>
    <span class="suggestion-type">${suggestion.type}</span>
  `;

    if (suggestion.url && suggestion.type !== 'search') {
      getFavicon(suggestion.url, (faviconUrl: string) => {
        const iconSpan = li.querySelector<HTMLElement>('.suggestion-icon');
        if (iconSpan) iconSpan.innerHTML = `<img src="${faviconUrl}" alt="" class="favicon">`;
      });
    }

    li.addEventListener('click', async () => {
      if (suggestion.url) {
        const suggestionUrl = suggestion.url;
        // 根据设置决定打开方式
        chrome.storage.sync.get('openSearchInNewTab', (rawResult: unknown) => {
          const openInNewTab = getBooleanProperty(rawResult, 'openSearchInNewTab') !== false; // 默认为 true

          if (openInNewTab) {
            window.open(suggestionUrl, '_blank');
          } else {
            window.location.href = suggestionUrl;
          }
        });

        await saveUserBehavior(suggestionUrl);
      } else {
        searchInput.value = suggestion.text;
        searchInput.focus();
        queueSearch();
        await saveUserBehavior(suggestion.text);
      }
      hideSuggestions();
    });

    return li;
  }

  function formatUrl(url: string) {
    try {
      const urlObj = new URL(url);
      let domain = urlObj.hostname;

      // 移除 'www.' 前缀（如果存在）
      domain = domain.replace(/^www\./, '');

      // 如果路径不只是 '/'
      let path = urlObj.pathname;
      if (path && path !== '/') {
        // 截断长路径
        path = path.length > 10 ? path.substring(0, 10) + '...' : path;
        domain += path;
      }

      return domain;
    } catch (error) {
      if (error instanceof TypeError) return '';
      throw error;
    }
  }


  // Add this function to fetch favicons
  function getFavicon(url: string, callback: (faviconUrl: string) => void) {
    const faviconHref = createFaviconUrl(url);
    const img = new Image();
    img.onload = function () {
      callback(faviconHref);
    };
    // 加载失败时不回调：保留原有默认图标占位 span，避免渲染 <img src=""> 触发重复请求
    img.src = faviconHref;
  }

  // Add this function to fetch favicon online as a fallback


  // Add this function to cache favicons


  async function showDefaultSuggestions(requestId?: number) {
    // 查询期间若有更新的查询发起，则本次结果已过期，不再改动建议列表
    const isStale = () => requestId !== undefined && requestId !== suggestionQueryId;

    // 首先检查设置（模块级缓存 + storage 变更失效）
    const settings = await getSuggestionSettings();

    let suggestions: SearchSuggestion[] = [];

    // 只有在启用了历史记录建议时才获取历史记录
    if (settings['showHistorySuggestions'] !== false) {
      const recentHistory = await getRecentHistory(20);
      suggestions = suggestions.concat(recentHistory.map((item): SearchSuggestion => ({
        text: item.text,
        url: item.url,
        type: 'history',
        relevance: item.relevance
      })));
    } else {
      // 如果历史记录已关闭且没有搜索词，不显示任何建议
      if (!searchInput.value.trim()) {
        if (!isStale()) hideSuggestions();
        return;
      }
    }

    // 如果启用了书签建议，可以在这里添加最近的书签
    if (settings['showBookmarkSuggestions'] !== false) {
      const recentBookmarks = await new Promise<BookmarkNode[]>(resolve => {
        chrome.bookmarks.getRecent(10, resolve);
      });

      suggestions = suggestions.concat(recentBookmarks.filter((item): item is BookmarkNode & { url: string } => typeof item.url === 'string').map(item => ({
        text: item.title,
        url: item.url,
        type: 'bookmark',
        relevance: 1
      })));
    }

    // 异步查询期间若有新查询发起，丢弃过期结果
    if (isStale()) return;

    // 如果没有任何建议，则不显示建议列表
    if (suggestions.length === 0) {
      hideSuggestions();
      return;
    }

    showSuggestions(suggestions);
  }

  // 修改 handleInput 函数
  const handleInput = debounce(async () => {
    const requestId = ++suggestionQueryId;
    const query = searchInput.value.trim();
    showLoadingIndicator();

    if (query) {
      const suggestions = await getSuggestions(query);
      if (requestId !== suggestionQueryId) return;
      hideLoadingIndicator();
      // 移除 length > 1 的判断，因为我们总是想显示搜索建议
      showSuggestions(suggestions);
    } else {
      hideLoadingIndicator();
      await showDefaultSuggestions(requestId);
    }
    updateSubmitButtonState();
  }, 300);

  // 处理输入事件（值为空的清空场景统一交给防抖后的 handleInput，避免同一次清空触发两次历史查询）
  searchInput.addEventListener('input', () => {
    handleInput();
    updateSubmitButtonState();
  });

  // 处理键盘导航
  searchInput.addEventListener('keydown', (e) => {
    const items = searchSuggestions.querySelectorAll<HTMLElement>('li');
    let index = Array.from(items).findIndex(item => item.classList.contains('keyboard-selected'));

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (index < items.length - 1) index++;
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (index > 0) index--;
        break;
      case 'Enter':
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          // 处理 Cmd/Ctrl + Enter
          const query = searchInput.value.trim();
          if (query) {
            openAllSearchEngines(query);
          }
        } else if (index !== -1) {
          e.stopPropagation(); // 阻止事件冒泡
          const selectedItem = items[index];
          if (selectedItem === undefined) return;
          const suggestionType = selectedItem.getAttribute('data-type');
          if (suggestionType === 'history' || suggestionType === 'bookmark') {
            const url = selectedItem.getAttribute('data-url');
            if (url) {
              window.open(url, '_blank');
              hideSuggestions();
              return;
            }
          }
          selectedItem.click();
        } else {
          performSearch(searchInput.value.trim());
        }
        return;
      default:
        return;
    }

    items.forEach(item => item.classList.remove('keyboard-selected'));
    if (index !== -1) {
      const selectedItem = items[index];
      if (!selectedItem) return;
      selectedItem.classList.add('keyboard-selected');
      // 只在选择搜索建议时更新输入框的值
      const suggestionType = selectedItem.getAttribute('data-type');
      if (suggestionType === 'search') {
        const suggestionText = selectedItem.querySelector<HTMLElement>('.suggestion-text')?.textContent;
        if (searchInput instanceof HTMLInputElement && suggestionText !== null && suggestionText !== undefined) {
          searchInput.value = suggestionText;
        }
      }
    }
  })

  // 添加防抖函数
  function debounce<TArgs extends unknown[]>(func: (...args: TArgs) => void, wait: number) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function executedFunction(...args: TArgs) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }



  function hideSuggestions() {
    if (isChangingSearchEngine) {
      return; // 如果正在切换搜索引擎，不隐藏建议列表
    }
    const searchForm = requireElement(document.querySelector('.search-form'), HTMLElement, '.search-form');
    searchForm.classList.remove('focused-with-suggestions');

    const suggestionsWrapper = document.querySelector<HTMLElement>('.search-suggestions-wrapper');
    if (suggestionsWrapper) {
      suggestionsWrapper.style.display = 'none';
    }
    if (searchSuggestions) {
      searchSuggestions.style.display = 'none';
      searchSuggestions.innerHTML = ''; // Clear the suggestions
    }

    // 隐藏 line-container
    const lineContainer = requireElement(document.getElementById('line-container'), HTMLElement, '#line-container');
    lineContainer.style.display = 'none'; // 隐藏线条

    if (isScrollListenerAttached) {
      searchSuggestions.removeEventListener('scroll', throttledHandleScroll);
      isScrollListenerAttached = false;
    }

    // Reset suggestions-related variables
    allSuggestions = [];
    displayedSuggestions = 0;
  }

  function showLoadingIndicator() {
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'loading-indicator';
    loadingIndicator.innerHTML = `
    <svg class="loading-spinner" viewBox="0 0 50 50">
      <circle class="spinner-path" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
    </svg>
  `;
    searchSuggestions.appendChild(loadingIndicator);
  }

  function hideLoadingIndicator() {
    const loadingIndicator = searchSuggestions.querySelector<HTMLElement>('.loading-indicator');
    if (loadingIndicator) {
      loadingIndicator.remove();
    }
  }


  // 修改这个函数
  function openAllSearchEngines(query: string) {
    const enabledEngines = SearchEngineManager.getEnabledEngines();

    const urls = enabledEngines
      .map(engine => getSearchUrl(engine.name, query));

    if (urls.length > 0) {
      window.lastSearchTrigger = 'cmdCtrlEnter';

      chrome.runtime.sendMessage({
        action: 'openMultipleTabsAndGroup',
        urls: urls,
        groupName: query
      }, function (rawResponse: unknown) {
        const response = getOpenMultipleTabsResponse(rawResponse);
        if (!response?.success) {
          console.error('打开多个标签页或创建标签组失败:', response?.error ?? '未知错误');
        }
      });
    } else {
      console.log('没有启用的搜索引擎');
    }
  }}
