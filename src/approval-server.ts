import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ChecklistItem } from './checklist.js';
import type { GuardResult } from './guard.js';

/** 浏览器做出的决定（或超时） */
export interface ApprovalDecision {
  type: 'approve' | 'reject' | 'timeout';
  ids: string[]; // approve 时为放行编号（按提交顺序）；其余为空数组
}

/** 审批 server 句柄 */
export interface ApprovalServer {
  url: string; // 如 http://127.0.0.1:8787/?t=<token>
  token: string;
  waitDecision(): Promise<ApprovalDecision>; // 决定或超时后 resolve（只 resolve 一次）
  setResults(payload: unknown): void; // 执行完成后回填结果，页面轮询可见
  close(): void; // 立即关 server（未决的 waitDecision resolve {type:'reject', ids:[]}）
}

const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 300000; // 5 分钟无人操作自动拒绝
const PORT_RETRY_ATTEMPTS = 20; // 默认端口被占用时最多向后尝试 20 个端口
const MAX_BODY_BYTES = 1_000_000;

/** HTML 转义（命令/条款等动态文本全部过这里，防注入） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendText(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendHtml(res: ServerResponse, code: number, html: string): void {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 读取请求 body（带 1MB 上限），超限/流错误 → reject */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', (err: Error) => reject(err));
  });
}

/** 在 127.0.0.1 上监听：port=0 由系统分配；正整数被占用（EADDRINUSE）时向后尝试最多 20 个 */
function listenLoopback(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const maxAttempts = port === 0 ? 1 : PORT_RETRY_ATTEMPTS;
    let attempt = 0;
    const tryListen = (): void => {
      const candidate = port === 0 ? 0 : port + attempt;
      const onError = (err: Error & { code?: string }): void => {
        if (err.code === 'EADDRINUSE' && attempt + 1 < maxAttempts) {
          attempt += 1;
          tryListen();
          return;
        }
        reject(new Error(`审批页监听 127.0.0.1:${candidate} 失败：${err.message}`));
      };
      server.once('error', onError);
      server.listen(candidate, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    };
    tryListen();
  });
}

/**
 * 启动审批 server：仅绑定 127.0.0.1。
 * 生命周期：启动即开始倒计时 → 浏览器放行/拒绝（或超时）→ CLI 执行 → setResults 回填 → close。
 */
