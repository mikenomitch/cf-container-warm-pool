import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WarmPool } from '../src/pool.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_INSTANCES_ERROR =
  'Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances';

/** In-memory mock of DurableObjectStorage */
function createMockStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (ts: number) => {
      alarm = ts;
    }),
    _data: data,
  };
}

/**
 * Builds a mock env.CONTAINER namespace.
 *
 * `containerBehavior.startAndWaitForPorts` controls start behavior for all stubs.
 * `containerBehavior.getState` is the default getState for all stubs.
 *
 * To override getState for specific containers (e.g. mark one as stopped),
 * use the returned `_stubs` map or `setContainerState` helper after creation.
 */
function createMockEnv(containerBehavior: {
  startAndWaitForPorts: () => Promise<void>;
  getState: () => Promise<{ status: string }>;
}) {
  const stubs = new Map<string, any>();

  const CONTAINER = {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn((id: { name: string }) => {
      if (!stubs.has(id.name)) {
        stubs.set(id.name, {
          startAndWaitForPorts: containerBehavior.startAndWaitForPorts,
          stop: vi.fn(async () => {}),
          renewActivityTimeout: vi.fn(),
          getState: containerBehavior.getState,
        });
      }
      return stubs.get(id.name)!;
    }),
  };

  /** Override getState for a specific container by its UUID */
  function setContainerState(uuid: string, status: string) {
    // Ensure stub exists
    CONTAINER.get(CONTAINER.idFromName(uuid));
    stubs.get(uuid)!.getState = vi.fn(async () => ({ status }));
  }

  return { CONTAINER, _stubs: stubs, setContainerState };
}

