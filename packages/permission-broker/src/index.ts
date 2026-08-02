import { randomUUID } from 'node:crypto';
import type { LocalDatabase } from '@tsukiori/database';
import type {
  AttentionItemRecord,
  AttentionKind,
  EnforcementLevel,
  JsonValue,
  PermissionAuditRecord,
  PermissionCategory,
  PermissionDecision,
  PermissionDecisionScope,
  PermissionRisk,
  PermissionRuleRecord,
} from '@tsukiori/domain';

const categories = new Set<PermissionCategory>([
  'file_read', 'file_write', 'file_delete', 'shell', 'network', 'external_directory',
  'credential', 'mcp', 'git_push', 'process', 'clipboard', 'browser', 'other',
]);
const risks = new Set<PermissionRisk>(['low', 'medium', 'high', 'critical']);
const enforcementLevels = new Set<EnforcementLevel>([
  'runtime_sandbox', 'os_sandbox', 'interceptable', 'observable_only', 'opaque',
]);
const decisions = new Set<PermissionDecision>([
  'allow_once', 'allow_session', 'allow_project', 'deny_once', 'deny_session', 'cancel_turn',
]);
const attentionKinds = new Set<AttentionKind>([
  'waiting_permission', 'waiting_input', 'completed', 'failed', 'conflict', 'recovery_uncertain',
]);

export type PermissionRequestInput = {
  id: string;
  projectId: string;
  sessionId: string;
  turnId?: string;
  runtimeHandleId: string;
  runtimeRequestId: string;
  connectionEpoch: string;
  category: PermissionCategory;
  risk: PermissionRisk;
  enforcementLevel: EnforcementLevel;
  title: string;
  description: string;
  scope: string;
  availableDecisions: readonly PermissionDecision[];
  matcher?: JsonValue;
  requestedAt?: number;
};

export type PermissionCard = {
  id: string;
  projectId: string;
  sessionId: string;
  category: PermissionCategory;
  risk: PermissionRisk;
  enforcementLevel: EnforcementLevel;
  title: string;
  description: string;
  scope: string;
  availableDecisions: PermissionDecision[];
  status: string;
  connectionEpoch: string;
};

export type AttentionInput = {
  id?: string;
  projectId: string;
  sessionId: string;
  kind: AttentionKind;
  title: string;
  sourceRef: string;
  risk?: PermissionRisk;
  payload?: JsonValue;
  at?: number;
};

type RequestRow = {
  id: string; session_id: string; turn_id: string | null; runtime_handle_id: string;
  runtime_request_id: string; connection_epoch: string; category: PermissionCategory;
  risk: PermissionRisk; enforcement_level: EnforcementLevel; request_payload_json: string;
  status: string; decision: string | null; decision_scope: string | null;
  requested_at: number; resolved_at: number | null;
};

type RequestPayload = {
  projectId: string; title: string; description: string; scope: string;
  availableDecisions: PermissionDecision[]; matcher?: JsonValue;
};

export class PermissionBroker {
  readonly #database: LocalDatabase;
  readonly #now: () => number;
  readonly #id: () => string;

  constructor(database: LocalDatabase, options: { now?: () => number; id?: () => string } = {}) {
    this.#database = database;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
  }

