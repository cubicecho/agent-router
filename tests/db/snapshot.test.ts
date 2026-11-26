import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashKey } from '../../server/auth/keys.ts';
import { workspaces } from '../../server/db/schema.ts';
import { createSnapshotHost, loadSnapshot } from '../../server/db/snapshot.ts';
import { LOCAL_WORKER_NAME } from '../../server/db/tables/workers.ts';
import { workspaceAgentDisabledServers } from '../../server/db/tables/workspace-agent-disabled-servers.ts';
import { workspaceAgents } from '../../server/db/tables/workspace-agents.ts';
import { EMPTY_HOST_VIEW, type HostView } from '../../server/ports.ts';
import {
  closeTestDb,
  createAgent,
  createTestDb,
  createWorkerWithKey,
  createWorkspaceWithKey,
  resetTestDb,
  type TestDb,
} from '../helpers.ts';

let db: TestDb;

/** Reads a view with nothing in it. */
const emptyView = async (): Promise<HostView> => EMPTY_HOST_VIEW;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
});

describe('the snapshot', () => {
  it('holds workspaces by id and keys by hash', async () => {
    const { workspaceId, keyId, secret } = await createWorkspaceWithKey(db, 'min-agent');
    const snapshot = await loadSnapshot(db, emptyView);
    expect(snapshot.workspaces.get(workspaceId)).toEqual({
      id: workspaceId,
      slug: 'min-agent',
      name: 'min-agent',
      workerId: null,
    });
    expect(snapshot.keys.get(hashKey(secret))).toEqual({ keyId, workspaceId, expiresAt: null });
  });

  it('holds workers by id, local included, and worker keys by hash', async () => {
    const { workerId, secret } = await createWorkerWithKey(db, 'gpu-box');
    const snapshot = await loadSnapshot(db, emptyView);
    expect([...snapshot.workers.values()].map((worker) => worker.name).sort()).toEqual(['gpu-box', LOCAL_WORKER_NAME]);
    expect(snapshot.workers.get(workerId)).toEqual({ id: workerId, name: 'gpu-box' });
    expect([...snapshot.workerKeys]).toEqual([[hashKey(secret), { workerId }]]);
  });

  it('sees a write only once rebuilt', async () => {
    const host = await createSnapshotHost(db, emptyView);
    await db.insert(workspaces).values({ slug: 'later', name: 'later' });
    expect(host.current().workspaces.size).toBe(0);
    await host.rebuild();
    expect(host.current().workspaces.size).toBe(1);
  });

  it("gives an agent its workspace's servers from the host's view, less those turned off for it there", async () => {
    const { workspaceId } = await createWorkspaceWithKey(db, 'min-agent');
    const agent = await createAgent(db, { spec: 'cubicecho.agent/2', id: 'helper', model: { model: 'fake/m1' } });
    const [place] = await db.insert(workspaceAgents).values({ workspaceId, agentId: agent.id }).returning();
    const [alpha, beta, gone] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(workspaceAgentDisabledServers).values({ workspaceAgentId: place?.id ?? '', serverId: beta });
    const view: HostView = {
      ...EMPTY_HOST_VIEW,
      servers: new Map([
        ['alpha', { id: alpha, name: 'alpha', enabled: true }],
        ['beta', { id: beta, name: 'beta', enabled: true }],
      ]),
      workspaceServers: new Map([[workspaceId, [beta, alpha, gone]]]),
    };
    const snapshot = await loadSnapshot(db, async () => view);
    expect(snapshot.agents.get('helper')?.workspaces.get(workspaceId)).toEqual(['alpha']);
    expect(snapshot.servers).toBe(view.servers);
  });

  it('shares one read between calls waiting for it, and queues one more behind a read in progress', async () => {
    let reads = 0;
    let release: () => void = () => {};
    const host = await createSnapshotHost(db, async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return EMPTY_HOST_VIEW;
    });
    const first = host.rebuild();
    const shared = host.rebuild();
    expect(shared).toBe(first);
    // Let the first read start, then ask again while it waits.
    await new Promise((resolve) => setImmediate(resolve));
    const behind = host.rebuild();
    release();
    await Promise.all([first, behind]);
    expect(reads).toBe(3);
  });

  it("keeps the old snapshot when a read fails, the host's view included", async () => {
    let shouldFail = false;
    const host = await createSnapshotHost(db, async () => {
      if (shouldFail) {
        throw new Error('host down');
      }
      return EMPTY_HOST_VIEW;
    });
    const kept = host.current();
    shouldFail = true;
    await expect(host.rebuild()).rejects.toThrow('host down');
    expect(host.current()).toBe(kept);
    shouldFail = false;
    await expect(host.rebuild()).resolves.toBeUndefined();
  });
});
