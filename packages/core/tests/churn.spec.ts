import { describe, expect, it } from 'vitest'
import * as core from '../src/index.ts'
import type { MemoryGitCommit } from '../src/memory-git.ts'
import {
  churnByPath,
  churnStressors,
  churnThresholdFraction,
  DEFAULT_CHURN_THRESHOLD_PERCENT,
  DEFAULT_CHURN_WINDOW_COMMITS,
} from '../src/churn.ts'

/** Commit builds a MemoryGitCommit stand-in for the churn inputs. */
function commit(paths: string[], hash = 'hash'): MemoryGitCommit {
  return { hash, date: '2026-11-13T00:00:00Z', message: 'touch', paths }
}

/** Commits repeats a one-path commit, for window-math fixtures. */
function commitsTouching(churnedPath: string, times: number): MemoryGitCommit[] {
  return Array.from({ length: times }, (_, index) => commit([churnedPath], `${churnedPath}-${index}`))
}

describe('churnByPath', () => {
  it('maps every path to its share of the window, first-appearance first', () => {
    const commits = [commit(['a.md', 'b.md']), commit(['a.md']), commit(['b.md']), commit(['c.md'])]
    // Window 4: a.md and b.md in 2 of 4, c.md in 1 of 4; the order follows
    // first appearance scanning the window from the newest commit.
    expect(churnByPath(commits, 4)).toEqual(
      new Map([
        ['a.md', 0.5],
        ['b.md', 0.5],
        ['c.md', 0.25],
      ]),
    )
  })

  it('measures the share against the window: 3 of 8 is 0.375', () => {
    const commits = [...commitsTouching('hot.md', 3), ...commitsTouching('other.md', 5)]
    // The default window of 8 covers the whole log.
    expect(churnByPath(commits, 8)).toEqual(
      new Map([
        ['hot.md', 0.375],
        ['other.md', 0.625],
      ]),
    )
  })

  it('clamps the window and measures a young store against its own history', () => {
    const commits = [commit(['a.md'], 'new'), commit(['a.md'], 'old')]
    // The default window is 8; the two-commit log is the denominator.
    expect(DEFAULT_CHURN_WINDOW_COMMITS).toBe(8)
    expect(churnByPath(commits)).toEqual(new Map([['a.md', 1]]))
  })

  it('ignores commits outside the window and counts one commit once per path', () => {
    const commits = [commit(['fresh.md', 'fresh.md'], 'new'), commit(['old.md'], 'old')]
    // Window 1: only the newest commit counts, and its duplicate path
    // still measures as the whole window.
    expect(churnByPath(commits, 1)).toEqual(new Map([['fresh.md', 1]]))
  })

  it('returns an empty map for an empty log', () => {
    expect(churnByPath([])).toEqual(new Map())
  })
})

describe('churnStressors', () => {
  it('returns nothing for an empty log', () => {
    expect(churnStressors([])).toEqual([])
  })

  it('applies the named defaults and treats a path at the bar as not a stressor', () => {
    const commits = [
      ...Array.from({ length: 4 }, (_, index) => commit(['hot.md', 'half.md'], `both-${index}`)),
      ...commitsTouching('hot.md', 4),
      commit(['old.md'], 'old-1'),
      commit(['old.md'], 'old-2'),
    ]
    // Default window 8: old.md sits outside it. Default bar 50%:
    // half.md ties at exactly 4 of 8 and "more than" excludes it;
    // hot.md sits in all 8.
    expect(DEFAULT_CHURN_THRESHOLD_PERCENT).toBe(50)
    expect(churnStressors(commits)).toEqual(['hot.md'])
  })

  it('honors an explicit window and fraction threshold', () => {
    const commits = [
      commit(['a.md', 'b.md'], 'c1'),
      commit(['a.md'], 'c2'),
      commit(['a.md'], 'c3'),
      commit(['b.md'], 'c4'),
    ]
    expect(churnStressors(commits, { windowCommits: 3, threshold: 0.5 })).toEqual(['a.md'])
  })

  it('counts one commit once per path and defaults the threshold when unnamed', () => {
    const commits = [commit(['dup.md', 'dup.md'], 'c1'), commit(['other.md'], 'c2')]
    // dup.md appears twice in the newest commit but counts it once: with
    // window 2 the bar is 1.0 and neither path clears "more than".
    expect(churnStressors(commits, { windowCommits: 2 })).toEqual([])
  })

  it('is exactly churnByPath filtered through the threshold, at its edge', () => {
    const commits = [
      commit(['hot.md', 'edge.md'], 'c1'),
      commit(['edge.md', 'cold.md'], 'c2'),
      commit(['cold.md'], 'c3'),
      commit(['cold.md'], 'c4'),
    ]
    // churnStressors must stay a pure filter over the one churn formula,
    // including a path sitting exactly at the bar (edge.md at 0.5).
    for (const windowCommits of [1, 2, 3, 4, 8]) {
      for (const threshold of [0, 0.25, 0.5, 0.75, 1]) {
        const expected = [...churnByPath(commits, windowCommits)]
          .filter(([, fraction]) => fraction > threshold)
          .map(([churnedPath]) => churnedPath)
        expect(churnStressors(commits, { windowCommits, threshold })).toEqual(expected)
      }
    }
    // A path at exactly the bar is excluded, and above it included:
    // window 2 has edge.md alone at 1.0; hot.md and cold.md tie at 0.5.
    expect(churnStressors(commits, { windowCommits: 2, threshold: 0.5 })).toEqual(['edge.md'])
    expect(churnStressors(commits, { windowCommits: 2, threshold: 0.75 })).toEqual(['edge.md'])
  })
})

describe('churnThresholdFraction', () => {
  it('divides the whole percent by 100 as the conversion single home', () => {
    expect(churnThresholdFraction(50)).toBe(0.5)
    expect(churnThresholdFraction(75)).toBe(0.75)
    expect(churnThresholdFraction(1)).toBe(0.01)
    // The constants agree: the unnamed stressor default is this same math.
    expect(churnThresholdFraction(DEFAULT_CHURN_THRESHOLD_PERCENT)).toBe(0.5)
  })

  it('carries a config percent to the same answers as the unnamed default', () => {
    const commits = [
      commit(['a.md', 'b.md'], 'c1'),
      commit(['a.md'], 'c2'),
      commit(['a.md'], 'c3'),
      commit(['b.md'], 'c4'),
    ]
    // Consumers pass the resolved git.churnThresholdPercent percent through
    // the helper; at the default 50 that must equal the unnamed bar.
    const viaConfig = churnStressors(commits, {
      windowCommits: DEFAULT_CHURN_WINDOW_COMMITS,
      threshold: churnThresholdFraction(DEFAULT_CHURN_THRESHOLD_PERCENT),
    })
    expect(viaConfig).toEqual(churnStressors(commits))
    expect(viaConfig).toEqual(['a.md'])
  })
})

describe('core barrel', () => {
  it('re-exports the churn math and its defaults from the package root', () => {
    expect(core.churnByPath).toBe(churnByPath)
    expect(core.churnStressors).toBe(churnStressors)
    expect(core.churnThresholdFraction).toBe(churnThresholdFraction)
    expect(core.DEFAULT_CHURN_WINDOW_COMMITS).toBe(DEFAULT_CHURN_WINDOW_COMMITS)
    expect(core.DEFAULT_CHURN_THRESHOLD_PERCENT).toBe(DEFAULT_CHURN_THRESHOLD_PERCENT)
  })
})
