import assert from 'node:assert/strict'
import test from 'node:test'
import { buildQuickLinks } from '../src/features/quick-links/shortcuts'
import type { QuickLink } from '../src/features/quick-links/storage'

function historyItem(url: string, title: string) {
  return {
    url,
    title,
  }
}

test('keeps fixed links and adds only distinct allowed history domains', () => {
  const fixed: QuickLink = {
    name: 'Fixed',
    url: 'https://fixed.example/',
    favicon: 'fixed-icon',
    fixed: true,
  }

  const result = buildQuickLinks({
    fixedShortcuts: [fixed],
    blacklist: ['blocked.example'],
    sortedHistory: [
      historyItem('https://fixed.example/other', 'Fixed other'),
      historyItem('https://history.example/', 'History'),
      historyItem('https://history.example/other', 'History other'),
      historyItem('https://blocked.example/', 'Blocked'),
    ],
    maxDisplay: 2,
    getSiteName: (title) => `name:${title}`,
    faviconURL: (url) => `icon:${url}`,
  })

  assert.deepEqual(result, [
    { ...fixed, favicon: 'icon:https://fixed.example/' },
    {
      name: 'name:History',
      url: 'https://history.example/',
      favicon: 'icon:https://history.example/',
      fixed: false,
    },
  ])
})
