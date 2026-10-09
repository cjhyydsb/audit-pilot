import type { ChecklistItem } from './checklist.js';
import type { CollectResult } from './collector.js';

export type Verdict = 'pass' | 'fail' | 'manual';

export interface JudgeResult {
  id: string;
  verdict: Verdict;
  evidence: string;
  reason: string;
}

/** 人工确认时附带的最大输出行数（辅助人工快速复核） */
const MANUAL_EXCERPT_LINES = 5;

/**
 * 正则是否命中输出的任意一行（compile 一次、逐行 test）。
 * 逐行匹配才能正确支持 `...90$` 这类行锚定的核查规则。
 */
function anyLineMatches(output: string, re: RegExp): boolean {
  return output.split('\n').some((line) => re.test(line));
}

/**
 * 从输出中提取命中行及其上下文（每个命中行前后各 1 行，去重，保持输出顺序）。
 * re 由调用方编译一次，逐行 test。
 */
function extractEvidence(output: string, re: RegExp): string {
  const lines = output.split('\n');
  const include = new Set<number>();
  lines.forEach((line, i) => {
    if (re.test(line)) {
      if (i > 0) include.add(i - 1);
      include.add(i);
      if (i < lines.length - 1) include.add(i + 1);
    }
  });
  return [...include]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join('\n');
}

/** 输出节选（前 N 行），用于 manual 项辅助人工确认 */
function excerpt(output: string, maxLines: number): string {
  const lines = output.split('\n').filter((l) => l.length > 0);
  return lines.slice(0, maxLines).join('\n');
}

/**
 * 按序判定一条核查项：
 *  1. r.blocked                → manual（命令被安全审查拦截）
 *  2. !r.ok 或 exitCode===null → manual（执行失败）
 *  3. failPattern 命中         → fail
 *  4. passPattern 命中         → pass
 *  5. 其余                      → manual（需人工确认）
 */
export function judgeItem(item: ChecklistItem, r: CollectResult): JudgeResult {
  // 1. guard 拦截
  if (r.blocked !== undefined) {
    return {
      id: item.id,
      verdict: 'manual',
      evidence: '',
      reason: `命令被安全审查拦截：${r.blocked}`,
    };
  }

  // 2. 执行失败（SSH 层面）
  if (!r.ok || r.exitCode === null) {
    return {
      id: item.id,
      verdict: 'manual',
      evidence: excerpt(r.output, MANUAL_EXCERPT_LINES),
      reason: `执行失败：${r.error ?? `exitCode=${r.exitCode}`}`,
    };
  }

  // 3. failPattern 优先
  if (item.failPattern !== undefined && item.failPattern.length > 0) {
    const failRe = new RegExp(item.failPattern);
    if (anyLineMatches(r.output, failRe)) {
      return {
        id: item.id,
        verdict: 'fail',
        evidence: extractEvidence(r.output, failRe),
        reason: `输出命中不符合标准（${item.failPattern}）`,
      };
    }
  }

  // 4. passPattern
  if (item.passPattern !== undefined && item.passPattern.length > 0) {
    const passRe = new RegExp(item.passPattern);
    if (anyLineMatches(r.output, passRe)) {
      return {
        id: item.id,
        verdict: 'pass',
        evidence: extractEvidence(r.output, passRe),
        reason: `输出命中符合标准（${item.passPattern}）`,
      };
    }
  }

  // 5. 需人工确认
  return {
    id: item.id,
    verdict: 'manual',
    evidence: excerpt(r.output, MANUAL_EXCERPT_LINES),
    reason: '无判定规则命中或未配置规则，需人工确认',
  };
}

/** 对整份清单逐项判定（按 items 顺序，按 id 匹配采集结果） */
export function judgeAll(items: ChecklistItem[], collects: CollectResult[]): JudgeResult[] {
  const byId = new Map<string, CollectResult>(collects.map((c) => [c.id, c]));
  return items.map((item) => {
    const r = byId.get(item.id);
    if (!r) {
      return {
        id: item.id,
        verdict: 'manual',
        evidence: '',
        reason: '执行失败：未找到对应的采集结果',
      } satisfies JudgeResult;
    }
    return judgeItem(item, r);
  });
}
