import { createHash, randomUUID } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import mariadb from "mariadb";
import { PrismaClient } from "../../../generated/prisma/client.ts";

const revisionId = 1;
const heartbeatInterval = 30000;

function ownerFields(ownerId) {
  if (!ownerId) return { userId: null, guestHash: null };
  return ownerId.startsWith("guest:")
    ? { userId: null, guestHash: ownerId.slice(6) }
    : { userId: ownerId, guestHash: null };
}

function records(snapshot, previous) {
  const workspaces = new Map();
  const subjects = new Map();
  const analyses = new Map();
  const activeSpaces = new Map();
  const workspaceFor = (item, stored) => {
    const id =
      item.workspaceId ??
      stored?.workspaceId ??
      activeSpaces.get(item.ownerId) ??
      randomUUID();
    if (item.ownerId) activeSpaces.set(item.ownerId, id);
    const workspace = { id, ...ownerFields(item.ownerId) };
    const other = workspaces.get(id);
    if (
      other &&
      (other.userId !== workspace.userId ||
        other.guestHash !== workspace.guestHash)
    ) {
      throw new Error("Workspace has conflicting owners.");
    }
    workspaces.set(id, workspace);
    return id;
  };
  for (const {
    id,
    name,
    ownerId,
    workspaceId,
    ...payload
  } of snapshot.subjects ?? []) {
    const space = workspaceFor(
      { id, ownerId, workspaceId },
      previous.subjects.get(id),
    );
    subjects.set(id, { id, workspaceId: space, name, payload });
  }
  for (const {
    id,
    subjectId,
    filename,
    status,
    bytes,
    ownerId,
    workspaceId,
    ...payload
  } of snapshot.analyses ?? []) {
    const subject = subjectId ? subjects.get(subjectId) : null;
    if (subjectId && !subject)
      throw new Error("Analysis refers to a missing subject.");
    const space =
      subject?.workspaceId ??
      workspaceFor({ id, ownerId, workspaceId }, previous.analyses.get(id));
    const { userId, guestHash } = ownerFields(ownerId);
    const workspace = workspaces.get(space);
    if (workspace.userId !== userId || workspace.guestHash !== guestHash) {
      throw new Error("Analysis and subject have different owners.");
    }
    analyses.set(id, {
      id,
      workspaceId: space,
      subjectId: subjectId ?? null,
      filename,
      status,
      bytes: bytes ?? null,
      payload,
    });
  }
  return {
    users: new Map((snapshot.users ?? []).map((item) => [item.id, item])),
    sessions: new Map(
      (snapshot.sessions ?? []).map(([id, item]) => [id, { id, ...item }]),
    ),
    workspaces,
    subjects,
    analyses,
  };
}

async function removeMissing(model, before, after) {
  const removed = [...before.keys()].filter((id) => !after.has(id));
  if (removed.length)
    await model.deleteMany({ where: { id: { in: removed } } });
}

async function writeChanged(
  model,
  before,
  after,
  map = (row) => ({ create: row, update: row }),
) {
  for (const [id, row] of after) {
    const previous = before.get(id);
    if (previous && JSON.stringify(previous) === JSON.stringify(row)) continue;
    const { create, update } = map(row, previous);
    await model.upsert({ where: { id }, create, update });
  }
}

