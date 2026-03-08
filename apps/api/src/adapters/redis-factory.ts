/**
 * TASK-HARD-013: Redis client factory for Moltbook snapshot caching.
 *
 * Creates a minimal Redis client using Node.js net + resp protocol.
 * For production, replace with ioredis. This lightweight implementation
 * avoids adding a heavy dependency while supporting the cache layer.
 *
 * When REDIS_URL is unset → returns null (graceful degradation).
 */

import type { RedisClient } from './moltbook-cache.js';

/**
 * Minimal Redis client using native Node.js.
 * Supports GET, SET (with EX/NX), DEL, and QUIT.
 */
class MinimalRedisClient implements RedisClient {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async get(key: string): Promise<string | null> {
    return this.command('GET', key) as Promise<string | null>;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> {
    return this.command('SET', key, value, ...args.map(String));
  }

  async del(...keys: string[]): Promise<number> {
    return this.command('DEL', ...keys) as Promise<number>;
  }

  async quit(): Promise<unknown> {
    return Promise.resolve('OK');
  }

  private async command(cmd: string, ...args: string[]): Promise<unknown> {
    const parsed = new URL(this.url);
    const host = parsed.hostname || 'localhost';
    const port = parseInt(parsed.port || '6379', 10);
    const password = parsed.password ? decodeURIComponent(parsed.password) : null;

    const { createConnection } = await import('node:net');

    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port }, () => {
        const commands: string[] = [];

        // AUTH if password provided
        if (password) {
          commands.push(this.encodeResp('AUTH', password));
        }

        commands.push(this.encodeResp(cmd, ...args));
        socket.write(commands.join(''));
      });

      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();

        // Simple RESP parser — handle the last response
        const lines = data.split('\r\n');
        // Check if we have a complete response
        if (data.endsWith('\r\n')) {
          const lastRelevantLine = password ? this.getLastResponse(lines) : lines[0];

          if (lastRelevantLine?.startsWith('+')) {
            socket.end();
            resolve(lastRelevantLine.slice(1));
          } else if (lastRelevantLine?.startsWith('-')) {
            socket.end();
            reject(new Error(lastRelevantLine.slice(1)));
          } else if (lastRelevantLine?.startsWith(':')) {
            socket.end();
            resolve(parseInt(lastRelevantLine.slice(1), 10));
          } else if (lastRelevantLine?.startsWith('$-1')) {
            socket.end();
            resolve(null);
          } else if (lastRelevantLine?.startsWith('$')) {
            const len = parseInt(lastRelevantLine.slice(1), 10);
            // Find the bulk string value
            const idx = data.lastIndexOf(lastRelevantLine);
            const afterLen = data.slice(idx + lastRelevantLine.length + 2); // skip \r\n
            if (afterLen.length >= len) {
              socket.end();
              resolve(afterLen.slice(0, len));
            }
            // else wait for more data
          }
        }
      });

      socket.on('error', (err) => reject(err));
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('Redis connection timed out'));
      });
    });
  }

  private getLastResponse(lines: string[]): string | undefined {
    // Skip AUTH response, get the actual command response
    const nonEmpty = lines.filter((l) => l.length > 0);
    // If AUTH was sent, skip the first response line (+OK for AUTH)
    return nonEmpty.length > 1 ? nonEmpty[nonEmpty.length - 1] : nonEmpty[0];
  }

  private encodeResp(...parts: string[]): string {
    let resp = `*${parts.length}\r\n`;
    for (const part of parts) {
      resp += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
    }
    return resp;
  }
}

/**
 * Create a Redis client from REDIS_URL environment variable.
 * Returns null if REDIS_URL is not set.
 */
export function createRedisFromEnv(): RedisClient | null {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  return new MinimalRedisClient(redisUrl);
}
