import { describe, it, expect } from 'vitest';
import { judgeItem, judgeAll } from '../src/judge.js';
import type { ChecklistItem } from '../src/checklist.js';
import type { CollectResult } from '../src/collector.js';

function makeCollect(partial: Partial<CollectResult>): CollectResult {
  return {
    id: 'X01',
    command: 'echo hi',
    ok: true,
    exitCode: 0,
    output: '',
    ...partial,
  };
}

describe('judgeItem 判定规则', () => {
  it('1. failPattern 命中 → fail，evidence 含命中行', () => {
    const item: ChecklistItem = {
      id: 'S01',
      clause: '禁止SSH空口令登录',
      command: "grep -E '^\\s*PermitEmptyPasswords\\s+yes' /etc/ssh/sshd_config",
      failPattern: 'PermitEmptyPasswords\\s+yes',
    };
    const r = makeCollect({
      id: 'S01',
      output: 'PermitEmptyPasswords yes\n# some comment\n',
    });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('fail');
    expect(j.evidence).toContain('PermitEmptyPasswords yes');
    expect(j.reason).toBeTruthy();
  });

  it('2. passPattern 命中 → pass', () => {
    const item: ChecklistItem = {
      id: 'S02',
      clause: '密码最长使用期≤90天',
      command: "grep -E '^PASS_MAX_DAYS' /etc/login.defs",
      passPattern: 'PASS_MAX_DAYS\\s+([1-9]|[1-8][0-9]|90)$',
    };
    const r = makeCollect({ id: 'S02', output: 'PASS_MAX_DAYS 90\n' });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('pass');
    expect(j.evidence).toContain('PASS_MAX_DAYS 90');
  });

  it('3. blocked → manual，reason 含“拦截”', () => {
    const item: ChecklistItem = { id: 'S06', clause: '危险演示', command: 'reboot' };
    const r = makeCollect({
      id: 'S06',
      ok: false,
      exitCode: null,
      output: '',
      blocked: '包含危险片段（reboot 重启）',
    });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('manual');
    expect(j.reason).toContain('拦截');
  });

  it('4. exitCode null（SSH 失败）→ manual，reason 注明执行失败', () => {
    const item: ChecklistItem = { id: 'S07', clause: '测试项', command: 'cat /etc/hosts' };
    const r = makeCollect({ id: 'S07', ok: false, exitCode: null, error: 'connect ECONNREFUSED' });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('manual');
    expect(j.reason).toContain('执行失败');
  });

  it('5. 无规则且输出非空 → manual“需人工确认”', () => {
    const item: ChecklistItem = { id: 'S05', clause: '开放端口核查', command: 'ss -tlnp' };
    const r = makeCollect({ id: 'S05', output: 'LISTEN 0 128 0.0.0.0:22\nLISTEN 0 128 0.0.0.0:80\n' });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('manual');
    expect(j.reason).toContain('需人工确认');
  });

  it('6. failPattern 与 passPattern 同时命中 → fail 优先', () => {
    const item: ChecklistItem = {
      id: 'S08',
      clause: '同时命中',
      command: 'cat /etc/x.conf',
      passPattern: 'good',
      failPattern: 'bad',
    };
    const r = makeCollect({ id: 'S08', output: 'line good\nline bad\n' });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('fail');
    expect(j.evidence).toContain('line bad');
  });

  it('7. evidence 上下文：3行输出命中中间行，evidence 含前一行与后一行', () => {
    const item: ChecklistItem = {
      id: 'S09',
      clause: '上下文验证',
      command: 'cat /etc/demo.conf',
      passPattern: 'MIDDLE',
    };
    const r = makeCollect({ id: 'S09', output: 'FIRST\nMIDDLE\nLAST\n' });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('pass');
    const lines = j.evidence.split('\n');
    expect(lines).toContain('FIRST');
    expect(lines).toContain('MIDDLE');
    expect(lines).toContain('LAST');
    // 顺序应保持输出顺序
    expect(lines.indexOf('FIRST')).toBeLessThan(lines.indexOf('MIDDLE'));
    expect(lines.indexOf('MIDDLE')).toBeLessThan(lines.indexOf('LAST'));
  });

  it('7b. 多处命中时上下文行去重（相邻命中共享上下文不重复出现）', () => {
    const item: ChecklistItem = {
      id: 'S10',
      clause: '去重验证',
      command: 'cat /etc/demo2.conf',
      passPattern: 'HIT',
    };
    const r = makeCollect({ id: 'S10', output: 'a\nHIT\nb\nHIT\nc\n' });
    const j = judgeItem(item, r);
    expect(j.verdict).toBe('pass');
    const lines = j.evidence.split('\n');
    expect(lines.filter((l) => l === 'a').length).toBe(1);
    expect(lines.filter((l) => l === 'b').length).toBe(1);
    expect(lines.filter((l) => l === 'HIT').length).toBe(2);
    expect(lines).toEqual(['a', 'HIT', 'b', 'HIT', 'c']);
  });
});

describe('judgeAll 逐项判定', () => {
  it('8. judgeAll 多条目逐一判定，id 对应输出结论', () => {
    const items: ChecklistItem[] = [
      { id: 'A1', clause: '通过项', command: 'cat a', passPattern: 'ok-line' },
      { id: 'A2', clause: '不符合项', command: 'cat b', failPattern: 'bad-line' },
      { id: 'A3', clause: '人工项', command: 'ss -tlnp' },
      { id: 'A4', clause: '拦截项', command: 'reboot' },
    ];
    const collects: CollectResult[] = [
      makeCollect({ id: 'A1', command: 'cat a', output: 'ok-line\n' }),
      makeCollect({ id: 'A2', command: 'cat b', output: 'bad-line\n' }),
      makeCollect({ id: 'A3', command: 'ss -tlnp', output: 'LISTEN 80\n' }),
      makeCollect({ id: 'A4', command: 'reboot', ok: false, exitCode: null, blocked: '危险' }),
    ];
    const judges = judgeAll(items, collects);
    expect(judges).toHaveLength(4);
    const byId = Object.fromEntries(judges.map((j) => [j.id, j]));
    expect(byId.A1.verdict).toBe('pass');
    expect(byId.A2.verdict).toBe('fail');
    expect(byId.A3.verdict).toBe('manual');
    expect(byId.A4.verdict).toBe('manual');
    // 顺序与输入一致
    expect(judges.map((j) => j.id)).toEqual(['A1', 'A2', 'A3', 'A4']);
  });
});
