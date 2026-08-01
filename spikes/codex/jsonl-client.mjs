import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function resolveCodexLaunch() {
  const privateEntry = join(import.meta.dirname, "..", "..", "artifacts", "private", "t0.2", "runtime", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (existsSync(privateEntry)) return { command: process.execPath, args: [privateEntry] };
  const entry = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    : undefined;
  return entry && existsSync(entry)
    ? { command: process.execPath, args: [entry] }
    : { command: "codex", args: [] };
}

export class JsonlClient {
  constructor({ label, cwd, requestHandler, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    Object.assign(this, { label, cwd, requestHandler, timeoutMs });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = new Set();
    this.stderr = "";
    this.closed = false;
  }

  async start() {
    const launch = resolveCodexLaunch();
    this.child = spawn(launch.command, [...launch.args, "app-server", "--stdio"], {
      cwd: this.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-16384); });
    this.child.once("error", (error) => this.#failAll(error));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.#failAll(new Error(this.label + " exited code=" + code + " signal=" + signal));
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      .on("line", (line) => this.#onLine(line));
    const initialized = await this.request("initialize", {
      clientInfo: { name: "tsukiori_spike", title: "Tsukiori Protocol Spike", version: "0.0.0" },
      capabilities: { experimentalApi: false },
    });
    this.notify("initialized", {});
    return initialized;
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    const pending = deferred();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      pending.reject(new Error(this.label + " request timed out: " + method));
    }, timeoutMs);
    this.pending.set(id, { ...pending, timer, method });
    this.#write({ id, method, params });
    return pending.promise;
  }

  notify(method, params = {}) { this.#write({ method, params }); }

  waitFor(method, predicate = () => true, timeoutMs = this.timeoutMs) {
    const existing = this.notifications.find((e) => e.method === method && predicate(e.params));
    if (existing) return Promise.resolve(existing.params);
    const waiter = deferred();
    const entry = { method, predicate, ...waiter };
    entry.timer = setTimeout(() => {
      this.waiters.delete(entry);
      waiter.reject(new Error(this.label + " notification timed out: " + method));
    }, timeoutMs);
    this.waiters.add(entry);
    return waiter.promise;
  }

  async stop() {
    if (!this.child || this.closed) return;
    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const timer = setTimeout(() => this.child.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }

  #write(message) {
    if (!this.child || this.closed) throw new Error(this.label + " is not running");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async #onLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { this.#failAll(new Error(this.label + " emitted invalid JSONL")); return; }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(pending.method + ": " + message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      try {
        const result = await this.requestHandler?.(message.method, message.params, this);
        this.#write({ id: message.id, result: result ?? {} });
      } catch (error) {
        this.#write({ id: message.id, error: { code: -32000, message: error?.message ?? "rejected" } });
      }
      return;
    }
    if (message.method) {
      const event = { method: message.method, params: message.params ?? {} };
      this.notifications.push(event);
      for (const waiter of this.waiters) {
        if (waiter.method === event.method && waiter.predicate(event.params)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(event.params);
        }
      }
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }
}

export function sanitizeEvent(event, aliases = new Map()) {
  const idKeys = new Set(["threadId", "turnId", "itemId", "approvalId", "sessionId", "id"]);
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (idKeys.has(key)) {
        if (!aliases.has(value)) aliases.set(value, "<" + key + "-" + (aliases.size + 1) + ">");
        return aliases.get(value);
      }
      if (/cwd|path|command|text|message|preview|reason|url|host|policy|amendment/i.test(key)) return "<redacted>";
      return value.length > 80 ? "<redacted>" : value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    }
    return value;
  };
  return visit(event);
}
