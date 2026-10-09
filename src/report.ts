import type { ChecklistItem } from './checklist.js';
import type { CollectResult } from './collector.js';
import type { JudgeResult, Verdict } from './judge.js';
import { assertCommandSafe } from './guard.js';

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '符合（pass）',
  fail: '不符合（fail）',
  manual: '待人工确认（manual）',
};

/** 表格单元格内不能有裸换行，统一替换为 <br> */
function cell(text: string): string {
  const cleaned = text.replace(/\r/g, '').replace(/\n/g, '<br>').replace(/\|/g, '\\|');
  return cleaned.length > 0 ? cleaned : '（空）';
}

/**
 * 渲染初筛报告（Markdown）：
 * 标题 + 统计摘要（总/pass/fail/manual/被拦截数量）+ 逐项表格（编号|核查项|命令|结论|证据行/原因）
 */
export function renderReport(
  items: ChecklistItem[],
  collects: CollectResult[],
  judges: JudgeResult[]
): string {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const collectById = new Map(collects.map((c) => [c.id, c]));

  const total = judges.length;
  const pass = judges.filter((j) => j.verdict === 'pass').length;
  const fail = judges.filter((j) => j.verdict === 'fail').length;
  const manual = judges.filter((j) => j.verdict === 'manual').length;
  const blocked = collects.filter((c) => c.blocked !== undefined).length;

  const lines: string[] = [];
  lines.push('# 等保基线核查初筛报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push('> 本报告为工具自动初筛结果，manual 与 fail 项请结合截图取证脚本人工复核。');
  lines.push('');
  lines.push('## 统计摘要');
  lines.push('');
  lines.push(`- 核查项总数：${total}`);
  lines.push(`- 符合（pass）：${pass}`);
  lines.push(`- 不符合（fail）：${fail}`);
  lines.push(`- 待人工确认（manual）：${manual}`);
  lines.push(`- 被安全审查拦截：${blocked}`);
  lines.push('');
  lines.push('## 逐项结果');
  lines.push('');
  lines.push('| 编号 | 核查项 | 命令 | 结论 | 证据行/原因 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const j of judges) {
    const item = itemById.get(j.id);
    const c = collectById.get(j.id);
    const clause = item?.clause ?? '';
    const command = c?.command ?? item?.command ?? '';
    const detail = j.evidence.length > 0 ? `${j.evidence}` : j.reason;
    lines.push(`| ${cell(j.id)} | ${cell(clause)} | \`${cell(command)}\` | ${VERDICT_LABEL[j.verdict]} | ${cell(detail)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 渲染截图取证脚本（Markdown）：
 * 只含 fail 与 manual 项；每个核查项一块——
 *   ## [编号] 核查项描述
 *   执行命令：`xxx`
 *   预期说明：符合时应看到xxx / 初筛判定：……
 *   证据（初筛输出节选）：fenced code block
 * 用途：人工复制命令到目标机终端执行并截图留证。
 */
export function renderScreenshotScript(
  items: ChecklistItem[],
  collects: CollectResult[],
  judges: JudgeResult[]
): string {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const collectById = new Map(collects.map((c) => [c.id, c]));
  const targets = judges.filter((j) => j.verdict === 'fail' || j.verdict === 'manual');

  const lines: string[] = [];
  lines.push('# 截图取证脚本');
  lines.push('');
  lines.push('> 仅包含初筛判定为「不符合（fail）」或「待人工确认（manual）」的核查项。');
  lines.push('> 请人工将下列命令逐条复制到目标机终端执行，对照预期说明核对输出，并截图留证。');
  lines.push('');
  if (targets.length === 0) {
    lines.push('本次核查无 fail / manual 项，无需人工截图取证。');
    lines.push('');
    return lines.join('\n');
  }
  for (const j of targets) {
    const item = itemById.get(j.id);
    const c = collectById.get(j.id);
    const clause = item?.clause ?? '';
    const command = c?.command ?? item?.command ?? '';
    lines.push(`## [${j.id}] ${clause}`);
    lines.push('');
    lines.push(`执行命令：\`${command}\``);

    // 预期说明：符合标准 + 初筛判定
    const passHint =
      item?.passPattern !== undefined
        ? `符合时应看到命中正则 \`${item.passPattern}\``
        : item?.failPattern !== undefined
          ? `符合时不应看到命中正则 \`${item.failPattern}\``
          : '符合标准需依据核查清单人工判断';
    let verdictText: string;
    if (j.verdict === 'fail') {
      verdictText = `初筛判定：不符合——${j.reason}`;
    } else if (c?.blocked !== undefined) {
      verdictText = `初筛判定：待人工确认（命令被安全审查拦截，未自动执行；请人工评估后手动核查）`;
    } else {
      verdictText = `初筛判定：待人工确认——${j.reason}`;
    }
    lines.push(`预期说明：${passHint}；${verdictText}`);
    lines.push('');
    lines.push('证据（初筛输出节选）：');
    lines.push('```');
    const evidence =
      j.evidence.length > 0
        ? j.evidence
        : c?.blocked !== undefined
          ? `（该命令被安全审查拦截：${c.blocked}，无自动执行输出）`
          : c?.error !== undefined
            ? `（自动执行失败：${c.error}）`
            : '（无输出）';
    lines.push(evidence);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 渲染执行计划（--dry-run 人工放行预览）：
 * 逐项列出 编号|核查项|命令|guard 审查结果，标注 放行/拦截 及原因。
 * 只做静态审查展示，不连接服务器。
 */
export function renderPlan(items: ChecklistItem[]): string {
  const lines: string[] = [];
  lines.push('# 核查执行计划（待人工放行）');
  lines.push('');
  lines.push('> 以下为将向目标机发送的命令及安全审查结果。未获放行前不会执行任何命令。');
  lines.push('');
  let allowed = 0;
  let blocked = 0;
  for (const item of items) {
    const g = assertCommandSafe(item.command);
    if (g.ok) allowed++;
    else blocked++;
    const mark = g.ok ? '✅ 放行' : '❌ 拦截';
    const reason = g.ok ? '' : `——${g.reason}（段：${g.blockedSegment}）`;
    lines.push(`- ${mark} **${item.id}** ${item.clause}`);
    lines.push(`  - 命令：\`${item.command}\`${reason}`);
  }
  lines.push('');
  lines.push(`共 ${items.length} 项：guard 预审放行 ${allowed} 项、将拦截 ${blocked} 项。`);
  lines.push('');
  lines.push('放行方式：确认无误后加 `--only 编号1,编号2` 执行指定项，或不加限制执行全部放行项。');
  return lines.join('\n');
}
