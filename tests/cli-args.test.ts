import { describe, it, expect } from 'vitest';
import { parseArgs, validateArgs } from '../src/cli.js';

describe('parseArgs / validateArgs（跳板机参数）', () => {
  it('1. 解析完整 jump 参数组', () => {
    const args = parseArgs([
      '--json', 'x.json',
      '--host', '10.0.0.5', '--user', 'audit_ro', '--pass', 'pw',
      '--jump-host', 'bastion.corp', '--jump-port', '60022',
      '--jump-user', 'ops', '--jump-pass', 'jpw',
    ]);
    expect(args.jumpHost).toBe('bastion.corp');
    expect(args.jumpPort).toBe(60022);
    expect(args.jumpUser).toBe('ops');
    expect(args.jumpPass).toBe('jpw');
    expect(validateArgs(args)).toHaveLength(0);
  });

  it('2. jump-port 默认 22', () => {
    const args = parseArgs([
      '--json', 'x.json',
      '--host', '10.0.0.5', '--user', 'u', '--pass', 'p',
      '--jump-host', 'b', '--jump-user', 'ops', '--jump-pass', 'j',
    ]);
    expect(args.jumpPort).toBe(22);
  });

  it('3. 指定 --jump-host 但缺 --jump-user → 报错', () => {
    const args = parseArgs([
      '--json', 'x.json',
      '--host', '10.0.0.5', '--user', 'u', '--pass', 'p',
      '--jump-host', 'b',
    ]);
    expect(validateArgs(args).join('\n')).toMatch(/--jump-user/);
  });

  it('4. jump 凭据 --jump-pass 与 --jump-key 都缺 → 报错', () => {
    const args = parseArgs([
      '--json', 'x.json',
      '--host', '10.0.0.5', '--user', 'u', '--pass', 'p',
      '--jump-host', 'b', '--jump-user', 'ops',
    ]);
    expect(validateArgs(args).join('\n')).toMatch(/--jump-pass|--jump-key/);
  });

  it('5. 不给 jump 参数 → 校验通过，jump 字段为空', () => {
    const args = parseArgs(['--json', 'x.json', '--host', 'h', '--user', 'u', '--pass', 'p']);
    expect(args.jumpHost).toBeUndefined();
    expect(validateArgs(args)).toHaveLength(0);
  });
});
