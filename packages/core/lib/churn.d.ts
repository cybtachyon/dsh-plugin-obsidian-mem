/**
 * Git-history churn: the repo's single churn formula and the defaults behind
 * it. Churn answers "how often does this path keep getting edited", computed
 * pure over {@link MemoryGitCommit} lists, the newest-first output of
 * `MemoryGit.log`. The audit note rows, the dream Step 4 stressor pass, and
 * every later consumer read these same numbers instead of re-deriving a
 * tally. Callers gather commits through `MemoryGit.log`, resolve the config
 * tunables (`git.churnWindowCommits`, `git.churnThresholdPercent`), and hand
 * this module the plain data; core stays framework-free and never reads
 * config itself.
 * @module dsh-plugin-obsidian-mem/core/churn
 */
import type { MemoryGitCommit } from './memory-git.js';
/**
 * DEFAULT_CHURN_WINDOW_COMMITS is how many of the most recent commits
 * churnByPath and churnStressors inspect when the caller names no window.
 * The figure also seeds the config default `git.churnWindowCommits`
 * (TASK-003); consumers read the resolved config and pass it in.
 */
export declare const DEFAULT_CHURN_WINDOW_COMMITS = 8;
/**
 * DEFAULT_CHURN_THRESHOLD_PERCENT is the stressor bar in whole percent: a
 * path churns in more than this share of the window to qualify. It stays in
 * percent form because the dream prompt spells the figure
 * `{{CHURN_THRESHOLD_PERCENT}}%` and the config knob is
 * `git.churnThresholdPercent` (TASK-003); churnStressors thresholds against
 * a fraction, produced by {@link churnThresholdFraction}. The percent is
 * also the config default only, never a live consumer value.
 */
export declare const DEFAULT_CHURN_THRESHOLD_PERCENT = 50;
/**
 * ChurnThresholdFraction converts a whole percent (the config
 * `git.churnThresholdPercent` shape) into the fraction churnStressors
 * thresholds against: the percent-to-fraction conversion's single home, so
 * no consumer divides by 100 on its own.
 * @param percent - the threshold in whole percent.
 */
export declare function churnThresholdFraction(percent: number): number;
/** The steering churnStressors accepts; defaults are the named constants. */
export interface ChurnStressorOptions {
    /** How many of the most recent commits to inspect. */
    windowCommits?: number;
    /**
     * A path must churn in strictly more than this share of the window. A
     * fraction: pass `churnThresholdFraction(git.churnThresholdPercent)`.
     */
    threshold?: number;
}
/**
 * ChurnByPath maps each path to the share of the most recent windowCommits
 * commits that touched it: a path in 3 of the last 8 commits churns at 0.375.
 * Input is `MemoryGit.log` output, newest first: the denominator is the
 * smaller of windowCommits and the log's own length, so a young store
 * measures against its history and an empty log yields an empty map. A path
 * touched several times within one commit still counts that commit once.
 * Entries keep first-appearance order while scanning the window, newest
 * commit first. This is the repo's single churn formula: churnStressors
 * filters this map through a threshold and the audit rows read the fractions
 * directly, so neither re-derives a tally.
 * @param commits - newest-first commits with the paths each touched.
 * @param windowCommits - how many of the most recent commits to inspect.
 */
export declare function churnByPath(commits: readonly MemoryGitCommit[], windowCommits?: number): Map<string, number>;
/**
 * ChurnStressors lists the paths that churn (see churnByPath) in strictly
 * more than threshold of the most recent windowCommits commits; a path
 * sitting exactly at the bar is not a stressor. Filtering churnByPath keeps
 * one churn formula for the whole repo. Results keep churnByPath's
 * first-appearance order, newest commit first.
 * @param commits - newest-first commits with the paths each touched.
 * @param options - window size and fraction threshold overrides.
 */
export declare function churnStressors(commits: readonly MemoryGitCommit[], { windowCommits, threshold, }?: ChurnStressorOptions): string[];
//# sourceMappingURL=churn.d.ts.map
