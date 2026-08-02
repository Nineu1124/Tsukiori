import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10_000,
): Promise<number | null> {
  if (child.exitCode !== null) {
    return child.exitCode;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for child process exit'));
    }, timeoutMs);
    const onExit = (code: number | null) => {
      cleanup();
      resolve(code);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}