export async function startApprovalServer(opts: {
  items: ChecklistItem[];
  guardResults: Map<string, GuardResult>; // item.id → 预审结果
  target: string; // 目标机描述（host:port）
  port?: number; // 默认 8787；被占用时向后尝试最多 20 个端口；0 = 系统分配
  timeoutMs?: number; // 默认 300000，无人操作自动 {type:'timeout'}
}): Promise<ApprovalServer> {
  const { items, guardResults, target } = opts;
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = randomBytes(24).toString('hex');
  const approvable = new Set(
    items.filter((i) => guardResults.get(i.id)?.ok === true).map((i) => i.id)
  );

  // ---- 决定状态机（只 settle 一次） ----
  let decision: ApprovalDecision | null = null;
  let resolveWait!: (d: ApprovalDecision) => void;
  const waitPromise = new Promise<ApprovalDecision>((res) => {
    resolveWait = res;
  });
  let timer: NodeJS.Timeout | undefined;
  const settle = (d: ApprovalDecision): boolean => {
    if (decision !== null) return false;
    decision = d;
    if (timer !== undefined) clearTimeout(timer);
    resolveWait(d);
    return true;
  };

  // ---- 结果回填 ----
  let results: unknown;
  let hasResults = false;

  // ---- HTTP 路由 ----
  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');

    // 审批页
    if (req.method === 'GET' && u.pathname === '/') {
      if (u.searchParams.get('t') !== token) {
        sendText(res, 403, 'invalid token');
        return;
      }
      sendHtml(res, 200, renderApprovalPage(items, guardResults, target, Date.now() + remainingMs(), timeoutMs));
      return;
    }

    // 决定类接口：/api/approve 与 /api/reject
    if (req.method === 'POST' && (u.pathname === '/api/approve' || u.pathname === '/api/reject')) {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendText(res, 400, 'invalid body');
        return;
      }
      const obj = (body ?? {}) as Record<string, unknown>;
      if (obj.token !== token) {
        sendText(res, 403, 'invalid token');
        return;
      }
      if (decision !== null) {
        sendText(res, 409, 'already decided');
        return;
      }
      if (u.pathname === '/api/reject') {
        settle({ type: 'reject', ids: [] });
        sendText(res, 202, 'rejected');
        return;
      }
      const ids = obj.ids;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        !ids.every((id): id is string => typeof id === 'string' && approvable.has(id))
      ) {
        // 含被拦截项、未知编号或空数组都不允许（空数组放行会在 CLI 侧误放全量，故也拒绝）
        sendText(res, 400, 'invalid ids');
        return;
      }
      settle({ type: 'approve', ids: [...ids] }); // 保持提交顺序
      sendText(res, 202, 'approved');
      return;
    }

    // 状态轮询（页面执行期每 1.5s 拉一次）
    if (req.method === 'GET' && u.pathname === '/api/status') {
      if (u.searchParams.get('t') !== token) {
        sendText(res, 403, 'invalid token');
        return;
      }
      const payload: { state: 'waiting' | 'done'; decision?: ApprovalDecision; results?: unknown } = {
        state: hasResults ? 'done' : 'waiting',
      };
      if (decision !== null) payload.decision = decision;
      if (hasResults) payload.results = results;
      sendJson(res, 200, payload);
      return;
    }

    sendText(res, 404, 'not found');
  };

  const startedAt = Date.now();
  const remainingMs = (): number => {
    const left = startedAt + timeoutMs - Date.now();
    return left > 0 ? left : 0;
  };

  const httpServer = http.createServer((req, res) => {
    dispatch(req, res).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'internal error');
      else res.end();
    });
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    settle({ type: 'reject', ids: [] }); // 已有决定时是 no-op
    if (timer !== undefined) clearTimeout(timer);
    try {
      // Node 18.2+：断开保持连接的 socket，让页面轮询立刻失败而不是挂着
      (httpServer as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* 忽略 */
    }
    httpServer.close(() => undefined); // 回调吞掉 ERR_SERVER_NOT_RUNNING
  };

  const actualPort = await listenLoopback(httpServer, port);
  // 监听成功后吞掉后续 server 级 error，避免偶发 socket 错误打崩 CLI 进程
  httpServer.on('error', () => undefined);

  // 超时计时从 server 启动开始；做出决定后由 settle 取消
  timer = setTimeout(() => settle({ type: 'timeout', ids: [] }), timeoutMs);
  timer.unref(); // 不阻止进程正常退出

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    token,
    waitDecision: () => waitPromise,
    setResults: (payload: unknown): void => {
      results = payload;
      hasResults = true;
    },
    close,
  };
}

/* ------------------------------------------------------------------ */
/* 审批页（单文件、无外部资源：内嵌 CSS + 原生 JS）                       */
/* ------------------------------------------------------------------ */

