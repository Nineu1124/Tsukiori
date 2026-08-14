import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const archivedHelper = resolve(currentDirectory, 'windows', 'credential-store.ps1');
const unpackedHelper = archivedHelper.replace(
  sep + 'app.asar' + sep,
  sep + 'app.asar.unpacked' + sep,
);
const helper = unpackedHelper !== archivedHelper && existsSync(unpackedHelper)
  ? unpackedHelper
  : archivedHelper;
const allowedEnvironmentVariables = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY',
  'TSUKIORI_PROVIDER_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'TSUKIORI_IPC_BOOTSTRAP_TOKEN',
  'TSUKIORI_RELEASE_SIGNING_KEY',
]);

export type SecretReference = `secretref:${string}`;
export type CredentialBinding = {
  runtimeType: string;
  runtimeProfileId: string;
  environmentVariable: string;
};
export type CredentialInvocation = {
  executable: string;
  args: readonly string[];
  cwd?: string;
  environmentKeys: readonly string[];
  shell: false;
};
export type CredentialSpawnResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type CredentialEnvelope = {
  schemaVersion: 1;
  reference: SecretReference;
  binding: CredentialBinding;
  secret: string;
};

export class WindowsCredentialBroker {
  readonly #powershell: string;

  constructor(options: { powershellExecutable?: string } = {}) {
    this.#powershell = options.powershellExecutable
      ?? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  store(input: { secret: string; binding: CredentialBinding; reference?: SecretReference }): SecretReference {
    this.#binding(input.binding);
    if (!input.secret || Buffer.byteLength(input.secret, 'utf8') > 1024 || /[\r\n\0]/.test(input.secret)) {
      throw new Error('Credential value is invalid');
    }
    const reference = input.reference ?? `secretref:${randomUUID()}`;
    this.#reference(reference);
    const envelope: CredentialEnvelope = {
      schemaVersion: 1,
      reference,
      binding: { ...input.binding },
      secret: input.secret,
    };
    this.#invoke('write', reference, JSON.stringify(envelope));
    return reference;
  }

  use<T>(reference: SecretReference, binding: CredentialBinding, consumer: (secret: string) => T): T {
    this.#binding(binding);
    this.#reference(reference);
    const result = this.#invoke('read', reference);
    const value = JSON.parse(Buffer.from(String(result.value), 'base64').toString('utf8')) as CredentialEnvelope;
    if (value.schemaVersion !== 1 || value.reference !== reference
      || value.binding.runtimeType !== binding.runtimeType
      || value.binding.runtimeProfileId !== binding.runtimeProfileId
      || value.binding.environmentVariable !== binding.environmentVariable
      || typeof value.secret !== 'string') {
      throw new Error('Credential binding mismatch');
    }
    return consumer(value.secret);
  }

  spawnWithSecret(input: {
    reference: SecretReference;
    binding: CredentialBinding;
    executable: string;
    args: readonly string[];
    cwd?: string;
    environment?: Readonly<Record<string, string>>;
    observeInvocation?: (invocation: CredentialInvocation) => void;
  }): CredentialSpawnResult {
    if (!input.executable.trim() || input.executable.includes('\0')
      || input.args.length > 128 || input.args.some((value) => value.includes('\0'))) {
      throw new Error('Credential process invocation is invalid');
    }
    return this.use(input.reference, input.binding, (secret) => {
      const environment = { ...process.env, ...input.environment };
      for (const name of allowedEnvironmentVariables) delete environment[name];
      environment[input.binding.environmentVariable] = secret;
      input.observeInvocation?.({
        executable: input.executable,
        args: [...input.args],
        ...(input.cwd ? { cwd: input.cwd } : {}),
        environmentKeys: Object.keys(input.environment ?? {})
          .filter((name) => !allowedEnvironmentVariables.has(name))
          .concat(input.binding.environmentVariable)
          .sort(),
        shell: false,
      });
      const result = spawnSync(input.executable, [...input.args], {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: environment,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.error) throw new Error('Credential process failed to start');
      return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    });
  }

  delete(reference: SecretReference): boolean {
    this.#reference(reference);
    return this.#invoke('delete', reference).deleted === true;
  }

  #invoke(operation: 'write' | 'read' | 'delete', reference: SecretReference, input?: string): Record<string, unknown> {
    const result = spawnSync(this.#powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
      '-Operation', operation, '-Target', this.#target(reference),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      input: input ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) throw new Error('Windows Credential Manager operation failed');
    const value = JSON.parse(result.stdout || '{}') as Record<string, unknown>;
    return value;
  }

  #target(reference: SecretReference): string {
    return 'Tsukiori/' + createHash('sha256').update(reference).digest('hex');
  }

  #reference(value: string): asserts value is SecretReference {
    if (!/^secretref:[a-f0-9-]{36}$/.test(value)) throw new Error('Secret Reference is invalid');
  }

  #binding(value: CredentialBinding): void {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(value.runtimeType)
      || !/^[A-Za-z0-9:._-]{1,128}$/.test(value.runtimeProfileId)
      || !allowedEnvironmentVariables.has(value.environmentVariable)) {
      throw new Error('Credential binding is invalid');
    }
  }
}
