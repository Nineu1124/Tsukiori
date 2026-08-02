import type { LocalDatabase } from '@tsukiori/database';
import type { JsonValue, OperationRecord, ProcessRecord } from '@tsukiori/domain';
import type { PermissionBroker } from '@tsukiori/permission-broker';
import { ProcessIdentityGuard, type ObservedProcessIdentity } from '@tsukiori/worktree-manager';

export type ProcessObservation =
  | { state: 'running'; identity: ObservedProcessIdentity }
  | { state: 'absent' }
  | { state: 'unobservable'; reason: string };

export type ProcessObserver = {
  observe(record: ProcessRecord): ProcessObservation;
};

export type WorktreeRecoveryResult = {
  operationId: string;
  action: 'create' | 'remove';
  status: 'committed' | 'failed' | 'uncertain';
  reason: string;
};

export type RecoveryOutcome = {
  target: 'process' | 'operation';
  id: string;
  status: string;
  reason: string;
  autoReplay: false;
};

export type RecoveryReport = {
  schemaVersion: 1;
  daemonBootId: string;
  startedAt: number;
  finishedAt: number;
  processResults: RecoveryOutcome[];
  operationResults: RecoveryOutcome[];
  autoReplayCount: 0;
};

export class RecoveryManager {
  readonly #database: LocalDatabase;
  readonly #observer: ProcessObserver;
  readonly #permissions: Pick<PermissionBroker, 'addAttention'> | undefined;
  readonly #recoverWorktrees: (() => WorktreeRecoveryResult[]) | undefined;
  readonly #now: () => number;
  readonly #daemonBootId: string;

  constructor(input: {
    database: LocalDatabase;
    processObserver: ProcessObserver;
    daemonBootId: string;
    permissions?: Pick<PermissionBroker, 'addAttention'>;
    recoverWorktrees?: () => WorktreeRecoveryResult[];
    now?: () => number;
  }) {
    if (!input.daemonBootId.trim()) throw new Error('Recovery requires a daemon boot identity');
    this.#database = input.database;
    this.#observer = input.processObserver;
    this.#permissions = input.permissions;
    this.#recoverWorktrees = input.recoverWorktrees;
    this.#now = input.now ?? Date.now;
    this.#daemonBootId = input.daemonBootId;
  }

  reconcile(): RecoveryReport {
    const startedAt = this.#now();
    const processResults = this.#reconcileProcesses();
    const operationResults = this.#reconcileOperations();
    return {
      schemaVersion: 1,
      daemonBootId: this.#daemonBootId,
      startedAt,
      finishedAt: this.#now(),
      processResults,
      operationResults,
      autoReplayCount: 0,
    };
  }

