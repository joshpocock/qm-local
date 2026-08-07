export interface ReloadableSlackConfig<Config> {
  version: string;
  config: Config;
}

/**
 * One Slack bot the process should be running: a stable `key` (the default installation, or a
 * registry record's installation id), the `version` that says whether its config changed, and
 * the config itself.
 */
export interface DesiredSlackInstance<Config> {
  key: string;
  version: string;
  config: Config;
  /**
   * Back off before retrying this key after a start failure, instead of hammering Slack every
   * tick. The default installation deliberately leaves this off so its behaviour is exactly
   * what it has always been; registry bots turn it on.
   */
  backoff?: boolean;
}

const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 300_000;

/**
 * The reconciler generalized to N concurrent bots. Per key it does exactly what
 * `createSlackRuntimeReconciler` does for its single instance — start, restart on a version
 * change, roll back to the previous config when a reload cannot start, stop when it disappears
 * — and a failure on one key never disturbs another. With a single key and no backoff it is
 * behaviourally identical to the single-instance reconciler.
 */
export function createSlackMultiRuntimeReconciler<Config>(opts: {
  load: () => Promise<Array<DesiredSlackInstance<Config>>>;
  startPlugin: (config: Config, key: string) => Promise<{ stop(): Promise<void> }>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  /** Called when a key's start threw, so the caller can surface it (e.g. store `lastError`). */
  onStartFailed?: (key: string, error: unknown) => void;
  /** Called after a key starts cleanly, so a previously stored error can be cleared. */
  onStarted?: (key: string) => void;
}) {
  type Active = { plugin: { stop(): Promise<void> }; version: string; config: Config };
  const active = new Map<string, Active>();
  const failures = new Map<string, { version: string; attempts: number; nextAttemptAt: number }>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const noteFailure = (key: string, version: string, backoff: boolean): void => {
    const prior = failures.get(key);
    const attempts = prior?.version === version ? prior.attempts + 1 : 1;
    const wait = backoff ? Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS) : 0;
    failures.set(key, { version, attempts, nextAttemptAt: Date.now() + wait });
  };

  const start = async (desired: DesiredSlackInstance<Config>): Promise<void> => {
    const plugin = await opts.startPlugin(desired.config, desired.key);
    active.set(desired.key, { plugin, version: desired.version, config: desired.config });
    failures.delete(desired.key);
    opts.onStarted?.(desired.key);
  };

  const reconcileOne = async (desired: DesiredSlackInstance<Config>): Promise<void> => {
    const current = active.get(desired.key);
    if (current?.version === desired.version) return;
    const held = failures.get(desired.key);
    if (held && held.version === desired.version && Date.now() < held.nextAttemptAt) return;
    const previous = current;
    if (previous) {
      // Mirrors the single-instance reconciler: a stop that throws leaves the old instance
      // registered so the next tick retries the stop before swapping credentials.
      await previous.plugin.stop();
      active.delete(desired.key);
    }
    try {
      await start(desired);
    } catch (error) {
      noteFailure(desired.key, desired.version, desired.backoff === true);
      opts.onStartFailed?.(desired.key, error);
      if (previous) {
        try {
          const plugin = await opts.startPlugin(previous.config, desired.key);
          active.set(desired.key, { plugin, version: previous.version, config: previous.config });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Slack reload and rollback both failed", {
            cause: rollbackError,
          });
        }
      }
      throw error;
    }
  };

  const reconcile = async (): Promise<void> => {
    const desired = await opts.load();
    const wanted = new Map(desired.map((d) => [d.key, d] as const));
    const errors: unknown[] = [];
    for (const [key, current] of [...active]) {
      if (wanted.has(key)) continue;
      try {
        await current.plugin.stop();
        active.delete(key);
        failures.delete(key);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const key of [...failures.keys()]) if (!wanted.has(key)) failures.delete(key);
    for (const one of desired) {
      try {
        await reconcileOne(one);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Slack reconciliation failed for several bots");
  };

  const run = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const tick = (): void => {
    void run().catch((error) => opts.onError?.(error));
  };

  return {
    start() {
      tick();
      timer = setInterval(tick, opts.intervalMs ?? 5_000);
      timer.unref();
    },
    reconcile: run,
    /** Keys currently running — for tests and diagnostics. */
    running(): string[] {
      return [...active.keys()];
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight?.catch(() => undefined);
      for (const [key, current] of [...active]) {
        await current.plugin.stop();
        active.delete(key);
      }
    },
  };
}

export function createSlackRuntimeReconciler<Config>(opts: {
  load: () => Promise<ReloadableSlackConfig<Config> | null>;
  startPlugin: (config: Config) => Promise<{ stop(): Promise<void> }>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  let active: { plugin: { stop(): Promise<void> }; version: string; config: Config } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const reconcile = async (): Promise<void> => {
    const desired = await opts.load();
    if (!desired) {
      if (active) {
        await active.plugin.stop();
        active = null;
      }
      return;
    }
    if (desired.version === active?.version) return;
    const previous = active;
    if (previous) {
      await previous.plugin.stop();
      active = null;
    }
    try {
      const plugin = await opts.startPlugin(desired.config);
      active = { plugin, version: desired.version, config: desired.config };
    } catch (error) {
      if (previous) {
        try {
          const plugin = await opts.startPlugin(previous.config);
          active = { plugin, version: previous.version, config: previous.config };
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Slack reload and rollback both failed", {
            cause: rollbackError,
          });
        }
      }
      throw error;
    }
  };

  const run = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const tick = (): void => {
    void run().catch((error) => opts.onError?.(error));
  };

  return {
    start() {
      tick();
      timer = setInterval(tick, opts.intervalMs ?? 5_000);
      timer.unref();
    },
    reconcile: run,
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
      if (active) {
        await active.plugin.stop();
        active = null;
      }
    },
  };
}