  submit(input: PermissionRequestInput): PermissionCard {
    this.#validateRequest(input);
    const at = input.requestedAt ?? this.#now();
    const payload: RequestPayload = {
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      scope: input.scope,
      availableDecisions: [...input.availableDecisions],
      ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
    };
    this.#database.assertPersistenceSafe(payload);
    this.#database.sqlite.transaction(() => {
      this.#database.savePermissionRequest({
        id: input.id,
        sessionId: input.sessionId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        runtimeHandleId: input.runtimeHandleId,
        runtimeRequestId: input.runtimeRequestId,
        connectionEpoch: input.connectionEpoch,
        category: input.category,
        risk: input.risk,
        enforcementLevel: input.enforcementLevel,
        requestPayload: payload as unknown as JsonValue,
        status: 'pending',
        requestedAt: at,
      });
      this.#upsertAttention({
        id: 'attention:' + input.id,
        projectId: input.projectId,
        sessionId: input.sessionId,
        kind: 'waiting_permission',
        title: input.title,
        sourceRef: input.id,
        risk: input.risk,
        payload: { category: input.category, scope: input.scope, enforcementLevel: input.enforcementLevel },
        at,
      });
    })();
    return this.#card(this.#request(input.id));
  }

  decide(requestId: string, connectionEpoch: string, decision: PermissionDecision): PermissionAuditRecord {
    if (!decisions.has(decision)) throw new Error('Unsupported permission decision');
    const request = this.#request(requestId);
    if (request.status !== 'pending') throw new Error('Permission request is not pending');
    if (request.connection_epoch !== connectionEpoch) throw new Error('Stale permission connection epoch');
    const payload = this.#payload(request);
    if (!payload.availableDecisions.includes(decision)) throw new Error('Decision is unavailable for this request');
    const scope = this.#decisionScope(decision);
    const at = this.#now();
    const rule = this.#ruleFor(request, payload, decision, at);
    const audit: PermissionAuditRecord = {
      id: 'audit:' + this.#id(), requestId, sessionId: request.session_id,
      projectId: payload.projectId, connectionEpoch, category: request.category,
      risk: request.risk, enforcementLevel: request.enforcement_level,
      decision, decisionScope: scope, ...(rule ? { ruleId: rule.id } : {}), createdAt: at,
    };
    this.#database.assertPersistenceSafe(audit);
    this.#database.sqlite.transaction(() => {
      if (rule) this.#insertRule(rule);
      this.#insertAudit(audit);
      this.#database.sqlite.prepare(`
        UPDATE permission_requests SET status='resolved', decision=?, decision_scope=?, resolved_at=?
        WHERE id=? AND status='pending' AND connection_epoch=?
      `).run(decision, scope, at, requestId, connectionEpoch);
      this.#database.sqlite.prepare(`
        UPDATE attention_items SET status='resolved', updated_at=?, resolved_at=?
        WHERE kind='waiting_permission' AND source_ref=? AND status='open'
      `).run(at, at, requestId);
    })();
    return audit;
  }

  addAttention(input: AttentionInput): AttentionItemRecord {
    if (!attentionKinds.has(input.kind)) throw new Error('Unsupported attention kind');
    if (input.risk !== undefined && !risks.has(input.risk)) throw new Error('Unsupported risk');
    return this.#upsertAttention({ ...input, id: input.id ?? 'attention:' + this.#id() });
  }

  invalidateEpoch(runtimeHandleId: string, connectionEpoch: string, reason = 'runtime_reconnected'): number {
    this.#database.assertPersistenceSafe({ reason });
    const rows = this.#database.sqlite.prepare(`
      SELECT * FROM permission_requests
      WHERE runtime_handle_id=? AND connection_epoch=? AND status='pending'
    `).all(runtimeHandleId, connectionEpoch) as RequestRow[];
    const at = this.#now();
    this.#database.sqlite.transaction(() => {
      for (const request of rows) {
        const payload = this.#payload(request);
        this.#database.sqlite.prepare(`
          UPDATE permission_requests SET status='invalidated', resolved_at=? WHERE id=?
        `).run(at, request.id);
        this.#database.sqlite.prepare(`
          UPDATE attention_items SET status='resolved', updated_at=?, resolved_at=?
          WHERE kind='waiting_permission' AND source_ref=? AND status='open'
        `).run(at, at, request.id);
        this.#insertAudit({
          id: 'audit:' + this.#id(), requestId: request.id, sessionId: request.session_id,
          projectId: payload.projectId, connectionEpoch, category: request.category,
          risk: request.risk, enforcementLevel: request.enforcement_level,
          decision: 'invalidated', decisionScope: 'connection', reason, createdAt: at,
        });
        this.#upsertAttention({
          id: 'attention:recovery:' + request.id, projectId: payload.projectId,
          sessionId: request.session_id, kind: 'recovery_uncertain',
          title: '权限请求在 Runtime 重连后失效', sourceRef: 'recovery:' + request.id,
          risk: request.risk, payload: { requestId: request.id, reason }, at,
        });
      }
    })();
    return rows.length;
  }

  snapshot(): { permissions: PermissionCard[]; attention: AttentionItemRecord[]; audits: PermissionAuditRecord[]; rules: PermissionRuleRecord[] } {
    const permissions = (this.#database.sqlite.prepare(
      "SELECT * FROM permission_requests WHERE status='pending' ORDER BY requested_at",
    ).all() as RequestRow[]).map((row) => this.#card(row));
    const attention = (this.#database.sqlite.prepare(
      'SELECT * FROM attention_items ORDER BY status, updated_at DESC',
    ).all() as Record<string, unknown>[]).map((row) => this.#attention(row));
    const audits = (this.#database.sqlite.prepare(
      'SELECT * FROM permission_audit ORDER BY created_at, id',
    ).all() as Record<string, unknown>[]).map((row) => this.#audit(row));
    const rules = (this.#database.sqlite.prepare(
      'SELECT * FROM permission_rules ORDER BY created_at, id',
    ).all() as Record<string, unknown>[]).map((row) => this.#rule(row));
    return { permissions, attention, audits, rules };
  }

  #validateRequest(input: PermissionRequestInput): void {
    if (!categories.has(input.category)) throw new Error('Unsupported permission category');
    if (!risks.has(input.risk)) throw new Error('Unsupported permission risk');
    if (!enforcementLevels.has(input.enforcementLevel)) throw new Error('Unsupported enforcement level');
    if (input.availableDecisions.length === 0 || input.availableDecisions.some((item) => !decisions.has(item))) {
      throw new Error('Invalid available decisions');
    }
    this.#database.assertPersistenceSafe(input);
  }

  #request(id: string): RequestRow {
    const row = this.#database.sqlite.prepare('SELECT * FROM permission_requests WHERE id=?').get(id) as RequestRow | undefined;
    if (!row) throw new Error('Permission request not found');
    return row;
  }

  #payload(request: RequestRow): RequestPayload {
    return JSON.parse(request.request_payload_json) as RequestPayload;
  }

  #card(request: RequestRow): PermissionCard {
    const payload = this.#payload(request);
    return {
      id: request.id, projectId: payload.projectId, sessionId: request.session_id,
      category: request.category, risk: request.risk, enforcementLevel: request.enforcement_level,
      title: payload.title, description: payload.description, scope: payload.scope,
      availableDecisions: payload.availableDecisions, status: request.status,
      connectionEpoch: request.connection_epoch,
    };
  }

  #decisionScope(decision: PermissionDecision): PermissionDecisionScope {
    if (decision.endsWith('_session')) return 'session';
    if (decision === 'allow_project') return 'project';
    if (decision === 'cancel_turn') return 'turn';
    return 'once';
  }

  #ruleFor(request: RequestRow, payload: RequestPayload, decision: PermissionDecision, at: number): PermissionRuleRecord | null {
    if (decision !== 'allow_session' && decision !== 'allow_project' && decision !== 'deny_session') return null;
    if (decision === 'allow_project') {
      if (request.enforcement_level === 'observable_only' || request.enforcement_level === 'opaque') {
        throw new Error('Project allow requires enforceable permission');
      }
      if (!this.#isStructuredMatcher(payload.matcher)) {
        throw new Error('Project allow requires a structured matcher; raw shell rules are forbidden');
      }
    }
    const projectRule = decision === 'allow_project';
    return {
      id: 'rule:' + this.#id(), projectId: payload.projectId,
      ...(projectRule ? {} : { sessionId: request.session_id }), category: request.category,
      enforcementLevel: request.enforcement_level, matcher: payload.matcher ?? { requestId: request.id },
      decision: decision === 'deny_session' ? 'deny' : 'allow', sourceRequestId: request.id,
      enabled: true, createdAt: at, updatedAt: at,
    };
  }

  #isStructuredMatcher(value: JsonValue | undefined): boolean {
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    const matcher = value as Record<string, JsonValue>;
    if (typeof matcher.raw === 'string' || typeof matcher.command === 'string') return false;
    return typeof matcher.executable === 'string' || typeof matcher.pathPrefix === 'string'
      || typeof matcher.hostname === 'string' || typeof matcher.mcpServer === 'string';
  }

  #insertRule(rule: PermissionRuleRecord): void {
    this.#database.sqlite.prepare(`
      INSERT INTO permission_rules(id, project_id, session_id, category, enforcement_level,
        matcher_json, decision, source_request_id, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rule.id, rule.projectId, rule.sessionId ?? null, rule.category, rule.enforcementLevel,
      this.#database.serializeForPersistence(rule.matcher), rule.decision, rule.sourceRequestId,
      rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt);
  }

  #insertAudit(audit: PermissionAuditRecord): void {
    this.#database.assertPersistenceSafe(audit);
    this.#database.sqlite.prepare(`
      INSERT INTO permission_audit(id, request_id, session_id, project_id, connection_epoch,
        category, risk, enforcement_level, decision, decision_scope, rule_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(audit.id, audit.requestId, audit.sessionId, audit.projectId, audit.connectionEpoch,
      audit.category, audit.risk, audit.enforcementLevel, audit.decision, audit.decisionScope,
      audit.ruleId ?? null, audit.reason ?? null, audit.createdAt);
  }

  #upsertAttention(input: AttentionInput & { id: string }): AttentionItemRecord {
    const at = input.at ?? this.#now();
    const payload = input.payload ?? {};
    this.#database.assertPersistenceSafe({ ...input, payload });
    this.#database.sqlite.prepare(`
      INSERT INTO attention_items(id, session_id, project_id, kind, status, title, risk,
        source_ref, payload_json, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(kind, source_ref) DO UPDATE SET
        status='open', title=excluded.title, risk=excluded.risk,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at, resolved_at=NULL
    `).run(input.id, input.sessionId, input.projectId, input.kind, input.title, input.risk ?? null,
      input.sourceRef, this.#database.serializeForPersistence(payload), at, at);
    const row = this.#database.sqlite.prepare(
      'SELECT * FROM attention_items WHERE kind=? AND source_ref=?',
    ).get(input.kind, input.sourceRef) as Record<string, unknown>;
    return this.#attention(row);
  }

  #attention(row: Record<string, unknown>): AttentionItemRecord {
    return {
      id: String(row.id), sessionId: String(row.session_id), projectId: String(row.project_id),
      kind: String(row.kind) as AttentionKind, status: String(row.status) as 'open' | 'resolved',
      title: String(row.title), ...(row.risk === null ? {} : { risk: String(row.risk) as PermissionRisk }),
      sourceRef: String(row.source_ref), payload: JSON.parse(String(row.payload_json)) as JsonValue,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      ...(row.resolved_at === null ? {} : { resolvedAt: Number(row.resolved_at) }),
    };
  }

  #audit(row: Record<string, unknown>): PermissionAuditRecord {
    return {
      id: String(row.id), requestId: String(row.request_id), sessionId: String(row.session_id),
      projectId: String(row.project_id), connectionEpoch: String(row.connection_epoch),
      category: String(row.category) as PermissionCategory, risk: String(row.risk) as PermissionRisk,
      enforcementLevel: String(row.enforcement_level) as EnforcementLevel,
      decision: String(row.decision) as PermissionAuditRecord['decision'],
      decisionScope: String(row.decision_scope) as PermissionAuditRecord['decisionScope'],
      ...(row.rule_id === null ? {} : { ruleId: String(row.rule_id) }),
      ...(row.reason === null ? {} : { reason: String(row.reason) }), createdAt: Number(row.created_at),
    };
  }

  #rule(row: Record<string, unknown>): PermissionRuleRecord {
    return {
      id: String(row.id), projectId: String(row.project_id),
      ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
      category: String(row.category) as PermissionCategory,
      enforcementLevel: String(row.enforcement_level) as EnforcementLevel,
      matcher: JSON.parse(String(row.matcher_json)) as JsonValue,
      decision: String(row.decision) as 'allow' | 'deny', sourceRequestId: String(row.source_request_id),
      enabled: Boolean(row.enabled), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }
}