export async function connectMySql(connectionString) {
  const url = new URL(connectionString);
  if (url.protocol !== "mysql:" || !url.hostname || url.pathname.length < 2) {
    throw new Error(
      "DATABASE_URL must use mysql:// and include a database name.",
    );
  }
  const connection = {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectTimeout: 5000,
    timezone: "+00:00",
  };
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb({ ...connection, connectionLimit: 5 }),
  });
  let lock;
  let heartbeat;
  let failed = false;
  const unavailable = () =>
    Object.assign(
      new Error("MySQL workspace is unavailable. Restart the API."),
      { status: 503 },
    );
  const assertAvailable = () => {
    if (failed) throw unavailable();
  };
  const close = async () => {
    failed = true;
    clearInterval(heartbeat);
    await Promise.allSettled([lock?.end(), prisma.$disconnect()]);
  };
  try {
    lock = await mariadb.createConnection({
      ...connection,
      socketTimeout: 5000,
    });
    lock.on("error", () => {
      failed = true;
    });
    lock.on("end", () => {
      failed = true;
    });
    const [schema] = await lock.query("SELECT DATABASE() AS name");
    // GET_LOCK names are server-wide and capped at 64 characters.
    const lockName = createHash("sha256")
      .update("learnmap:" + schema.name.toLowerCase())
      .digest("hex");
    const [result] = await lock.query("SELECT GET_LOCK(?, 0) AS acquired", [
      lockName,
    ]);
    if (Number(result.acquired) !== 1) {
      throw new Error(
        "Another LearnMap API or import process already uses this database.",
      );
    }
    heartbeat = setInterval(() => {
      if (!failed)
        void lock.query({ sql: "SELECT 1", timeout: 5000 }).catch(() => {
          failed = true;
        });
    }, heartbeatInterval);
    heartbeat.unref();
    await prisma.storeRevision.upsert({
      where: { id: revisionId },
      create: { id: revisionId, version: 0 },
      update: {},
    });
  } catch (error) {
    await close();
    throw error;
  }

  let before;
  let version;
  async function load() {
    assertAvailable();
    const [users, sessions, workspaces, subjects, analyses, revision] =
      await prisma.$transaction(
        [
          prisma.user.findMany(),
          prisma.session.findMany(),
          prisma.workspace.findMany(),
          prisma.subject.findMany(),
          prisma.analysis.findMany(),
          prisma.storeRevision.findUniqueOrThrow({ where: { id: revisionId } }),
        ],
        { isolationLevel: "RepeatableRead" },
      );
    version = revision.version;
    const spaces = new Map(workspaces.map((item) => [item.id, item]));
    const owner = (id) => {
      const space = spaces.get(id);
      return (
        space.userId ??
        (space.guestHash ? "guest:" + space.guestHash : undefined)
      );
    };
    const snapshot = {
      users: users.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
      sessions: sessions.map(({ id, ...item }) => [
        id,
        { ...item, expiresAt: item.expiresAt.getTime() },
      ]),
      subjects: subjects.map(({ payload, ...item }) => ({
        ...payload,
        ...item,
        ownerId: owner(item.workspaceId),
      })),
      analyses: analyses.map(({ payload, original, ...item }) => ({
        ...payload,
        ...item,
        ownerId: owner(item.workspaceId),
        bytes: original ? Buffer.from(original).toString("base64") : undefined,
      })),
    };
    before = records(snapshot, { subjects: new Map(), analyses: new Map() });
    return snapshot;
  }

  async function save(snapshot) {
    assertAvailable();
    try {
      const next = records(snapshot, before);
      await prisma.$transaction(
        async (tx) => {
          const claimed = await tx.storeRevision.updateMany({
            where: { id: revisionId, version },
            data: { version: { increment: 1 } },
          });
          if (!claimed.count)
            throw new Error("Workspace changed outside this API process.");
          await writeChanged(tx.user, before.users, next.users);
          await writeChanged(
            tx.session,
            before.sessions,
            next.sessions,
            (row) => {
              const data = { ...row, expiresAt: new Date(row.expiresAt) };
              return { create: data, update: data };
            },
          );
          await writeChanged(tx.workspace, before.workspaces, next.workspaces);
          await removeMissing(tx.analysis, before.analyses, next.analyses);
          await removeMissing(tx.subject, before.subjects, next.subjects);
          await writeChanged(tx.subject, before.subjects, next.subjects);
          await writeChanged(
            tx.analysis,
            before.analyses,
            next.analyses,
            ({ bytes, ...row }, previous) => {
              const original =
                bytes === null ? null : Buffer.from(bytes, "base64");
              return {
                create: { ...row, original },
                update: bytes === previous?.bytes ? row : { ...row, original },
              };
            },
          );
          await removeMissing(tx.session, before.sessions, next.sessions);
          await removeMissing(tx.workspace, before.workspaces, next.workspaces);
          await removeMissing(tx.user, before.users, next.users);
          assertAvailable();
        },
        { timeout: 30000 },
      );
      before = next;
      version++;
    } catch (error) {
      failed = true;
      console.error("MySQL workspace write failed.", error.code ?? error.name);
      throw unavailable();
    }
  }
  return { load, save, assertAvailable, close };
}
