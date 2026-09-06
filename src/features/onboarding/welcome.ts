import { getLocalizedMessage } from '../../shared/localization'
import type { WelcomeManagerContract } from '../../shared/types'

type ColorCache = {
  lastBackground: string | null
  lastTextColor: string | null
}

let userName = localStorage.getItem('userName') || 'Sowhale'

// 欢迎语显隐的内存缓存：initialize 读一次，storage 变化时同步，读取路径不再访问 storage
let showWelcomeMessageEnabled = true
// 自定义欢迎语：空字符串表示使用默认分段问候
let customWelcomeMessage = ''
// 最近一次由 manager 写入的欢迎语文本，用于识别外部改写
let lastAppliedMessage: string | null = null

function getStoredString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function getTimeGreeting(hours: number): string {
  if (hours < 12) {
    return getLocalizedMessage('morningGreeting')
  }
  if (hours < 18) {
    return getLocalizedMessage('afternoonGreeting')
  }
  return getLocalizedMessage('eveningGreeting')
}

function getRgbChannels(color: string): readonly [number, number, number] | null {
  const matches = color.match(/\d+/g)
  const red = matches?.at(0)
  const green = matches?.at(1)
  const blue = matches?.at(2)
  if (red === undefined || green === undefined || blue === undefined) {
    return null
  }

  return [Number.parseInt(red, 10), Number.parseInt(green, 10), Number.parseInt(blue, 10)]
}

