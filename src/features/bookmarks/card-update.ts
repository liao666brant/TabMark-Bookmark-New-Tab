import { evictCachedCardColors, setCachedCardColors } from './card-colors'
import type { BookmarkColors } from './page-parsers'
import { createFaviconUrl } from '../../shared/favicon'

type ColorHandlers = {
  readonly getColors: (image: HTMLImageElement) => BookmarkColors
  readonly applyColors: (card: HTMLElement, colors: BookmarkColors) => void
}

const fallbackColors: BookmarkColors = {
  primary: [200, 200, 200],
  secondary: [220, 220, 220],
}

export function updateBookmarkCard(
  bookmarkId: string,
  newTitle: string,
  newUrl: string,
  handlers: ColorHandlers,
): void {
  const bookmarkCard = document.querySelector<HTMLElement>(`.bookmark-card[data-id="${CSS.escape(bookmarkId)}"]`)
  if (!bookmarkCard) return

  const anchor = bookmarkCard instanceof HTMLAnchorElement ? bookmarkCard : null
  const previousUrl = anchor?.href

  if (anchor) {
    anchor.href = newUrl
    // 委托监听器从 dataset 取 URL，编辑后同步刷新
    anchor.dataset['url'] = newUrl
  }

  const title = bookmarkCard.querySelector<HTMLElement>('.card-title')
  if (title) title.textContent = newTitle

  // URL 未变化时只更新标题，跳过 favicon 重取与取色
  if (previousUrl !== undefined && anchor !== null && previousUrl === anchor.href) return

  const image = bookmarkCard.querySelector<HTMLImageElement>('img')
  if (!image) return

  evictCachedCardColors(bookmarkId)
  image.src = createFaviconUrl(newUrl)
  image.onload = () => {
    const colors = handlers.getColors(image)
    handlers.applyColors(bookmarkCard, colors)
    setCachedCardColors(bookmarkId, colors)
  }
  image.onerror = () => {
    handlers.applyColors(bookmarkCard, fallbackColors)
    setCachedCardColors(bookmarkId, fallbackColors)
  }
}
