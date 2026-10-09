import { describe, it, expect } from 'vitest';
import { renderReport, renderScreenshotScript, renderPlan } from '../src/report.js';
import type { ChecklistItem } from '../src/checklist.js';
import type { CollectResult } from '../src/collector.js';
import type { JudgeResult } from '../src/judge.js';

// 构造一套完整数据：2 pass / 1 fail / 1 manual / 1 blocked（blocked 判为 manual）
const items: ChecklistItem[] = [
  { id: 'P1', clause: '通过项一', command: 'cat /etc/a.conf', passPattern: 'GOOD-A' },
  { id: 'P2', clause: '通过项二', command: 'cat /etc/b.conf', passPattern: 'GOOD-B' },
  { id: 'F1', clause: '不符合项', command: 'cat /etc/c.conf', failPattern: 'BAD-C' },
  { id: 'M1', clause: '人工确认项', command: 'ss -tlnp' },
  { id: 'B1', clause: '被拦截项', command: 'reboot' },
];

const collects: CollectResult[] = [
  { id: 'P1', command: 'cat /etc/a.conf', ok: true, exitCode: 0, output: 'GOOD-A here\n' },
  { id: 'P2', command: 'cat /etc/b.conf', ok: true, exitCode: 0, output: 'GOOD-B here\n' },
  { id: 'F1', command: 'cat /etc/c.conf', ok: true, exitCode: 0, output: 'BAD-C found\n' },
  { id: 'M1', command: 'ss -tlnp', ok: true, exitCode: 0, output: 'LISTEN 0.0.0.0:22\n' },
  { id: 'B1', command: 'reboot', ok: false, exitCode: null, output: '', blocked: '包含危险片段（reboot 重启）' },
];

const judges: JudgeResult[] = [
  { id: 'P1', verdict: 'pass', evidence: 'GOOD-A here', reason: '输出命中符合标准（GOOD-A）' },
  { id: 'P2', verdict: 'pass', evidence: 'GOOD-B here', reason: '输出命中符合标准（GOOD-B）' },
  { id: 'F1', verdict: 'fail', evidence: 'BAD-C found', reason: '输出命中不符合标准（BAD-C）' },
  { id: 'M1', verdict: 'manual', evidence: 'LISTEN 0.0.0.0:22', reason: '无判定规则命中或未配置规则，需人工确认' },
  { id: 'B1', verdict: 'manual', evidence: '', reason: '命令被安全审查拦截：包含危险片段（reboot 重启）' },
];

describe('renderReport 初筛报告', () => {
  const report = renderReport(items, collects, judges);

  it('1. 统计摘要数字正确（总5 / pass2 / fail1 / manual2 / 拦截1）', () => {
    expect(report).toMatch(/5/); // 总数
    expect(report).toContain('符合（pass）：2');
    expect(report).toContain('不符合（fail）：1');
    expect(report).toContain('待人工确认（manual）：2');
    expect(report).toContain('被安全审查拦截：1');
  });

  it('2. 报告含每个编号与表头结构', () => {
    for (const id of ['P1', 'P2', 'F1', 'M1', 'B1']) {
      expect(report).toContain(id);
    }
    expect(report).toContain('编号');
    expect(report).toContain('核查项');
    expect(report).toContain('命令');
    expect(report).toContain('结论');
  });
});

describe('renderScreenshotScript 截图取证脚本', () => {
  const script = renderScreenshotScript(items, collects, judges);

  it('3. 只含 fail/manual 项（F1、M1、B1），不含 pass 项编号（P1、P2）', () => {
    expect(script).toContain('F1');
    expect(script).toContain('M1');
    expect(script).toContain('B1');
    expect(script).not.toContain('P1');
    expect(script).not.toContain('P2');
  });

  it('4. 每块含“执行命令”与“预期说明”字样', () => {
    // F1 块
    expect(script).toContain('## [F1]');
    expect(script).toContain('## [M1]');
    expect(script).toContain('## [B1]');
    // 执行命令与预期说明在每个块中都应出现（3 块 → 各出现 3 次）
    expect(script.split('执行命令：').length - 1).toBe(3);
    expect(script.split('预期说明：').length - 1).toBe(3);
    // 命令本身出现在反引号内
    expect(script).toContain('`ss -tlnp`');
    expect(script).toContain('`reboot`');
    // 证据节选以 fenced code block 呈现
    expect(script).toContain('证据（初筛输出节选）');
    expect(script).toContain('```');
  });

  it('4b. fail 块注明“不符合”，manual 块注明“待人工确认”或“拦截”', () => {
    const f1Block = script.split('## [F1]')[1].split('## ')[0];
    expect(f1Block).toContain('不符合');
    const m1Block = script.split('## [M1]')[1].split('## ')[0];
    expect(m1Block).toContain('待人工确认');
    const b1Block = script.split('## [B1]')[1].split('## ')[0];
    expect(b1Block).toContain('拦截');
  });
});

describe('renderPlan', () => {
  const items: import('../src/checklist.js').ChecklistItem[] = [
    { id: 'H-01', clause: '会话超时', command: 'grep -E "TMOUT" /etc/profile' },
    { id: 'H-02', clause: '危险演示', command: 'reboot' },
  ];

  it('包含每项编号、条款与命令', () => {
    const plan = renderPlan(items);
    expect(plan).toContain('H-01');
    expect(plan).toContain('会话超时');
    expect(plan).toContain('grep -E "TMOUT" /etc/profile');
    expect(plan).toContain('H-02');
  });

  it('放行项与拦截项分别标注，拦截项含原因', () => {
    const plan = renderPlan(items);
    expect(plan).toMatch(/H-01[\s\S]{0,200}(放行|✅)/);
    expect(plan).toMatch(/H-02[\s\S]{0,200}(拦截|❌)/);
    expect(plan).toContain('只读白名单');
  });
});