const PAGE_CSS = `
  :root { --ok:#16a34a; --bad:#dc2626; --manual:#d97706; --primary:#2563eb; --line:#e5e7eb; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 48px; background: #f2f4f8; color: #1f2937;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; }
  header.head { margin-bottom: 16px; }
  header.head h1 { margin: 0 0 8px; font-size: 22px; }
  .meta { color: #4b5563; font-size: 14px; }
  .meta b { font-family: Consolas, Menlo, monospace; }
  .hint { margin: 8px 0 0; color: #6b7280; font-size: 13px; }
  .countdown { margin-top: 10px; font-size: 13px; color: var(--manual); }
  .countdown b { font-size: 16px; font-family: Consolas, Menlo, monospace; }
  .toolbar { display: flex; gap: 8px; margin: 0 0 12px; }
  .toolbar button {
    border: 1px solid var(--line); background: #fff; border-radius: 8px;
    padding: 5px 14px; font-size: 13px; cursor: pointer;
  }
  .toolbar button:hover { border-color: #9ca3af; }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .item label.top { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .item.blocked label.top { cursor: not-allowed; }
  .item .id { font-family: Consolas, Menlo, monospace; font-weight: 700; }
  .badge {
    font-size: 12px; padding: 2px 10px; border-radius: 999px; white-space: nowrap;
  }
  .badge.ok { color: var(--ok); background: #dcfce7; }
  .badge.bad { color: var(--bad); background: #fee2e2; }
  .clause { margin: 8px 0 6px; font-size: 14px; }
  pre.cmd {
    margin: 0; padding: 10px 12px; background: #f6f8fa; border: 1px solid var(--line);
    border-radius: 8px; font-family: Consolas, Menlo, "Courier New", monospace;
    font-size: 13px; white-space: pre-wrap; word-break: break-all;
  }
  .reason { margin-top: 6px; font-size: 13px; color: var(--bad); }
  footer.actions { margin-top: 16px; display: flex; gap: 12px; align-items: center; }
  button.primary {
    border: none; background: var(--primary); color: #fff; border-radius: 8px;
    padding: 10px 26px; font-size: 15px; cursor: pointer;
  }
  button.primary:disabled { background: #9ca3af; cursor: not-allowed; }
  button.secondary {
    border: 1px solid var(--line); background: #fff; color: #374151;
    border-radius: 8px; padding: 10px 22px; font-size: 15px; cursor: pointer;
  }
  button.secondary:hover { border-color: #9ca3af; }
  #statusbar { margin-top: 16px; font-size: 15px; display: none; }
  #statusbar.show { display: block; }
  #statusbar.run { border-color: #bfdbfe; background: #eff6ff; }
  #statusbar.warn { border-color: #fecaca; background: #fef2f2; color: var(--bad); }
  #statusbar .rows { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; }
  .row .rid { font-family: Consolas, Menlo, monospace; font-weight: 700; min-width: 52px; }
  .v { padding: 1px 10px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .v.pass { color: var(--ok); background: #dcfce7; }
  .v.fail { color: var(--bad); background: #fee2e2; }
  .v.manual { color: var(--manual); background: #fef3c7; }
  .row pre.ev {
    margin: 0; flex: 1; padding: 6px 10px; background: #f6f8fa; border-radius: 6px;
    font-family: Consolas, Menlo, monospace; font-size: 12px; white-space: pre-wrap;
    word-break: break-all;
  }
  .summary { font-size: 14px; color: #374151; }
`;

