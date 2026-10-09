import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import { startApprovalServer } from '../src/approval-server.js';
import type { ApprovalServer } from '../src/approval-server.js';
import type { ChecklistItem } from '../src/checklist.js';
import type { GuardResult } from '../src/guard.js';

// H-03 是被 guard 拦截的项（不可放行），H-01/H-02 预审放行
const ITEMS: ChecklistItem[] = [
  {
    id: 'H-01',
    clause: '操作系统口令有效期策略',
    command: 'cat /etc/login.defs | grep PASS_MAX_DAYS',
  },
  {
    id: 'H-02',
    clause: '应禁止SSH空口令登录',
    command: 'grep PermitEmptyPasswords /etc/ssh/sshd_config',
  },
  {
    id: 'H-03',
    clause: '多余或无用账户清理',
    command: 'rm -rf /tmp/demo',
  },
];

const GUARD_RESULTS = new Map<string, GuardResult>([
  ['H-01', { ok: true }],
  ['H-02', { ok: true }],
  ['H-03', { ok: false, blockedSegment: 'rm -rf /tmp/demo', reason: '包含危险片段（rm 删除）' }],
]);

const openServers: ApprovalServer[] = [];

/** 起一个被测 server（默认 port:0 让系统分配端口），测试结束统一 close */
async function start(overrides: Partial<{ port: number; timeoutMs: number }> = {}): Promise<ApprovalServer> {
  const server = await startApprovalServer({
    items: ITEMS,
    guardResults: GUARD_RESULTS,
    target: '127.0.0.1:2222',
    port: 0,
    ...overrides,
  });
  openServers.push(server);
  return server;
}

afterEach(() => {
  while (openServers.length > 0) openServers.pop()?.close();
});

/** server 的 origin（不含路径与 token） */
function origin(s: ApprovalServer): string {
  return `http://127.0.0.1:${new URL(s.url).port}`;
}

