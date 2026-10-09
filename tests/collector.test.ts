import { describe, it, expect } from 'vitest';
import { collect } from '../src/collector.js';
import type { ChecklistItem } from '../src/checklist.js';

function item(id: string, command: string): ChecklistItem {
  return { id, clause: `核查项${id}`, command };
}

describe('collect 采集与 guard 联动', () => {
  it('1. 全放行 → run 恰被调用 N 次', async () => {
    const items = [item('A1', 'cat /etc/hosts'), item('A2', 'ls -la'), item('A3', 'ps aux')];
    let calls = 0;
    const results = await collect(items, async () => {
      calls++;
      return { exitCode: 0, output: 'ok' };
    });
    expect(calls).toBe(3);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok && r.exitCode === 0)).toBe(true);
  });

  it('2. 危险命令项 → run 不被调用、blocked 有值、ok:false', async () => {
    const items = [item('A1', 'cat /etc/hosts'), item('A2', 'reboot'), item('A3', 'ls -la')];
    const executed: string[] = [];
    const results = await collect(items, async (cmd) => {
      executed.push(cmd);
      return { exitCode: 0, output: 'ok' };
    });
    // 只有 A1、A3 真正执行
    expect(executed).toEqual(['cat /etc/hosts', 'ls -la']);
    const blockedResult = results.find((r) => r.id === 'A2')!;
    expect(blockedResult.ok).toBe(false);
    expect(blockedResult.blocked).toBeTruthy();
    expect(blockedResult.exitCode).toBeNull();
  });

  it('3. run 对某项 reject → 该项 error 有值，后续项继续执行', async () => {
    const items = [item('A1', 'cat /etc/hosts'), item('A2', 'ls -la'), item('A3', 'ps aux')];
    const executed: string[] = [];
    const results = await collect(items, async (cmd) => {
      executed.push(cmd);
      if (cmd === 'ls -la') throw new Error('connect ECONNREFUSED');
      return { exitCode: 0, output: 'fine' };
    });
    expect(executed).toHaveLength(3); // A2 失败后 A3 仍执行
    const failed = results.find((r) => r.id === 'A2')!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('ECONNREFUSED');
    const after = results.find((r) => r.id === 'A3')!;
    expect(after.ok).toBe(true);
  });

  it('4. 输出含 ANSI 码（\\x1b[31m）→ 结果 output 已被 strip-ansi', async () => {
    const items = [item('A1', 'ps aux')];
    const results = await collect(items, async () => ({
      exitCode: 0,
      output: '\x1b[31mred-text\x1b[0m plain',
    }));
    expect(results[0].output).toBe('red-text plain');
    expect(results[0].output).not.toContain('\x1b');
  });

  it('5. 混合清单（1拦截+2正常）→ 3个结果，顺序与输入一致', async () => {
    const items = [item('M1', 'shutdown -h now'), item('M2', 'cat /etc/hosts'), item('M3', 'whoami')];
    const results = await collect(items, async () => ({ exitCode: 0, output: 'x' }));
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id)).toEqual(['M1', 'M2', 'M3']);
    expect(results[0].ok).toBe(false);
    expect(results[0].blocked).toBeTruthy();
    expect(results[1].ok).toBe(true);
    expect(results[2].ok).toBe(true);
    // 结果携带原命令
    expect(results[1].command).toBe('cat /etc/hosts');
  });
});
