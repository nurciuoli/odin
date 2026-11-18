import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN,
  DETAILS_WIDTH,
  PREVIEW_MIN,
  SIDEBAR_WIDTH,
  detailsFit,
  maxPreviewWidth,
  sidebarCrowded,
} from './layout'

describe('detailsFit', () => {
  it('fits when the conversation keeps its minimum beside the details', () => {
    expect(detailsFit(CHAT_MIN + DETAILS_WIDTH, 0)).toBe(true)
    expect(detailsFit(CHAT_MIN + DETAILS_WIDTH - 1, 0)).toBe(false)
  })
  it('counts the docked preview pane', () => {
    expect(detailsFit(1400, 760)).toBe(false)
    expect(detailsFit(1700, 760)).toBe(true)
  })
})

describe('maxPreviewWidth', () => {
  it('leaves the conversation its minimum', () => {
    expect(maxPreviewWidth(1400, 960)).toBe(920)
  })
  it('stops at the ceiling and never drops below the pane minimum', () => {
    expect(maxPreviewWidth(3000, 960)).toBe(960)
    expect(maxPreviewWidth(700, 960)).toBe(PREVIEW_MIN)
  })
})

describe('sidebarCrowded', () => {
  const demand = CHAT_MIN + PREVIEW_MIN
  it('never folds for a screen that asks for nothing', () => {
    expect(sidebarCrowded(400, 0)).toBe(false)
  })
  it('folds when the main area, sidebar open, is narrower than asked', () => {
    expect(sidebarCrowded(SIDEBAR_WIDTH + demand - 1, demand)).toBe(true)
    expect(sidebarCrowded(SIDEBAR_WIDTH + demand, demand)).toBe(false)
  })
})
