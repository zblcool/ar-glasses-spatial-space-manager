import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HelperStatus, PoseSample } from '../shared/types';

export interface HelperOptions {
  binary: string;
  args: string[];
  onPose(pose: PoseSample): void;
  onStatus(status: HelperStatus): void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** A run longer than this resets the backoff. */
const STABLE_RUN_MS = 30_000;

/**
 * Supervises the native pose helper: spawns it, parses its JSON-lines stdout,
 * and restarts it with exponential backoff if it exits unexpectedly.
 */
export class HelperProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private startedAt = 0;
  private lastStderr = '';
  private status: HelperStatus = { state: 'stopped', mode: 'real', restarts: 0 };

  constructor(private readonly opts: HelperOptions) {}

  getStatus(): HelperStatus {
    return this.status;
  }

  start(): void {
    this.stopping = false;
    this.spawnChild();
  }

  /** Send a command line to the helper's stdin (e.g. "display3d 1"). */
  send(line: string): boolean {
    if (!this.child || this.child.exitCode !== null) return false;
    this.child.stdin.write(`${line}\n`);
    return true;
  }

  /** Stop and start again with new arguments (e.g. switching 3DoF ↔ 6DoF). */
  async restart(args: string[]): Promise<void> {
    await this.stop();
    this.opts.args = args;
    this.failures = 0;
    this.start();
  }

  /** SIGTERM the helper so it can stop/shutdown the SDK; SIGKILL after a grace period. */
  stop(graceMs = 2000): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.setStatus({ state: 'stopped' });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private setStatus(patch: Partial<HelperStatus>): void {
    this.status = { ...this.status, retryAt: undefined, ...patch };
    this.opts.onStatus(this.status);
  }

  private spawnChild(): void {
    this.setStatus({ state: 'starting', detail: undefined });
    this.startedAt = Date.now();
    this.lastStderr = '';

    const child = spawn(this.opts.binary, this.opts.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk);
      const lines = chunk.trim().split('\n');
      this.lastStderr = lines[lines.length - 1] ?? this.lastStderr;
    });

    child.on('error', (err) => {
      // Spawn failures (ENOENT, EACCES) arrive here; 'exit' may not follow.
      this.lastStderr = err.message;
      if (this.child === child && child.exitCode === null && child.pid === undefined) this.onExit(child, null, null);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping) {
      this.setStatus({ state: 'stopped' });
      return;
    }
    if (Date.now() - this.startedAt > STABLE_RUN_MS) this.failures = 0;
    this.failures++;
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (this.failures - 1));
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    this.setStatus({
      state: 'crashed',
      detail: `${why}${this.lastStderr ? ` — ${this.lastStderr}` : ''}`,
      restarts: this.status.restarts + 1,
    });
    this.status.retryAt = Date.now() + delay;
    this.opts.onStatus(this.status);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopping) this.spawnChild();
    }, delay);
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn('[helper] unparseable line:', line.slice(0, 200));
      return;
    }
    if (Array.isArray(msg.q) && typeof msg.t === 'number') {
      this.opts.onPose(msg as unknown as PoseSample);
      return;
    }
    if (typeof msg.status === 'string') {
      const s = msg.status;
      if (s === 'display') {
        this.setStatus({
          display: {
            mode: typeof msg.mode === 'number' ? msg.mode : null,
            is3d: msg.is3d === true,
            error: typeof msg.error === 'string' ? msg.error : undefined,
          },
        });
        return;
      }
      if (s === 'lost' || s === 'searching') this.status.display = undefined;
      if (s === 'searching' || s === 'tracking' || s === 'lost' || s === 'error') {
        this.setStatus({
          state: s,
          detail: typeof msg.message === 'string' ? msg.message : undefined,
          device: typeof msg.device === 'string' ? msg.device : this.status.device,
          dof: typeof msg.dof === 'number' ? msg.dof : this.status.dof,
          stable: typeof msg.stable === 'boolean' ? msg.stable : this.status.stable,
        });
      }
    }
  }
}