export const WelcomeManager = {
  colorCache: {
    lastBackground: null,
    lastTextColor: null,
  } satisfies ColorCache,

  initialize(): void {
    chrome.storage.sync.get(['showWelcomeMessage', 'customWelcomeMessage'], (result) => {
      showWelcomeMessageEnabled = result['showWelcomeMessage'] !== false
      customWelcomeMessage = getStoredString(result['customWelcomeMessage']).trim()
      const welcomeElement = document.getElementById('welcome-message')
      if (welcomeElement) {
        welcomeElement.style.display = showWelcomeMessageEnabled ? '' : 'none'
        if (showWelcomeMessageEnabled) {
          this.updateWelcomeMessage(false)
        }
      }

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync') {
          return
        }
        const showChange = changes['showWelcomeMessage']
        if (showChange !== undefined) {
          showWelcomeMessageEnabled = showChange.newValue !== false
        }
        const customChange = changes['customWelcomeMessage']
        if (customChange !== undefined) {
          customWelcomeMessage = getStoredString(customChange.newValue).trim()
          this.updateWelcomeMessage(false)
        }
      })

      this.initializeColorCache()
      this.setupEventListeners()
      this.setupThemeChangeListener()
    })
  },

  updateWelcomeMessage(checkVisibility = true): void {
    const hours = new Date().getHours()
    const message = customWelcomeMessage !== ''
      // 自定义欢迎语：{name} 占位符替换为用户名
      ? customWelcomeMessage.replaceAll('{name}', userName)
      : `${getTimeGreeting(hours)}, ${userName}`

    const welcomeElement = document.getElementById('welcome-message')
    if (!welcomeElement) {
      return
    }

    welcomeElement.textContent = message
    lastAppliedMessage = message
    if (checkVisibility) {
      welcomeElement.style.display = showWelcomeMessageEnabled ? '' : 'none'
    }
    this.adjustTextColor(welcomeElement)
  },

  initializeColorCache(): void {
    const backgroundColor = window.getComputedStyle(document.documentElement).backgroundColor
    const backgroundImage = document.body.style.backgroundImage
    if (backgroundColor && backgroundColor !== 'rgba(0, 0, 0, 0)' && backgroundColor !== 'transparent') {
      const channels = getRgbChannels(backgroundColor)
      if (channels) {
        const [red, green, blue] = channels
        const brightness = red * 0.299 + green * 0.587 + blue * 0.114
        this.colorCache.lastTextColor =
          brightness > 128 ? 'rgba(51, 51, 51, 0.9)' : 'rgba(255, 255, 255, 0.9)'
      }
    }

    this.colorCache.lastBackground = backgroundImage !== 'none' ? backgroundImage : backgroundColor
    const welcomeElement = document.getElementById('welcome-message')
    if (welcomeElement) {
      welcomeElement.style.color = this.colorCache.lastTextColor || 'rgba(51, 51, 51, 0.9)'
    }
  },

  adjustTextColor(element: HTMLElement): void {
    const backgroundColor = window.getComputedStyle(document.documentElement).backgroundColor
    const backgroundImage = document.body.style.backgroundImage
    const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark'

    if (!backgroundImage || backgroundImage === 'none') {
      if (isDarkMode) {
        element.style.color = 'rgba(255, 255, 255, 0.9)'
        this.colorCache.lastTextColor = 'rgba(255, 255, 255, 0.9)'
        return
      }

      let textColor = 'rgba(51, 51, 51, 0.9)'
      if (backgroundColor && backgroundColor !== 'rgba(0, 0, 0, 0)' && backgroundColor !== 'transparent') {
        const channels = getRgbChannels(backgroundColor)
        if (channels) {
          const [red, green, blue] = channels
          const brightness = red * 0.299 + green * 0.587 + blue * 0.114
          textColor =
            brightness > 128 ? 'rgba(51, 51, 51, 0.9)' : 'rgba(255, 255, 255, 0.9)'
        }
      }

      this.colorCache.lastTextColor = textColor
      element.style.color = textColor
      return
    }

    // 命中缓存：直接复用上次采样结果，跳过整图解码与 canvas 采样
    if (this.colorCache.lastBackground === backgroundImage && this.colorCache.lastTextColor) {
      element.style.color = this.colorCache.lastTextColor
      return
    }

    // 非 url 背景（纯色/渐变）无法采样：沿用与图片加载失败一致的降级色逻辑
    if (!backgroundImage.startsWith('url')) {
      if (!this.colorCache.lastTextColor) {
        element.style.color = 'rgba(255, 255, 255, 0.9)'
      }
      return
    }

    // 采样完成前先给白色兜底，采样结束后会被覆盖
    element.style.color = 'rgba(255, 255, 255, 0.9)'

    const image = new Image()
    image.crossOrigin = 'Anonymous'
    image.src = backgroundImage.slice(5, -2)
    image.onload = () => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) {
        return
      }

      const sampleSize = 50
      const elementRect = element.getBoundingClientRect()
      const sampleArea = {
        x: Math.max(0, elementRect.x), y: Math.max(0, elementRect.y),
        width: Math.min(elementRect.width, window.innerWidth), height: Math.min(elementRect.height, window.innerHeight),
      }
      canvas.width = sampleSize
      canvas.height = sampleSize

      const scale = {
        x: image.width / window.innerWidth,
        y: image.height / window.innerHeight,
      }
      const sourceArea = {
        x: sampleArea.x * scale.x,
        y: sampleArea.y * scale.y,
        width: sampleArea.width * scale.x,
        height: sampleArea.height * scale.y,
      }
      context.drawImage(
        image,
        sourceArea.x,
        sourceArea.y,
        sourceArea.width,
        sourceArea.height,
        0,
        0,
        sampleSize,
        sampleSize,
      )

      try {
        const data = context.getImageData(0, 0, sampleSize, sampleSize).data
        let red = 0
        let green = 0
        let blue = 0
        let count = 0
        for (let index = 0; index < data.length; index += 4) {
          const sampleRed = data.at(index)
          const sampleGreen = data.at(index + 1)
          const sampleBlue = data.at(index + 2)
          if (sampleRed === undefined || sampleGreen === undefined || sampleBlue === undefined) {
            continue
          }
          red += sampleRed
          green += sampleGreen
          blue += sampleBlue
          count += 1
        }
        if (count === 0) {
          return
        }

        red = Math.floor(red / count)
        green = Math.floor(green / count)
        blue = Math.floor(blue / count)
        const brightness = red * 0.299 + green * 0.587 + blue * 0.114

        const textColor =
          brightness > 128 ? 'rgba(51, 51, 51, 0.9)' : 'rgba(255, 255, 255, 0.9)'
        this.colorCache.lastBackground = backgroundImage
        this.colorCache.lastTextColor = textColor
        element.style.color = textColor
        element.style.transition = 'color 0.3s ease'
      } catch (error) {
        if (!(error instanceof DOMException)) {
          throw error
        }
        console.error('分析背景颜色失败:', error, { sampleArea, sourceArea })
        element.style.color = 'rgba(255, 255, 255, 0.9)'
      }
    }

    image.onerror = () => {
      console.error('背景图片加载失败')
      if (!this.colorCache.lastTextColor) {
        element.style.color = 'rgba(255, 255, 255, 0.9)'
      }
    }
    element.style.color = 'rgba(255, 255, 255, 0.9)'
  },

  setupEventListeners(): void {
    const welcomeElement = document.getElementById('welcome-message')
    welcomeElement?.addEventListener('click', () => {
      const newUserName = prompt(chrome.i18n.getMessage('namePrompt'), userName)
      if (newUserName && newUserName.trim() !== '') {
        userName = newUserName.trim()
        localStorage.setItem('userName', userName)
        this.updateWelcomeMessage()
      }
    })

    if (welcomeElement) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type !== 'childList' && mutation.type !== 'characterData') {
            return
          }
          const currentText = welcomeElement.textContent
          // 文本与最近一次由 manager 应用的一致时忽略；不一致说明被外部改写，重写回正确欢迎语
          if (currentText && currentText !== lastAppliedMessage) {
            this.updateWelcomeMessage()
          }
        })
      })
      observer.observe(welcomeElement, { childList: true, characterData: true, subtree: true })
    }
  },

  setupThemeChangeListener(): void {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName !== 'data-theme') {
          return
        }
        const welcomeElement = document.getElementById('welcome-message')
        if (welcomeElement) {
          this.adjustTextColor(welcomeElement)
        }
      })
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  },
} satisfies WelcomeManagerContract & { colorCache: ColorCache }

window.WelcomeManager = WelcomeManager

document.addEventListener('DOMContentLoaded', () => {
  WelcomeManager.initialize()

  // 欢迎语仅依赖时间段：对齐下一个分钟边界单次触发并重排，页面隐藏时暂停刷新
  let minuteTimeoutId: number | undefined
  const refreshWelcomeMessage = (): void => {
    if (!document.hidden) {
      WelcomeManager.updateWelcomeMessage()
    }
  }
  const scheduleMinuteRefresh = (): void => {
    if (minuteTimeoutId !== undefined) {
      clearTimeout(minuteTimeoutId)
    }
    minuteTimeoutId = window.setTimeout(() => {
      refreshWelcomeMessage()
      scheduleMinuteRefresh()
    }, 60_000 - (Date.now() % 60_000))
  }

  // 页面重新可见时立即刷新并重新对齐分钟边界，避免长时间隐藏后欢迎语停留在旧时间段
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      return
    }
    refreshWelcomeMessage()
    scheduleMinuteRefresh()
  })
  scheduleMinuteRefresh()
})
