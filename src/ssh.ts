import fs from 'node:fs';
import { Client } from 'ssh2';
import type { Client as ClientType } from 'ssh2';
import type { CmdRunner } from './collector.js';

export interface SshRunnerOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  timeoutMs?: number;
}

/**
 * 创建基于 ssh2 的命令执行器。
 * 连接成功 → resolve 一个 CmdRunner（附带 close() 结束连接）；
 * 连接失败 → reject。
 * 每条命令通过 client.exec 执行，stdout+stderr 合并为 output，
 * 以退出码 exitCode 结束（异常终止时 exitCode 为 null，Promise reject）。
 */
export function makeRunner(opts: SshRunnerOptions): Promise<CmdRunner & { close(): void }> {
  const { host, port, username, password, privateKeyPath, timeoutMs = 15000 } = opts;

  let privateKey: Buffer | undefined;
  if (privateKeyPath !== undefined) {
    privateKey = fs.readFileSync(privateKeyPath);
  }

  const client: ClientType = new Client();

  return new Promise<CmdRunner & { close(): void }>((resolve, reject) => {
    let settled = false;
    const onConnectError = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSH 连接失败 ${username}@${host}:${port}：${err.message}`));
      }
    };
    client.once('error', onConnectError);
    client.once('close', () => {
      // 连接意外断开且尚未就绪 → 视为连接失败
      if (!settled) {
        settled = true;
        reject(new Error(`SSH 连接被关闭 ${username}@${host}:${port}`));
      }
    });

    client.connect({
      host,
      port,
      username,
      password,
      privateKey,
      readyTimeout: timeoutMs,
    });

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
          },
        })
      );
    });
  });
}
