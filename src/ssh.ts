import fs from 'node:fs';
import { Client } from 'ssh2';
import type { Client as ClientType } from 'ssh2';
import type { Socket } from 'node:net';
import type { CmdRunner } from './collector.js';

export interface JumpOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
}

export interface SshRunnerOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  timeoutMs?: number;
  /** 跳板机/堡垒机：先连跳板，再经 forwardOut 通道连接目标机 */
  jump?: JumpOptions;
}

function readKey(p: string | undefined): Buffer | undefined {
  return p === undefined ? undefined : fs.readFileSync(p);
}

/**
 * 创建基于 ssh2 的命令执行器（可选经跳板机转发）。
 * 连接成功 → resolve 一个 CmdRunner（附带 close() 结束连接）；
 * 连接失败 → reject。
 * 每条命令通过 client.exec 执行，stdout+stderr 合并为 output，
 * 以退出码 exitCode 结束（异常终止时 exitCode 为 null，Promise reject）。
 */
export function makeRunner(opts: SshRunnerOptions): Promise<CmdRunner & { close(): void }> {
  const { host, port, username, password, privateKeyPath, timeoutMs = 15000, jump } = opts;
  const privateKey = readKey(privateKeyPath);

  const client: ClientType = new Client();

  return new Promise<CmdRunner & { close(): void }>((resolve, reject) => {
    let settled = false;
    let jumpClient: ClientType | null = null;
    const onConnectError = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSH 连接失败 ${username}@${host}:${port}：${err.message}`));
        cleanup();
      }
    };
    const cleanup = (): void => {
      client.end();
      jumpClient?.end();
    };
    client.once('error', onConnectError);
    client.once('close', () => {
      // 连接意外断开且尚未就绪 → 视为连接失败
      if (!settled) {
        settled = true;
        reject(new Error(`SSH 连接被关闭 ${username}@${host}:${port}`));
        jumpClient?.end();
      }
    });

    // 目标机连接参数（经跳板时走 sock 通道，否则直连）
    const targetConnect = (sock?: Socket): void => {
      client.connect({
        host: sock === undefined ? host : undefined,
        port: sock === undefined ? port : undefined,
        sock,
        username,
        password,
        privateKey,
        readyTimeout: timeoutMs,
      });
    };

    if (jump === undefined) {
      targetConnect();
    } else {
      // 先连跳板机，再经 forwardOut 建立到目标机 22 端口的通道
      const jumpPrivateKey = readKey(jump.privateKeyPath);
      jumpClient = new Client();
      jumpClient.once('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`跳板机连接失败 ${jump.username}@${jump.host}:${jump.port}：${err.message}`));
          cleanup();
        }
      });
      jumpClient.once('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error(`跳板机连接被关闭 ${jump.host}:${jump.port}`));
          cleanup();
        }
      });
      jumpClient.connect({
        host: jump.host,
        port: jump.port,
        username: jump.username,
        password: jump.password,
        privateKey: jumpPrivateKey,
        readyTimeout: timeoutMs,
      });
      jumpClient.once('ready', () => {
        jumpClient?.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err) {
            if (!settled) {
              settled = true;
              reject(new Error(`跳板机转发失败 ${jump.host} → ${host}:${port}：${err.message}`));
              cleanup();
            }
            return;
          }
          targetConnect(stream as unknown as Socket);
        });
      });
    }

    client.once('ready', () => {
      settled = true;
      const run: CmdRunner = (cmd: string) =>
        new Promise<{ exitCode: number; output: string }>((resolveRun, rejectRun) => {
          client.exec(cmd, (err, stream) => {
            if (err) {
              rejectRun(new Error(`exec 失败：${err.message}`));
              return;
            }
            let output = '';
            stream.setEncoding('utf8');
            stream.on('data', (chunk: string) => {
              output += chunk; // stdout
            });
            stream.stderr.on('data', (chunk: string) => {
              output += chunk; // stderr 合并
            });
            stream.on('error', (streamErr: Error) => {
              rejectRun(new Error(`exec 流错误：${streamErr.message}`));
            });
            stream.on('close', (code: unknown) => {
              // CmdRunner 契约的 exitCode 为 number；信号终止等无退出码场景如实报错
              if (typeof code !== 'number') {
                rejectRun(new Error('命令被信号终止，未获得退出码'));
                return;
              }
              resolveRun({ exitCode: code, output });
            });
          });
        });

      resolve(
        Object.assign(run, {
          close(): void {
            client.end();
            jumpClient?.end();
          },
        })
      );
    });
  });
}