  #reconcileProcesses(): RecoveryOutcome[] {
    return this.#database.listProcesses(['starting', 'running', 'stopping']).map((record) => {
      const observation = this.#observer.observe(record);
      if (observation.state === 'running' && ProcessIdentityGuard.matches(record, observation.identity)) {
        return this.#outcome('process', record.id, 'running', 'full_process_identity_verified');
      }
      if (observation.state === 'absent') {
        this.#database.saveProcess({
          ...record,
          status: 'exited',
          exitedAt: this.#now(),
          signal: 'recovered_absent',
        });
        this.#interruptSession(record, 'interrupted_daemon');
        return this.#outcome('process', record.id, 'exited', 'recorded_process_is_absent');
      }
      const reason = observation.state === 'unobservable'
        ? 'process_identity_unobservable:' + this.#safeReason(observation.reason)
        : 'pid_reuse_or_process_identity_mismatch';
      this.#database.saveProcess({ ...record, status: 'orphaned' });
      this.#interruptSession(record, 'recovery_required');
      return this.#outcome('process', record.id, 'orphaned', reason);
    });
  }

  #reconcileOperations(): RecoveryOutcome[] {
    const pending = this.#database.listOperations(['prepared', 'running']);
    const recoveredWorktrees = new Map(
      (this.#recoverWorktrees?.() ?? []).map((result) => [result.operationId, result]),
    );
    const outcomes: RecoveryOutcome[] = [];
    for (const operation of pending) {
      const worktree = recoveredWorktrees.get(operation.operationId);
      if (worktree) {
        outcomes.push(this.#outcome('operation', operation.operationId, worktree.status, worktree.reason));
        if (worktree.status === 'uncertain') this.#attention(operation, worktree.reason);
        continue;
      }
      const classification = this.#classify(operation);
      const recovery: JsonValue = {
        schemaVersion: 1,
        reason: classification.reason,
        autoReplay: false,
        recoveredByDaemonBootId: this.#daemonBootId,
        recoveredAt: this.#now(),
      };
      this.#database.saveOperation({
        ...operation,
        status: classification.status,
        resultPayload: { recovery },
        ...(classification.status === 'failed'
          ? { error: { code: 'recovery_not_started' } }
          : { error: { code: 'recovery_manual_fact_check_required' } }),
        updatedAt: this.#now(),
      });
      if (classification.status === 'uncertain') this.#attention(operation, classification.reason);
      outcomes.push(this.#outcome(
        'operation', operation.operationId, classification.status, classification.reason,
      ));
    }
    return outcomes;
  }

  #classify(operation: OperationRecord): { status: 'failed' | 'uncertain'; reason: string } {
    if (operation.status === 'prepared') {
      return { status: 'failed', reason: 'prepared_without_external_attempt' };
    }
    switch (operation.type) {
      case 'git_review':
        return { status: 'failed', reason: 'read_only_review_interrupted' };
      case 'runtime_session_create':
        return { status: 'uncertain', reason: 'runtime_process_and_session_facts_require_review' };
      case 'worktree_create':
      case 'worktree_remove':
        return { status: 'uncertain', reason: 'worktree_fact_reconciler_unavailable' };
      case 'merge':
      case 'rebase':
        return { status: 'uncertain', reason: 'integration_worktree_retained_for_manual_continue' };
      case 'commit':
        return { status: 'uncertain', reason: 'git_head_requires_manual_commit_attribution' };
      case 'git_revert':
        return { status: 'uncertain', reason: 'recovery_snapshot_requires_manual_review' };
      case 'git_stage':
      case 'git_unstage':
        return { status: 'uncertain', reason: 'git_index_requires_manual_review' };
      case 'permission_response':
        return { status: 'uncertain', reason: 'permission_response_will_not_be_replayed' };
    }
  }

  #interruptSession(record: ProcessRecord, health: 'interrupted_daemon' | 'recovery_required'): void {
    if (record.runtimeHandleId) {
      const handle = this.#database.readRuntimeHandle(record.runtimeHandleId);
      if (handle && handle.state !== 'stopped' && handle.state !== 'exited' && handle.state !== 'failed') {
        this.#database.saveRuntimeHandle({
          ...handle,
          state: 'exited',
          expectedExit: false,
          exitedAt: this.#now(),
          updatedAt: this.#now(),
        });
      }
    }
    if (!record.sessionId) return;
    const session = this.#database.readSession(record.sessionId);
    if (!session || session.lifecycle !== 'active') return;
    this.#database.saveSession({
      ...session,
      activity: 'stopped',
      health,
      updatedAt: this.#now(),
    });
  }

  #attention(operation: OperationRecord, reason: string): void {
    if (!this.#permissions || !operation.sessionId) return;
    const session = this.#database.readSession(operation.sessionId);
    if (!session) return;
    this.#database.saveSession({
      ...session,
      activity: 'stopped',
      health: 'recovery_required',
      updatedAt: this.#now(),
    });
    this.#permissions.addAttention({
      projectId: session.projectId,
      sessionId: session.id,
      kind: 'recovery_uncertain',
      title: '操作在 Daemon 恢复后需要人工确认',
      sourceRef: 'recovery-operation:' + operation.operationId,
      risk: 'high',
      payload: {
        operationId: operation.operationId,
        operationType: operation.type,
        reason,
        autoReplay: false,
      },
      at: this.#now(),
    });
  }

  #outcome(
    target: RecoveryOutcome['target'], id: string, status: string, reason: string,
  ): RecoveryOutcome {
    return { target, id, status, reason, autoReplay: false };
  }

  #safeReason(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unknown';
  }
}