// 页面 JS：原生、无框架；不用反引号模板串（避免与 TS 模板串的 ${} 冲突）
const PAGE_JS = `
  (function () {
    var token = new URLSearchParams(location.search).get('t') || '';
    var deadline = __DEADLINE_MS__;
    var el = function (id) { return document.getElementById(id); };
    var countdownBox = el('countdown-box');
    var countdownNum = el('countdown-num');
    var approveBtn = el('btn-approve');
    var rejectBtn = el('btn-reject');
    var toolbar = el('toolbar');
    var list = el('list');
    var actions = el('actions');
    var statusbar = el('statusbar');
    var tickTimer = null;
    var pollTimer = null;

    function boxes() {
      return Array.prototype.filter.call(
        document.querySelectorAll('input[type=checkbox][data-id]'),
        function (b) { return !b.disabled; }
      );
    }
    function checkedIds() {
      return boxes()
        .filter(function (b) { return b.checked; })
        .map(function (b) { return b.getAttribute('data-id'); });
    }
    function refreshApproveBtn() {
      approveBtn.disabled = checkedIds().length === 0;
    }
    function stopTick() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (countdownBox) countdownBox.style.display = 'none';
    }
    function showMessage(text, cls) {
      statusbar.textContent = text;
      statusbar.className = 'card show ' + (cls || '');
    }
    function enterChosen() {
      toolbar.style.display = 'none';
      list.style.display = 'none';
      actions.style.display = 'none';
    }

    // ---- 倒计时（剩余自动拒绝秒数） ----
    function tick() {
      var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      countdownNum.textContent = String(left);
      if (left <= 0) {
        stopTick();
        enterChosen();
        showMessage('已超时自动拒绝，未执行任何命令', 'warn');
      }
    }
    tickTimer = setInterval(tick, 250);

    // ---- 勾选交互 ----
    Array.prototype.forEach.call(
      document.querySelectorAll('input[type=checkbox]'),
      function (b) { b.addEventListener('change', refreshApproveBtn); }
    );
    el('sel-all').addEventListener('click', function () {
      boxes().forEach(function (b) { b.checked = true; });
      refreshApproveBtn();
    });
    el('sel-none').addEventListener('click', function () {
      boxes().forEach(function (b) { b.checked = false; });
      refreshApproveBtn();
    });

    // ---- 执行期轮询：done 后渲染 results ----
    function renderResults(results) {
      if (!results) { showMessage('执行完成（无结果数据）', ''); return; }
      statusbar.textContent = '';
      statusbar.className = 'card show';
      if (results.summary) {
        var s = results.summary;
        var p = document.createElement('div');
        p.className = 'summary';
        p.textContent = '核查项总数 ' + (s.total != null ? s.total : '-') +
          ' · 符合 ' + (s.pass != null ? s.pass : '-') +
          ' · 不符合 ' + (s.fail != null ? s.fail : '-') +
          ' · 待人工确认 ' + (s.manual != null ? s.manual : '-') +
          ' · 被拦截 ' + (s.blocked != null ? s.blocked : '-');
        statusbar.appendChild(p);
      }
      var rows = document.createElement('div');
      rows.className = 'rows';
      var judges = Array.isArray(results.judges) ? results.judges : [];
      var labels = { pass: '符合', fail: '不符合', manual: '待人工' };
      judges.forEach(function (j) {
        var row = document.createElement('div');
        row.className = 'row';
        var rid = document.createElement('span');
        rid.className = 'rid';
        rid.textContent = String(j.id || '');
        var v = document.createElement('span');
        v.className = 'v ' + (labels[j.verdict] ? j.verdict : 'manual');
        v.textContent = labels[j.verdict] || String(j.verdict || '');
        var ev = document.createElement('pre');
        ev.className = 'ev';
        ev.textContent = String(j.evidence || j.reason || '');
        row.appendChild(rid); row.appendChild(v); row.appendChild(ev);
        rows.appendChild(row);
      });
      statusbar.appendChild(rows);
    }
    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    function poll() {
      fetch('/api/status?t=' + encodeURIComponent(token))
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (data.state === 'done') {
            stopPoll(); stopTick();
            renderResults(data.results);
            return;
          }
          var d = data.decision;
          if (d && d.type === 'timeout') {
            stopPoll(); stopTick(); enterChosen();
            showMessage('已超时自动拒绝，未执行任何命令', 'warn');
          }
        })
        .catch(function () { /* 网络抖动，下个周期再试 */ });
    }

    function enterRunning(count) {
      stopTick();
      enterChosen();
      showMessage('已放行 ' + count + ' 项，正在执行…（页面每 1.5 秒自动刷新，请勿关闭）', 'run');
      stopPoll();
      pollTimer = setInterval(poll, 1500);
      poll();
    }

    // ---- 决定按钮 ----
    approveBtn.addEventListener('click', function () {
      var ids = checkedIds();
      if (ids.length === 0) return;
      approveBtn.disabled = true;
      fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token, ids: ids })
      })
        .then(function (res) {
          if (res.status === 202) { enterRunning(ids.length); return; }
          if (res.status === 409) { enterChosen(); showMessage('已做出决定，无需重复操作', 'warn'); return; }
          return res.text().then(function (t) {
            approveBtn.disabled = false;
            showMessage('放行失败（HTTP ' + res.status + '）：' + t, 'warn');
          });
        })
        .catch(function (e) {
          approveBtn.disabled = false;
          showMessage('网络错误：' + e.message, 'warn');
        });
    });
    rejectBtn.addEventListener('click', function () {
      rejectBtn.disabled = true;
      fetch('/api/reject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token })
      })
        .then(function (res) {
          if (res.status === 202 || res.status === 409) {
            stopTick(); enterChosen();
            showMessage('已拒绝，未执行任何命令', '');
            return;
          }
          return res.text().then(function (t) {
            rejectBtn.disabled = false;
            showMessage('拒绝失败（HTTP ' + res.status + '）：' + t, 'warn');
          });
        })
        .catch(function (e) {
          rejectBtn.disabled = false;
          showMessage('网络错误：' + e.message, 'warn');
        });
    });

    // ---- 打开页面时先查一次状态：刷新/迟到打开也能对齐当前阶段 ----
    fetch('/api/status?t=' + encodeURIComponent(token))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (data.state === 'done') { stopTick(); enterChosen(); renderResults(data.results); return; }
        var d = data.decision;
        if (!d) return;
        if (d.type === 'approve') { enterRunning(d.ids ? d.ids.length : 0); }
        else if (d.type === 'reject') { stopTick(); enterChosen(); showMessage('已拒绝，未执行任何命令', ''); }
        else if (d.type === 'timeout') { stopTick(); enterChosen(); showMessage('已超时自动拒绝，未执行任何命令', 'warn'); }
      })
      .catch(function () { /* 忽略 */ });
  })();
`;