/** Create a WarmPool with mocked ctx and env, pre-configured and initialized */
async function createPool(opts: {
  warmTarget?: number;
  maxInstances?: number | null;
  warmContainers?: string[];
  assignments?: [string, string][];
  containerBehavior?: {
    startAndWaitForPorts: () => Promise<void>;
    getState: () => Promise<{ status: string }>;
  };
}) {
  const storage = createMockStorage();

  if (opts.warmContainers?.length) {
    storage._data.set('warmContainers', new Set(opts.warmContainers));
  }
  if (opts.assignments?.length) {
    storage._data.set('assignments', new Map(opts.assignments));
  }
  if (opts.maxInstances !== undefined && opts.maxInstances !== null) {
    storage._data.set('knownMaxInstances', opts.maxInstances);
  }

  const ctx = { storage, id: { toString: () => 'test-pool' } } as any;

  const behavior = opts.containerBehavior ?? {
    startAndWaitForPorts: vi.fn(async () => {}),
    getState: vi.fn(async () => ({ status: 'running' as const })),
  };

  const env = createMockEnv(behavior);

  const pool = new WarmPool(ctx, env as any);

  await pool.configure({
    warmTarget: opts.warmTarget ?? 5,
    refreshInterval: 60_000,
  });

  return { pool, storage, env, behavior };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WarmPool max_instances enforcement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── adjustPool clamping ──────────────────────────────────────────────────

  describe('adjustPool', () => {
    it('clamps container starts to remaining capacity', async () => {
      // warmTarget=5, maxInstances=3, 0 warm + 2 assigned = 1 slot available
      let startCount = 0;
      const { pool } = await createPool({
        warmTarget: 5,
        maxInstances: 3,
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => { startCount++; }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(startCount).toBe(1);
    });

    it('only fires one probe when completely at capacity', async () => {
      // warmTarget=5, maxInstances=3, 0 warm + 3 assigned = 0 slots
      // probe fires 1, probe fails => no containers started
      let startCount = 0;
      const { pool } = await createPool({
        warmTarget: 5,
        maxInstances: 3,
        assignments: [['user1', 'c1'], ['user2', 'c2'], ['user3', 'c3']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            startCount++;
            throw new Error(MAX_INSTANCES_ERROR);
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(startCount).toBe(1);
    });

    it('does not start containers when warm target already met', async () => {
      // warmTarget=5, 5 warm containers already exist — diff=0
      let startCount = 0;
      const { pool } = await createPool({
        warmTarget: 5,
        maxInstances: 5,
        warmContainers: ['w1', 'w2', 'w3', 'w4', 'w5'],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            startCount++;
            throw new Error(MAX_INSTANCES_ERROR);
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(startCount).toBe(0);
    });
  });

  // ── startContainer error detection ───────────────────────────────────────

  describe('startContainer / error detection', () => {
    it('records knownMaxInstances when max_instances error is thrown', async () => {
      // warmTarget=3, no known limit, 2 assigned — first start hits the error
      const { pool, storage } = await createPool({
        warmTarget: 3,
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            throw new Error(MAX_INSTANCES_ERROR);
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(storage._data.get('knownMaxInstances')).toBe(2);
    });

    it('does not record limit on non-capacity errors', async () => {
      const { pool, storage } = await createPool({
        warmTarget: 3,
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            throw new Error('Some other network error');
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(storage._data.has('knownMaxInstances')).toBe(false);
    });
  });

  // ── getContainer capacity check ──────────────────────────────────────────

  describe('getContainer', () => {
    it('throws when at capacity and no warm containers available', async () => {
      const { pool } = await createPool({
        warmTarget: 2,
        maxInstances: 2,
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {}),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await expect(pool.getContainer('user3')).rejects.toThrow(
        'Cannot start container: instance limit reached (2/2)'
      );
    });

    it('surfaces capacity error when limit is discovered during start', async () => {
      // No known limit yet, but startContainer hits the CF error
      const { pool } = await createPool({
        warmTarget: 0,
        assignments: [['user1', 'c1']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            throw new Error(MAX_INSTANCES_ERROR);
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await expect(pool.getContainer('user2')).rejects.toThrow(
        'instance limit reached'
      );
    });

    it('assigns warm container even when at capacity (no new start needed)', async () => {
      // Assigning a warm container just moves it from warm -> assigned,
      // so it works even when total = maxInstances
      const { pool } = await createPool({
        warmTarget: 2,
        maxInstances: 3,
        warmContainers: ['warm1'],
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {}),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      const result = await pool.getContainer('user3');
      expect(result).toBe('warm1');
    });

    it('starts a new container on-demand when below capacity', async () => {
      let started = false;
      const { pool } = await createPool({
        warmTarget: 2,
        maxInstances: 5,
        assignments: [['user1', 'c1']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => { started = true; }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      const result = await pool.getContainer('user2');
      expect(started).toBe(true);
      expect(typeof result).toBe('string');
    });

    it('recovers stale assignment and starts new container when at capacity', async () => {
      // maxInstances=2, user1->c1 (stopped), user2->c2 (running)
      // getContainer('user1') should remove stale c1, freeing a slot, then start a new one
      let started = false;
      const { pool, env } = await createPool({
        warmTarget: 0,
        maxInstances: 2,
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => { started = true; }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      // Mark c1 as stopped
      env.setContainerState('c1', 'stopped');

      const result = await pool.getContainer('user1');
      expect(started).toBe(true);
      expect(typeof result).toBe('string');
    });
  });

  // ── Probe mechanism ──────────────────────────────────────────────────────

  describe('probe mechanism', () => {
    it('clears cached limit when probe succeeds (limit increased)', async () => {
      // maxInstances=2, 2 assigned, warmTarget=3 => at limit
      // Starts succeed now (real limit is higher), so probe clears the cached limit
      let startCount = 0;
      const { pool, storage } = await createPool({
        warmTarget: 3,
        maxInstances: 2,
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => { startCount++; }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(storage._data.has('knownMaxInstances')).toBe(false);

      // 1 probe + 2 remaining (warmTarget=3, minus the 1 probe already added)
      expect(startCount).toBe(3);
    });

    it('preserves cached limit when probe fails', async () => {
      // maxInstances=2, 2 assigned, warmTarget=3 => at limit, probe fails
      const { pool, storage } = await createPool({
        warmTarget: 3,
        maxInstances: 2,
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            throw new Error(MAX_INSTANCES_ERROR);
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(storage._data.get('knownMaxInstances')).toBe(2);
    });
  });

  // ── capacityExhausted mid-loop ───────────────────────────────────────────

  describe('capacityExhausted mid-loop', () => {
    it('stops starting containers after hitting capacity error mid-loop', async () => {
      // warmTarget=5, no known limit — 3rd start hits max_instances
      let startCount = 0;
      const { pool } = await createPool({
        warmTarget: 5,
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            startCount++;
            if (startCount >= 3) {
              throw new Error(MAX_INSTANCES_ERROR);
            }
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      // 2 succeeded, 3rd failed, loop stopped
      expect(startCount).toBe(3);
    });
  });

  // ── Persistence ──────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('loads knownMaxInstances from storage on init', async () => {
      // Pre-seeded with maxInstances=5 and 5 assigned — should be at capacity
      const { pool } = await createPool({
        warmTarget: 2,
        maxInstances: 5,
        assignments: [
          ['u1', 'c1'], ['u2', 'c2'], ['u3', 'c3'],
          ['u4', 'c4'], ['u5', 'c5'],
        ],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {}),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await expect(pool.getContainer('u6')).rejects.toThrow(
        'instance limit reached'
      );
    });

    it('persists knownMaxInstances after learning it', async () => {
      const { pool, storage } = await createPool({
        warmTarget: 3,
        assignments: [['u1', 'c1']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            throw new Error(MAX_INSTANCES_ERROR);
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(storage.put).toHaveBeenCalledWith('knownMaxInstances', 1);
    });

    it('deletes knownMaxInstances from storage when cleared', async () => {
      // maxInstances=1, 1 assigned — probe succeeds so limit is cleared
      const { pool, storage } = await createPool({
        warmTarget: 2,
        maxInstances: 1,
        assignments: [['u1', 'c1']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {}),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(storage.delete).toHaveBeenCalledWith('knownMaxInstances');
    });
  });

  // ── Recovery paths ───────────────────────────────────────────────────────

  describe('recovery paths', () => {
    it('reportStopped() frees capacity for new containers', async () => {
      // maxInstances=2, 2 assigned, at capacity
      const { pool } = await createPool({
        warmTarget: 0,
        maxInstances: 2,
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {}),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      // At capacity — getContainer should fail
      await expect(pool.getContainer('user3')).rejects.toThrow('instance limit reached');

      // Report c1 stopped — frees a slot
      await pool.reportStopped('c1');

      // Now getContainer should succeed
      const result = await pool.getContainer('user3');
      expect(typeof result).toBe('string');
    });

    it('health check removes dead containers and adjustPool refills', async () => {
      // maxInstances=3, 1 warm + 2 assigned = at limit
      // One assigned container has stopped — health check should remove it,
      // then adjustPool should start replacements
      let startCount = 0;
      const { pool, env } = await createPool({
        warmTarget: 2,
        maxInstances: 3,
        warmContainers: ['w1'],
        assignments: [['user1', 'c1'], ['user2', 'c2']],
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => { startCount++; }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      // Mark c1 as stopped — health check should remove it
      env.setContainerState('c1', 'stopped');

      await pool.alarm();

      // Health check removed c1 (total 3→2), freeing 1 slot
      // adjustPool needs 1 more warm (warmTarget=2, warm=1), has 1 slot available
      expect(startCount).toBe(1);

      const stats = await pool.getStats();
      expect(stats.assigned).toBe(1); // c1 removed, c2 remains
      expect(stats.warm).toBe(2);     // w1 + 1 new
    });
  });

  // ── Multiple alarm cycles ────────────────────────────────────────────────

  describe('multiple alarm cycles', () => {
    it('learns limit on first cycle, respects it on second, detects increase on third', async () => {
      let totalStarted = 0;
      let realLimit = 2;

      const { pool } = await createPool({
        warmTarget: 3,
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => {
            totalStarted++;
            if (totalStarted > realLimit) {
              totalStarted--; // failed start doesn't count
              throw new Error(MAX_INSTANCES_ERROR);
            }
          }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      // Cycle 1: no limit known, starts 2 successfully, 3rd fails
      await pool.alarm();
      const stats1 = await pool.getStats();
      expect(stats1.warm).toBe(2);
      expect(stats1.maxInstances).toBe(2);

      // Cycle 2: at limit (2 warm, 0 assigned), warmTarget=3, probe fires and fails
      await pool.alarm();
      const stats2 = await pool.getStats();
      expect(stats2.warm).toBe(2); // unchanged
      expect(stats2.maxInstances).toBe(2); // limit preserved

      // Cycle 3: real limit raised to 5, probe succeeds, pool fills to warmTarget
      realLimit = 5;
      await pool.alarm();
      const stats3 = await pool.getStats();
      expect(stats3.warm).toBe(3); // warmTarget met
      expect(stats3.maxInstances).toBeNull(); // limit cleared
    });
  });

  // ── Backward compatibility (no limit known) ──────────────────────────────

  describe('backward compatibility (no limit known)', () => {
    it('starts all needed containers when no limit is known', async () => {
      let startCount = 0;
      const { pool } = await createPool({
        warmTarget: 5,
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => { startCount++; }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      await pool.alarm();

      expect(startCount).toBe(5);
    });

    it('getContainer starts a new container when no limit is known and no warm available', async () => {
      let started = false;
      const { pool } = await createPool({
        warmTarget: 0,
        containerBehavior: {
          startAndWaitForPorts: vi.fn(async () => { started = true; }),
          getState: vi.fn(async () => ({ status: 'running' })),
        },
      });

      const result = await pool.getContainer('user1');
      expect(started).toBe(true);
      expect(typeof result).toBe('string');
    });
  });

  // ── getStats ─────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('includes knownMaxInstances in stats', async () => {
      const { pool } = await createPool({
        warmTarget: 2,
        maxInstances: 10,
      });

      const stats = await pool.getStats();
      expect(stats.maxInstances).toBe(10);
    });

    it('returns null maxInstances when no limit known', async () => {
      const { pool } = await createPool({
        warmTarget: 2,
      });

      const stats = await pool.getStats();
      expect(stats.maxInstances).toBeNull();
    });
  });
});
