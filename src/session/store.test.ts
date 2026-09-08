import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import {
  deleteSessionFiles,
  encodeWorkspaceDirectory,
  listWorkspaceSessions,
  NEW_SESSION_TITLE,
} from "./store.ts";

test("lists only this workspace's sessions, newest first", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
  await mkdir(sessionsDir, { recursive: true });

  const older = join(sessionsDir, "old.jsonl");
  const newer = join(sessionsDir, "new.jsonl");
  const wrongWorkspace = join(sessionsDir, "wrong.jsonl");
  const oldCreatedAt = "2026-01-01T00:00:00.000Z";
  const newCreatedAt = "2026-07-01T00:00:00.000Z";
  await writeFile(older, sessionHeader("old", workspace, oldCreatedAt));
  await writeFile(newer, sessionHeader("new", workspace, newCreatedAt));
  await writeFile(wrongWorkspace, sessionHeader("wrong", join(root, "elsewhere")));
  const now = Date.now() / 1000;
  await utimes(older, now - 2, now - 2);
  await utimes(newer, now, now);

  const sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.deepEqual(
    sessions.map((session) => session.id),
    ["new", "old"],
  );
  assert.equal(sessions[0].createdAtMs, Date.parse(newCreatedAt));
});

test("uses the latest session_info name and notices appended updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
  const sessionPath = join(sessionsDir, "named.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(sessionPath, sessionHeader("named", workspace));

  let sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.equal(sessions[0]?.title, NEW_SESSION_TITLE);

  await appendFile(
    sessionPath,
    `${JSON.stringify({ type: "session_info", name: "First name" })}\n`,
  );
  sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.equal(sessions[0]?.title, "First name");

  await appendFile(sessionPath, `${JSON.stringify({ type: "session_info", name: "Renamed" })}\n`);
  sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.equal(sessions[0]?.title, "Renamed");
});

test("uses the first user message when the session has no name, like /resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "unnamed.jsonl"),
    sessionHeader("unnamed", workspace) +
      userMessage("f5运行之后大概率闪退") +
      userMessage("第二条不应该当标题"),
  );

  const sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.equal(sessions[0]?.title, "f5运行之后大概率闪退");
});

test("prefers session_info name over the first user message", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "named.jsonl"),
    sessionHeader("named", workspace) +
      userMessage("first prompt") +
      `${JSON.stringify({ type: "session_info", name: "Refactor auth" })}\n`,
  );

  const sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.equal(sessions[0]?.title, "Refactor auth");
});

test("falls back to the first user message after session_info clears the name", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "cleared.jsonl"),
    sessionHeader("cleared", workspace) +
      userMessage("keep this title") +
      `${JSON.stringify({ type: "session_info", name: "Temporary" })}\n` +
      `${JSON.stringify({ type: "session_info", name: "" })}\n`,
  );

  const sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.equal(sessions[0]?.title, "keep this title");
});

test("reads first user message from text content blocks and collapses control characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "blocks.jsonl"),
    sessionHeader("blocks", workspace) +
      `${JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "line one\nline two" },
            { type: "image", url: "data:image/png;base64,xx" },
            { type: "text", text: "tail" },
          ],
        },
      })}\n`,
  );

  const sessions = await listWorkspaceSessions(workspace, { agentDir, env: {} });
  assert.equal(sessions[0]?.title, "line one line two tail");
});

test("finds sessions when the workspace is opened through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const workspaceLink = join(root, "project-link");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await symlink(workspace, workspaceLink, process.platform === "win32" ? "junction" : "dir");
  const realWorkspace = await realpath(workspace);
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(realWorkspace));
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "session.jsonl"), sessionHeader("linked", realWorkspace));

  const sessions = await listWorkspaceSessions(workspaceLink, { agentDir, env: {} });
  assert.deepEqual(
    sessions.map((session) => session.id),
    ["linked"],
  );
});

test("deleting a session removes its transcript and sidecar directory only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-vscode-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", encodeWorkspaceDirectory(workspace));
  const doomed = join(sessionsDir, "doomed.jsonl");
  await mkdir(join(sessionsDir, "doomed", "state"), { recursive: true });
  await writeFile(join(sessionsDir, "doomed", "state", "notes.json"), "{}");
  await writeFile(doomed, sessionHeader("doomed", workspace));
  await writeFile(join(sessionsDir, "keep.jsonl"), sessionHeader("keep", workspace));
  assert.equal((await listWorkspaceSessions(workspace, { agentDir, env: {} })).length, 2);

  await deleteSessionFiles(doomed);

  assert.deepEqual(
    (await listWorkspaceSessions(workspace, { agentDir, env: {} })).map((session) => session.id),
    ["keep"],
  );
  assert.equal(existsSync(join(sessionsDir, "doomed")), false);
  await deleteSessionFiles(doomed);
  await assert.rejects(deleteSessionFiles(sessionsDir), /Not a session transcript/);
  assert.equal(existsSync(sessionsDir), true);
});

function sessionHeader(id: string, cwd: string, timestamp?: string): string {
  return `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })}\n`;
}

function userMessage(content: string, id = "user-1"): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId: null,
    message: { role: "user", content },
  })}\n`;
}