/** 在 ms 毫秒内 promise 是否保持未决（未 resolve 也未 reject → true） */
function pendingAfter<T>(p: Promise<T>, ms = 150): Promise<boolean> {
  return Promise.race([
    p.then(
      () => false,
      () => false
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms)),
  ]);
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('startApprovalServer HTTP 行为（黑盒 fetch）', () => {
  it('1. GET / 带 token → 200 HTML，含标题/目标机/每项编号条款命令/拦截原因/禁用勾选', async () => {
    const s = await start();
    const res = await fetch(s.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>核查命令放行</title>');
    expect(html).toContain('127.0.0.1:2222');
    for (const item of ITEMS) {
      expect(html).toContain(item.id);
      expect(html).toContain(item.clause);
      expect(html).toContain(item.command);
    }
    expect(html).toContain('预审放行');
    expect(html).toContain('预审拦截');
    expect(html).toContain('包含危险片段（rm 删除）');
    expect(html).toContain('disabled'); // 拦截项 checkbox 禁用
  });

  it('2. GET / 无 token 或错 token → 403 invalid token', async () => {
    const s = await start();
    const noToken = await fetch(origin(s) + '/');
    expect(noToken.status).toBe(403);
    expect(await noToken.text()).toContain('invalid token');
    const badToken = await fetch(origin(s) + '/?t=wrongtoken');
    expect(badToken.status).toBe(403);
    expect(await badToken.text()).toContain('invalid token');
  });

  it('3. POST /api/approve 正确 token + 合法 ids → 202，waitDecision 按提交顺序 resolve', async () => {
    const s = await start();
    const res = await postJson(origin(s) + '/api/approve', { token: s.token, ids: ['H-02', 'H-01'] });
    expect(res.status).toBe(202);
    const decision = await s.waitDecision();
    expect(decision).toEqual({ type: 'approve', ids: ['H-02', 'H-01'] });
  });

  it('4. POST /api/approve 错 token → 403 且 waitDecision 保持未决', async () => {
    const s = await start();
    const res = await postJson(origin(s) + '/api/approve', { token: 'deadbeef', ids: ['H-01'] });
    expect(res.status).toBe(403);
    expect(await pendingAfter(s.waitDecision())).toBe(true);
  });

  it('5. POST /api/approve 含拦截项/未知编号/空数组 → 400 invalid ids，且不 resolve', async () => {
    const s = await start();
    const blocked = await postJson(origin(s) + '/api/approve', { token: s.token, ids: ['H-01', 'H-03'] });
    expect(blocked.status).toBe(400);
    expect(await blocked.text()).toContain('invalid ids');
    expect(await pendingAfter(s.waitDecision())).toBe(true);

    const unknown = await postJson(origin(s) + '/api/approve', { token: s.token, ids: ['NOPE'] });
    expect(unknown.status).toBe(400);
    const empty = await postJson(origin(s) + '/api/approve', { token: s.token, ids: [] });
    expect(empty.status).toBe(400);
    expect(await pendingAfter(s.waitDecision())).toBe(true);
  });

  it('6. POST /api/reject 正确 token → 202 且 resolve {type:reject, ids:[]}', async () => {
    const s = await start();
    const res = await postJson(origin(s) + '/api/reject', { token: s.token });
    expect(res.status).toBe(202);
    const decision = await s.waitDecision();
    expect(decision).toEqual({ type: 'reject', ids: [] });
  });

  it('7. 第二次决定类 POST → 409', async () => {
    const s = await start();
    const first = await postJson(origin(s) + '/api/approve', { token: s.token, ids: ['H-01'] });
    expect(first.status).toBe(202);
    const second = await postJson(origin(s) + '/api/reject', { token: s.token });
    expect(second.status).toBe(409);
    expect(await s.waitDecision()).toEqual({ type: 'approve', ids: ['H-01'] });
  });

  it('8. timeoutMs 很短且无人操作 → waitDecision resolve {type:timeout}', async () => {
    const s = await start({ timeoutMs: 200 });
    const decision = await s.waitDecision();
    expect(decision).toEqual({ type: 'timeout', ids: [] });
  });

  it('9. /api/status：setResults 前 state=waiting，之后 state=done 且 results 深相等', async () => {
    const s = await start();
    const beforeRes = await fetch(origin(s) + '/api/status?t=' + s.token);
    expect(beforeRes.status).toBe(200);
    const before = (await beforeRes.json()) as { state: string; results?: unknown };
    expect(before.state).toBe('waiting');
    expect(before.results).toBeUndefined();

    const payload = {
      summary: { total: 2, pass: 1, fail: 0, manual: 1, blocked: 0 },
      judges: [
        { id: 'H-01', verdict: 'pass', evidence: 'PASS_MAX_DAYS\t90', reason: '输出命中符合标准' },
        { id: 'H-02', verdict: 'manual', evidence: '', reason: '无判定规则命中' },
      ],
      collects: [{ id: 'H-01', command: 'cat /etc/login.defs', ok: true, exitCode: 0, output: 'PASS_MAX_DAYS\t90' }],
    };
    s.setResults(payload);

    const afterRes = await fetch(origin(s) + '/api/status?t=' + s.token);
    const after = (await afterRes.json()) as { state: string; results?: unknown };
    expect(after.state).toBe('done');
    expect(after.results).toEqual(payload);

    const noToken = await fetch(origin(s) + '/api/status');
    expect(noToken.status).toBe(403);
  });

  it('10. close() 后：未决 waitDecision 立即 resolve reject，且端口不再响应', async () => {
    const s = await start();
    const base = origin(s);
    s.close();
    expect(await s.waitDecision()).toEqual({ type: 'reject', ids: [] });
    await expect(fetch(base + '/?t=' + s.token)).rejects.toThrow();
  });

  it('11. JSON body 解析失败 → 400，且不产生决定', async () => {
    const s = await start();
    const res = await postJson(origin(s) + '/api/approve', '{not valid json');
    expect(res.status).toBe(400);
    expect(await pendingAfter(s.waitDecision())).toBe(true);
  });

  it('12. 端口被占用时向后尝试；仅监听 127.0.0.1，非环回地址不可达', async () => {
    // 占住一个端口，被测 server 应落到下一个端口
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const blockedPort = (blocker.address() as net.AddressInfo).port;

    const s = await start({ port: blockedPort });
    const actualPort = Number(new URL(s.url).port);
    expect(actualPort).toBe(blockedPort + 1);
    const res = await fetch(s.url);
    expect(res.status).toBe(200);
    blocker.close();

    // 绑定 host 必须是 127.0.0.1：通过非环回地址（如局域网 IP）连接必须失败
    const lanIps = Object.values(os.networkInterfaces())
      .flat()
      .filter(
        (ni): ni is os.NetworkInterfaceInfo =>
          ni !== undefined && ni.family === 'IPv4' && !ni.internal
      );
    if (lanIps.length > 0) {
      const viaLan = await new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: lanIps[0].address, port: actualPort });
        sock.setTimeout(1000);
        sock.once('connect', () => {
          sock.destroy();
          resolve(true); // 不应该连得上
        });
        const fail = (): void => resolve(false);
        sock.once('error', fail);
        sock.once('timeout', () => {
          sock.destroy();
          fail();
        });
      });
      expect(viaLan, `server 不应监听非环回地址 ${lanIps[0].address}`).toBe(false);
    }
  });
});
