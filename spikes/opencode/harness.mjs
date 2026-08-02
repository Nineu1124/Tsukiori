import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import {
  eventSummary,
  parseServerUrl,
  sanitizeText,
  sha256,
  unwrap,
  waitFor,
} from './lib.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const privateResultDirectory = join(repositoryRoot, 'artifacts', 'private', 't0.1');
const publicFixtureDirectory = join(repositoryRoot, 'tests', 'fixtures', 'opencode', '1.18.4');
const progressPath = join(privateResultDirectory, 'progress.json');

async function recordStage(stage) {
  await mkdir(privateResultDirectory, { recursive: true });
  await writeFile(
    progressPath,
    JSON.stringify({ taskId: 'T0.1', stage, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  console.error('[T0.1] ' + stage);
}

function boundedFetch(request) {
  const signals = [AbortSignal.timeout(120_000)];
  if (request.signal) {
    signals.push(request.signal);
  }
  return fetch(new Request(request, { signal: AbortSignal.any(signals) }));
}

function parseArguments(argv) {
  const result = {
    model: 'opencode/deepseek-v4-flash-free',
    requireProvider: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--model') {
      result.model = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--require-provider') {
      result.requireProvider = argv[index + 1];
      index += 1;
    } else {
      throw new Error('Unknown argument: ' + argv[index]);
    }
  }
  const separator = result.model.indexOf('/');
  if (separator <= 0 || separator === result.model.length - 1) {
    throw new Error('--model must use provider/model format');
  }
  result.providerID = result.model.slice(0, separator);
  result.modelID = result.model.slice(separator + 1);
  return result;
}

function endpointHost(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function locateOpenCodeBinary() {
  if (process.env.OPENCODE_BIN) {
    const configured = resolve(process.env.OPENCODE_BIN);
    if (!existsSync(configured)) {
      throw new Error('OPENCODE_BIN does not exist');
    }
    return configured;
  }
  const wrappers = execFileSync('where.exe', ['opencode.cmd'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  if (wrappers.length === 0) {
    throw new Error('OpenCode is not installed');
  }
  const executable = join(dirname(wrappers[0]), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  if (!existsSync(executable)) {
    throw new Error('OpenCode native executable was not found beside the CLI wrapper');
  }
  return executable;
}

async function createFixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tsukiori-t01-'));
  const repository = join(temporaryRoot, 'repository');
  const worktree = join(temporaryRoot, 'worktree');
  await mkdir(repository);
  runGit(['init', '-b', 'main'], repository);
  runGit(['config', 'user.name', 'Tsukiori Spike'], repository);
  runGit(['config', 'user.email', 'spike@invalid.local'], repository);
  await writeFile(join(repository, 'README.md'), '# T0.1 isolated fixture\n', 'utf8');
  runGit(['add', 'README.md'], repository);
  runGit(['commit', '-m', 'fixture: initial commit'], repository);
  runGit(['worktree', 'add', '-b', 't0.1-worktree', worktree], repository);
  return { temporaryRoot, repository, worktree };
}

async function startServer(options) {
  const password = randomBytes(32).toString('base64url');
  const username = 'tsukiori-spike';
  const child = spawn(
    options.executable,
    ['serve', '--hostname=127.0.0.1', '--port=0', '--pure', '--log-level=WARN'],
    {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { external_directory: 'deny' },
        }),
      },
    },
  );

  let combined = '';
  const url = await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for OpenCode server startup'));
    }, 15_000);

    const consume = (chunk) => {
      combined += chunk.toString();
      for (const line of combined.split(/\r?\n/)) {
        const parsed = parseServerUrl(line);
        if (parsed) {
          clearTimeout(timeout);
          resolveUrl(parsed);
          return;
        }
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error('OpenCode exited during startup with code ' + code));
    });
  });

  const authorization =
    'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64');
  return {
    child,
    url,
    headers: { Authorization: authorization },
    output: () => combined,
    async stop(crash = false) {
      if (child.exitCode !== null) {
        return;
      }
      child.kill(crash ? 'SIGKILL' : 'SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
      ]);
    },
  };
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ' for ' + new URL(url).pathname);
  }
  return {
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

async function waitForPermission(client, directory, sessionID) {
  return waitFor(
    async () => {
      const pending = unwrap(
        await client.permission.list({ directory }),
        'permission.list',
      );
      return pending.find((request) => request.sessionID === sessionID) ?? null;
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  );
}

async function waitForSessionIdle(client, directory, sessionID) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  return waitFor(
    async () => {
      const statuses = unwrap(
        await client.session.status({ directory }),
        'session.status',
      );
      const status = statuses[sessionID];
      if (!status || status.type === 'idle') {
        return status ?? { type: 'idle' };
      }
      if (status.type === 'retry') {
        throw new Error('Session retry: ' + JSON.stringify(status));
      }
      return null;
    },
    { timeoutMs: 120_000, intervalMs: 500 },
  );
}

async function run() {
  const args = parseArguments(process.argv.slice(2));
  const executable = locateOpenCodeBinary();
  const fixture = await createFixture();
  let server;
  let restartedServer;
  let eventAbort;
  let subscription;
  let eventConsumer;
  let activeSessionID;
  const eventTypes = new Map();
  const startedAt = new Date().toISOString();

  try {
    server = await startServer({ executable, cwd: fixture.worktree });
    await recordStage('server-started');
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: fixture.worktree,
      headers: server.headers,
      throwOnError: false,
      fetch: boundedFetch,
    });

    const health = unwrap(await client.global.health(), 'global.health');
    const pathInfo = unwrap(await client.path.get({ directory: fixture.worktree }), 'path.get');
    const vcsInfo = unwrap(await client.vcs.get({ directory: fixture.worktree }), 'vcs.get');
    const providers = unwrap(
      await client.provider.list({ directory: fixture.worktree }),
      'provider.list',
    );
    const providerConfigs = unwrap(
      await client.config.providers({ directory: fixture.worktree }),
      'config.providers',
    );
    const selectedCatalogProvider = providers.all.find(
      (provider) => provider.id === args.providerID,
    );
    const selectedConfigProvider = providerConfigs.providers.find(
      (provider) => provider.id === args.providerID,
    );
    const selectedEndpoint = endpointHost(
      selectedCatalogProvider?.api ?? selectedConfigProvider?.options?.baseURL,
    );
    const credentialOptionNames = Object.keys(selectedConfigProvider?.options ?? {})
      .filter((name) => !/^setCacheKey$/i.test(name) && /key|token|auth|credential/i.test(name))
      .sort();
    const topLevelCredentialPresent =
      typeof selectedConfigProvider?.key === 'string' && selectedConfigProvider.key.length > 0;
    const optionCredentialPresent = credentialOptionNames.some((name) => {
      const value = selectedConfigProvider?.options?.[name];
      return typeof value === 'string' ? value.length > 0 : value != null;
    });
    const providerEvidence = {
      id: args.providerID,
      name: selectedCatalogProvider?.name ?? selectedConfigProvider?.name ?? null,
      source: selectedConfigProvider?.source ?? 'unknown',
      credentialPresent: topLevelCredentialPresent || optionCredentialPresent,
      credentialLocation: topLevelCredentialPresent
        ? 'provider.key'
        : credentialOptionNames.map((name) => 'provider.options.' + name).join(',') || 'runtime-managed',
      environmentVariableNames: selectedCatalogProvider?.env ?? selectedConfigProvider?.env ?? [],
      endpointHost: selectedEndpoint,
      modelListed: Boolean(selectedCatalogProvider?.models?.[args.modelID]),
    };
    if (
      args.requireProvider &&
      !providers.connected.some((provider) => provider.toLowerCase() === args.requireProvider.toLowerCase())
    ) {
      throw new Error('Required Provider is not connected: ' + args.requireProvider);
    }
    if (!providers.connected.includes(args.providerID)) {
      throw new Error('Model Provider is not connected: ' + args.providerID);
    }

    await recordStage('basic-probes-passed');
    const documentation = await fetchText(server.url + '/doc', server.headers);
    eventAbort = new AbortController();
    subscription = await client.event.subscribe(
      { directory: fixture.worktree },
      { signal: eventAbort.signal },
    );
    eventConsumer = (async () => {
      try {
        for await (const event of subscription.stream) {
          const summary = eventSummary(event);
          eventTypes.set(summary.type, (eventTypes.get(summary.type) ?? 0) + 1);
        }
      } catch (error) {
        if (!eventAbort.signal.aborted) {
          throw error;
        }
      }
    })();

    const permissionAsk = [
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'edit', pattern: '*', action: 'ask' },
    ];
    const session = unwrap(
      await client.session.create({
        directory: fixture.worktree,
        title: 'Tsukiori T0.1 protocol spike',
        model: {
          providerID: args.providerID,
          id: args.modelID,
        },
        permission: permissionAsk,
      }),
      'session.create',
    );
    activeSessionID = session.id;
    await recordStage('session-created');

    unwrap(
      await client.session.promptAsync({
        directory: fixture.worktree,
        sessionID: session.id,
        model: { providerID: args.providerID, modelID: args.modelID },
        parts: [
          {
            type: 'text',
            text: 'Reply with exactly TSUKIORI_SMOKE_OK. Do not use tools.',
          },
        ],
      }),
      'session.promptAsync(smoke)',
    );
    await waitForSessionIdle(client, fixture.worktree, session.id);
    await recordStage('smoke-turn-completed');

    unwrap(
      await client.session.promptAsync({
        directory: fixture.worktree,
        sessionID: session.id,
        model: { providerID: args.providerID, modelID: args.modelID },
        parts: [
          {
            type: 'text',
            text:
              'Use the bash tool exactly once to create permission-ok.txt in the current directory with the text ok. Do not use any external directory.',
          },
        ],
      }),
      'session.promptAsync(permission)',
    );
    await recordStage('waiting-for-permission');
    const permission = await waitForPermission(client, fixture.worktree, session.id);
    await recordStage('permission-observed');
    unwrap(
      await client.permission.reply({
        directory: fixture.worktree,
        requestID: permission.id,
        reply: 'once',
      }),
      'permission.reply',
    );
    await waitForSessionIdle(client, fixture.worktree, session.id);
    await recordStage('permission-flow-completed');
    const permissionFileCreated = existsSync(join(fixture.worktree, 'permission-ok.txt'));

    const permissionAllow = [
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
    ];
    unwrap(
      await client.session.update({
        directory: fixture.worktree,
        sessionID: session.id,
        permission: permissionAllow,
      }),
      'session.update',
    );
    unwrap(
      await client.session.promptAsync({
        directory: fixture.worktree,
        sessionID: session.id,
        model: { providerID: args.providerID, modelID: args.modelID },
        parts: [
          {
            type: 'text',
            text:
              'Use the bash tool to run a 20 second PowerShell sleep, then reply with SLEEP_FINISHED.',
          },
        ],
      }),
      'session.promptAsync(abort)',
    );
    await waitFor(
      async () => {
        const statuses = unwrap(
          await client.session.status({ directory: fixture.worktree }),
          'session.status(busy)',
        );
        return statuses[session.id]?.type === 'busy';
      },
      { timeoutMs: 60_000, intervalMs: 250 },
    );
    unwrap(
      await client.session.abort({
        directory: fixture.worktree,
        sessionID: session.id,
      }),
      'session.abort',
    );
    await recordStage('turn-interrupted');
    await waitForSessionIdle(client, fixture.worktree, session.id);

    unwrap(
      await client.session.promptAsync({
        directory: fixture.worktree,
        sessionID: session.id,
        model: { providerID: args.providerID, modelID: args.modelID },
        parts: [
          {
            type: 'text',
            text: 'Reply with exactly TSUKIORI_RESUME_OK. Do not use tools.',
          },
        ],
      }),
      'session.promptAsync(resume)',
    );
    await waitForSessionIdle(client, fixture.worktree, session.id);
    await recordStage('same-session-resumed');
    const messagesBeforeCrash = unwrap(
      await client.session.messages({
        directory: fixture.worktree,
        sessionID: session.id,
      }),
      'session.messages(before crash)',
    );

    await recordStage('closing-event-stream');
    eventAbort.abort();
    await subscription.stream.return();
    await Promise.race([
      eventConsumer,
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
    ]);
    eventAbort = null;
    subscription = null;
    eventConsumer = null;
    await recordStage('crashing-server');
    await server.stop(true);
    server = null;

    restartedServer = await startServer({ executable, cwd: fixture.worktree });
    const recoveredClient = createOpencodeClient({
      baseUrl: restartedServer.url,
      directory: fixture.worktree,
      headers: restartedServer.headers,
      throwOnError: false,
      fetch: boundedFetch,
    });
    await recordStage('server-restarted');
    const recoveredSession = unwrap(
      await recoveredClient.session.get({
        directory: fixture.worktree,
        sessionID: session.id,
      }),
      'session.get(recovered)',
    );
    const messagesAfterCrash = unwrap(
      await recoveredClient.session.messages({
        directory: fixture.worktree,
        sessionID: session.id,
      }),
      'session.messages(after crash)',
    );
    unwrap(
      await recoveredClient.session.delete({
        directory: fixture.worktree,
        sessionID: session.id,
      }),
      'session.delete',
    );
    activeSessionID = null;
    await recordStage('session-recovered-and-deleted');

    const evidence = {
      taskId: 'T0.1',
      startedAt,
      completedAt: new Date().toISOString(),
      runtime: {
        type: 'opencode',
        version: health.version,
        executableSha256: sha256(await readFile(executable)),
      },
      sdkVersion: '1.18.4',
      executionEnvironment: 'windows-native',
      model: {
        providerID: args.providerID,
        modelID: args.modelID,
        requiredProvider: args.requireProvider,
        connectedProviderIDs: providers.connected,
        evidence: providerEvidence,
      },
      checks: {
        health: health.healthy === true,
        worktreePathMatched:
          pathInfo.directory === fixture.worktree ||
          pathInfo.directory === fixture.worktree.replaceAll('\\', '/'),
        vcsDetected: Boolean(vcsInfo),
        documentationContentType: documentation.contentType,
        documentationSha256: sha256(documentation.body),
        sessionCreated: recoveredSession.id === session.id,
        permissionObserved: permission.permission,
        permissionPatternCount: permission.patterns.length,
        permissionFileCreated,
        abortAndResume: messagesBeforeCrash.length >= 2,
        crashRecovery:
          recoveredSession.id === session.id &&
          messagesAfterCrash.length >= messagesBeforeCrash.length,
      },
      eventTypeCounts: Object.fromEntries(
        [...eventTypes.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };

    const publicEvidence = structuredClone(evidence);
    publicEvidence.startedAt = '<timestamp>';
    publicEvidence.completedAt = '<timestamp>';
    await mkdir(privateResultDirectory, { recursive: true });
    await mkdir(publicFixtureDirectory, { recursive: true });
    await writeFile(
      join(privateResultDirectory, 'latest.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      'utf8',
    );
    await writeFile(
      join(publicFixtureDirectory, 'result.sanitized.json'),
      JSON.stringify(publicEvidence, null, 2) + '\n',
      'utf8',
    );
    await writeFile(
      join(publicFixtureDirectory, 'openapi-manifest.json'),
      JSON.stringify({
        runtimeVersion: health.version,
        contentType: documentation.contentType,
        sha256: evidence.checks.documentationSha256,
        bytes: Buffer.byteLength(documentation.body),
      }, null, 2) + '\n',
      'utf8',
    );
    await writeFile(
      join(publicFixtureDirectory, 'event-summary.json'),
      JSON.stringify({
        runtimeVersion: health.version,
        eventTypeCounts: evidence.eventTypeCounts,
        rawPayloadsCommitted: false,
      }, null, 2) + '\n',
      'utf8',
    );
    console.log(JSON.stringify(publicEvidence, null, 2));
  } catch (error) {
    const message = sanitizeText(error?.stack ?? error, fixture.temporaryRoot);
    console.error(message);
    process.exitCode = 1;
  } finally {
    if (eventAbort) {
      eventAbort.abort();
    }
    if (subscription) {
      try {
        await subscription.stream.return();
      } catch {
        // The server or request may already be gone.
      }
    }
    if (eventConsumer) {
      await Promise.race([
        eventConsumer.catch(() => undefined),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
      ]);
    }
    const cleanupServer = restartedServer ?? server;
    if (activeSessionID && cleanupServer) {
      const sessionUrl = new URL('/session/' + encodeURIComponent(activeSessionID), cleanupServer.url);
      sessionUrl.searchParams.set('directory', fixture.worktree);
      const abortUrl = new URL(sessionUrl);
      abortUrl.pathname += '/abort';
      try {
        await fetch(abortUrl, {
          method: 'POST',
          headers: cleanupServer.headers,
          signal: AbortSignal.timeout(5_000),
        });
        await fetch(sessionUrl, {
          method: 'DELETE',
          headers: cleanupServer.headers,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Cleanup is best effort after a failed protocol probe.
      }
    }
    if (server) {
      await server.stop();
    }
    if (restartedServer) {
      await restartedServer.stop();
    }
    const expectedPrefix = join(tmpdir(), 'tsukiori-t01-');
    if (!fixture.temporaryRoot.startsWith(expectedPrefix)) {
      throw new Error('Refusing to clean unexpected fixture path');
    }
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
}

await run();