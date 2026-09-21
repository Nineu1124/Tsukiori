import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export function writeFileAtomicSync(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // 同目录替换；替换失败时不能先删除原文件。
    renameSync(temporary, path);
    created = false;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* 保留原始保存错误。 */ }
    }
    if (created) {
      try { unlinkSync(temporary); } catch { /* 清理失败不影响原文件，也不覆盖保存错误。 */ }
    }
  }
}
