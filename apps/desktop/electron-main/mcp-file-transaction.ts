import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomicSync } from './atomic-file.js';

export function writeMcpFiles(changes: ReadonlyMap<string, string>): void {
  const previous = new Map<string, string | undefined>();
  const written: string[] = [];
  try {
    for (const [path, content] of changes) {
      if (Buffer.byteLength(content) > 512 * 1024) throw new Error();
      previous.set(path, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
    }
    for (const [path, content] of changes) {
      if (previous.get(path) === content) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomicSync(path, content);
      written.push(path);
    }
  } catch {
    let restored = true;
    for (const path of written.reverse()) {
      try {
        const content = previous.get(path);
        if (content === undefined) unlinkSync(path);
        else writeFileAtomicSync(path, content);
      } catch { restored = false; }
    }
    throw new Error(restored ? 'MCP 保存失败，已恢复本次修改前的配置' : 'MCP 保存及回滚失败，请保留文件并检查磁盘和权限');
  }
}