/** 渲染审批页 HTML（服务端渲染清单卡片 + 内嵌 CSS/JS，零外部资源） */
function renderApprovalPage(
  items: ChecklistItem[],
  guardResults: Map<string, GuardResult>,
  target: string,
  deadlineMs: number,
  timeoutMs: number
): string {
  const cards = items
    .map((item) => {
      const guard = guardResults.get(item.id);
      const blocked = guard !== undefined && !guard.ok;
      const reason = blocked
        ? `\n      <div class="reason">拦截原因：${escapeHtml(`${guard.reason}（段：${guard.blockedSegment}）`)}</div>`
        : '';
      const checkbox = blocked
        ? `<input type="checkbox" data-id="${escapeHtml(item.id)}" disabled>`
        : `<input type="checkbox" data-id="${escapeHtml(item.id)}">`;
      const badge = blocked
        ? '<span class="badge bad">预审拦截</span>'
        : '<span class="badge ok">预审放行</span>';
      return `\n    <div class="card item${blocked ? ' blocked' : ''}">
      <label class="top">${checkbox} <span class="id">${escapeHtml(item.id)}</span> ${badge}</label>
      <div class="clause">${escapeHtml(item.clause)}</div>
      <pre class="cmd">${escapeHtml(item.command)}</pre>${reason}
    </div>`;
    })
    .join('');

  const initialSeconds = Math.ceil(timeoutMs / 1000);
  const js = PAGE_JS.replace('__DEADLINE_MS__', String(deadlineMs));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>核查命令放行</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="card head">
    <h1>核查命令放行</h1>
    <div class="meta">目标机：<b>${escapeHtml(target)}</b></div>
    <p class="hint">以下命令尚未执行，勾选并放行后才会发送到目标机；仅放行你逐条确认过的命令。</p>
    <div class="countdown" id="countdown-box">无人操作将自动拒绝，剩余 <b id="countdown-num">${initialSeconds}</b> 秒</div>
  </header>

  <div class="toolbar" id="toolbar">
    <button type="button" id="sel-all">全选</button>
    <button type="button" id="sel-none">全不选</button>
  </div>

  <main class="list" id="list">${cards}
  </main>

  <footer class="card actions" id="actions">
    <button type="button" id="btn-approve" class="primary" disabled>放行所选并执行</button>
    <button type="button" id="btn-reject" class="secondary">拒绝</button>
  </footer>

  <section id="statusbar" class="card"></section>
</div>
<script>${js}</script>
</body>
</html>`;
}
