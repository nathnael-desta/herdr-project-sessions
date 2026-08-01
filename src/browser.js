#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const HOME = os.homedir();
const OPENCODE_DATA = process.env.OPENCODE_DATA_DIR || path.join(HOME, ".local", "share", "opencode");
const OPENCODE_DB = path.join(OPENCODE_DATA, "opencode.db");
const SESSION_ROOT = path.join(OPENCODE_DATA, "storage", "session");
const PROJECT_ROOT = path.join(OPENCODE_DATA, "storage", "project");
const MAX_SESSIONS = 500;
const STATE_ROOT = process.env.HERDR_PLUGIN_STATE_DIR || path.join(HOME, ".config", "herdr", "project-sessions-state");
const ARCHIVE_FILE = path.join(STATE_ROOT, "archive.json");

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function command(file, args, cwd = process.cwd()) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function herdr(args) {
  const output = command(HERDR, args);
  if (!output) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(output);
    return parsed.result ?? parsed;
  } catch {
    return undefined;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function loadArchive() {
  const state = readJson(ARCHIVE_FILE);
  return new Set(Array.isArray(state?.session_ids) ? state.session_ids : []);
}

function saveArchive(archived) {
  try {
    fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      ARCHIVE_FILE,
      `${JSON.stringify({ version: 1, session_ids: [...archived].sort(), updated_at: Date.now() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Archiving is a local UI preference; leave the current view usable if it cannot persist.
  }
}

function walkJsonFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function absolute(value) {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function gitInfo(directory, cache) {
  const normalized = absolute(directory);
  if (!normalized) {
    return undefined;
  }
  if (cache.has(normalized)) {
    return cache.get(normalized);
  }

  const root = command("git", ["-C", normalized, "rev-parse", "--show-toplevel"]);
  if (!root) {
    cache.set(normalized, undefined);
    return undefined;
  }

  const commonDirValue = command("git", ["-C", normalized, "rev-parse", "--git-common-dir"]);
  const commonDir = commonDirValue
    ? absolute(path.resolve(normalized, commonDirValue))
    : absolute(path.join(root, ".git"));
  const branch = command("git", ["-C", normalized, "branch", "--show-current"]) || "detached";
  const dirty = Boolean(command("git", ["-C", normalized, "status", "--porcelain"]));
  const info = {
    path: absolute(root),
    commonDir,
    repoRoot: commonDir ? path.dirname(commonDir) : absolute(root),
    branch,
    dirty,
  };
  cache.set(normalized, info);
  return info;
}

function parseWorktreePorcelain(text) {
  const worktrees = [];
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.branch = "detached";
    }
  }
  if (current) {
    worktrees.push(current);
  }
  return worktrees;
}

function currentHerdrDirectories() {
  const workspaces = herdr(["workspace", "list"])?.workspaces || [];
  const directories = [];
  for (const workspace of workspaces) {
    const panes = herdr(["pane", "list", "--workspace", workspace.workspace_id])?.panes || [];
    for (const pane of panes) {
      if (pane.cwd) {
        directories.push(pane.cwd);
      }
    }
  }
  return directories;
}

function liveAgents() {
  const agents = herdr(["agent", "list"])?.agents || [];
  return new Map(
    agents
      .filter((agent) => agent.agent_session?.value)
      .map((agent) => [agent.agent_session.value, agent]),
  );
}

function loadSessions() {
  const databaseRows = command(
    "sqlite3",
    [
      "-json",
      OPENCODE_DB,
      "SELECT id, title, directory, time_updated AS updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 500;",
    ],
  );
  if (databaseRows) {
    try {
      const rows = JSON.parse(databaseRows);
      if (Array.isArray(rows)) {
        return rows
          .filter((session) => session.id && session.directory)
          .map((session) => ({
            id: session.id,
            title: session.title || session.id,
            directory: absolute(session.directory),
            updated: Number(session.updated || 0),
            provider: "opencode",
          }));
      }
    } catch {
      // Fall through to the file-backed format used by older OpenCode versions.
    }
  }

  const projectById = new Map();
  for (const file of walkJsonFiles(PROJECT_ROOT)) {
    const project = readJson(file);
    if (project?.id) {
      projectById.set(project.id, project);
    }
  }

  const sessions = [];
  for (const file of walkJsonFiles(SESSION_ROOT)) {
    const session = readJson(file);
    if (!session?.id || session.parentID) {
      continue;
    }

    const project = projectById.get(session.projectID);
    const directory = absolute(session.directory || project?.worktree);
    if (!directory) {
      continue;
    }

    sessions.push({
      id: session.id,
      title: session.title || session.id,
      directory,
      updated: Number(session.time?.updated || session.time?.created || 0),
      provider: "opencode",
    });
  }

  return sessions.sort((left, right) => right.updated - left.updated).slice(0, MAX_SESSIONS);
}

function collectData() {
  const gitCache = new Map();
  const sessions = loadSessions();
  const agentBySession = liveAgents();
  const knownSessionIds = new Set(sessions.map((session) => session.id));
  const projectRoots = new Set(currentHerdrDirectories());
  for (const session of sessions) {
    projectRoots.add(session.directory);
  }

  const worktreeSources = new Map();
  for (const directory of projectRoots) {
    const info = gitInfo(directory, gitCache);
    if (!info?.repoRoot) {
      continue;
    }
    worktreeSources.set(info.repoRoot, info);
  }

  const projects = new Map();
  const addWorktree = (worktree, repoInfo, openWorkspaceId) => {
    const worktreePath = absolute(worktree.path);
    if (!worktreePath) {
      return undefined;
    }
    const info = gitInfo(worktreePath, gitCache) || repoInfo;
    const key = `${repoInfo.commonDir || repoInfo.repoRoot}:${worktreePath}`;
    let project = projects.get(key);
    if (!project) {
      project = {
        key,
        name: path.basename(repoInfo.repoRoot),
        path: worktreePath,
        branch: worktree.branch || info?.branch || "detached",
        dirty: info?.dirty || false,
        openWorkspaceId,
        sessions: [],
      };
      projects.set(key, project);
    } else if (openWorkspaceId) {
      project.openWorkspaceId = openWorkspaceId;
    }
    return project;
  };

  for (const [repoRoot, repoInfo] of worktreeSources) {
    const porcelain = command("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    const worktrees = parseWorktreePorcelain(porcelain);
    const listed = herdr(["worktree", "list", "--cwd", repoRoot, "--json"])?.worktrees || [];
    const openByPath = new Map(listed.map((item) => [absolute(item.path), item.open_workspace_id]));
    for (const worktree of worktrees) {
      addWorktree(worktree, repoInfo, openByPath.get(absolute(worktree.path)));
    }
  }

  for (const session of sessions) {
    const info = gitInfo(session.directory, gitCache);
    const repoInfo = info || {
      repoRoot: session.directory,
      commonDir: session.directory,
      branch: "non-git",
      dirty: false,
    };
    const project = addWorktree(
      { path: session.directory, branch: info?.branch || "non-git" },
      repoInfo,
      undefined,
    );
    if (!project) {
      continue;
    }
    const agent = agentBySession.get(session.id);
    project.sessions.push({
      ...session,
      agent: agent?.agent || "opencode",
      provider: agent?.agent || session.provider || "opencode",
      status: agent?.agent_status || "settled",
      paneId: agent?.pane_id,
    });
  }

  for (const agent of agentBySession.values()) {
    const sessionId = agent.agent_session?.value;
    if (!sessionId || knownSessionIds.has(sessionId)) {
      continue;
    }
    const directory = absolute(agent.foreground_cwd || agent.cwd);
    if (!directory) {
      continue;
    }
    const info = gitInfo(directory, gitCache);
    const repoInfo = info || {
      repoRoot: directory,
      commonDir: directory,
      branch: "non-git",
      dirty: false,
    };
    const project = addWorktree(
      { path: directory, branch: info?.branch || "non-git" },
      repoInfo,
      agent.workspace_id,
    );
    if (project) {
      project.sessions.push({
        id: sessionId,
        title: `${agent.agent || "agent"} session`,
        directory,
        updated: Date.now(),
        agent: agent.agent || "agent",
        provider: agent.agent || "agent",
        status: agent.agent_status || "unknown",
        paneId: agent.pane_id,
      });
    }
  }

  return [...projects.values()]
    .filter((project) => project.sessions.length > 0 || project.openWorkspaceId)
    .sort((left, right) => {
      const leftTime = left.sessions[0]?.updated || 0;
      const rightTime = right.sessions[0]?.updated || 0;
      return rightTime - leftTime || left.name.localeCompare(right.name);
    });
}

function formatAge(timestamp) {
  if (!timestamp) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function statusText(session) {
  if (session.status === "working") return "working";
  if (session.status === "blocked") return "blocked";
  if (session.status === "done") return "done";
  if (session.status === "idle") return "idle";
  return "settled";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function resumeCommand(session) {
  const id = shellQuote(session.id);
  switch (session.provider) {
    case "claude":
      return `claude --resume ${id}`;
    case "codex":
      return `codex resume ${id}`;
    case "pi":
      return `pi --session ${id}`;
    case "omp":
      return `omp --resume=${id}`;
    case "kimi":
      return `kimi --session ${id}`;
    case "copilot":
      return `copilot --resume=${id}`;
    case "droid":
      return `droid --resume ${id}`;
    case "qodercli":
      return `qodercli --resume ${id}`;
    case "cursor":
      return `cursor-agent --resume ${id}`;
    case "devin":
      return `devin --resume ${id}`;
    case "kilo":
      return `kilo --session ${id}`;
    case "hermes":
      return `hermes --resume ${id}`;
    case "mastracode":
      return `mastracode --thread ${id}`;
    case "opencode":
      return `opencode --session ${id}`;
    default:
      return undefined;
  }
}

function visibleProjects(projects, archived, archiveMode) {
  return projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => archived.has(session.id) === archiveMode),
    }))
    .filter((project) => project.sessions.length > 0 || (!archiveMode && project.openWorkspaceId));
}

function flatten(projects, collapsed, archived, archiveMode) {
  const rows = [];
  for (const project of visibleProjects(projects, archived, archiveMode)) {
    rows.push({ type: "project", project });
    if (!collapsed.has(project.key)) {
      for (const session of project.sessions) {
        rows.push({ type: "session", project, session });
      }
    }
  }
  return rows;
}

function safeText(value, width) {
  const text = String(value || "").replace(/[\r\n\t]/g, " ");
  if (text.length <= width) return text.padEnd(width, " ");
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function render(state) {
  const width = Math.max(40, process.stdout.columns || 100);
  const height = Math.max(8, process.stdout.rows || 30);
  const projects = visibleProjects(state.projects, state.archived, state.archiveMode);
  const rows = flatten(state.projects, state.collapsed, state.archived, state.archiveMode);
  const contentHeight = height - 5;
  const maxOffset = Math.max(0, rows.length - contentHeight);
  state.offset = Math.min(Math.max(state.offset, 0), maxOffset);
  if (state.selected >= rows.length) {
    state.selected = Math.max(0, rows.length - 1);
  }
  if (state.selected < state.offset) state.offset = state.selected;
  if (state.selected >= state.offset + contentHeight) state.offset = state.selected - contentHeight + 1;

  const output = [
    `${ansi.bold}${ansi.cyan}${state.archiveMode ? "Archived Sessions" : "Projects / Sessions"}${ansi.reset}`,
    `${ansi.dim}${projects.length} projects, ${projects.reduce((total, project) => total + project.sessions.length, 0)} sessions${ansi.reset}`,
    "",
  ];

  if (rows.length === 0) {
    output.push(`${ansi.dim}${state.archiveMode ? "No archived sessions." : "No sessions found."}${ansi.reset}`);
  }

  for (let index = state.offset; index < Math.min(rows.length, state.offset + contentHeight); index += 1) {
    const row = rows[index];
    const selected = index === state.selected;
    const marker = selected ? `${ansi.cyan}>${ansi.reset}` : " ";
    if (row.type === "project") {
      const collapsed = state.collapsed.has(row.project.key);
      const dirty = row.project.dirty ? `${ansi.yellow}*${ansi.reset}` : " ";
      const open = row.project.openWorkspaceId ? `${ansi.green}open${ansi.reset}` : `${ansi.dim}closed${ansi.reset}`;
      const label = `${collapsed ? ">" : "v"} ${row.project.name} / ${row.project.branch}`;
      output.push(`${marker} ${selected ? ansi.bold : ""}${safeText(label, Math.max(10, width - 18))}${ansi.reset} ${dirty} ${open}`);
    } else {
      const status = statusText(row.session);
      const color = status === "working" ? ansi.yellow : status === "blocked" ? ansi.red : ansi.dim;
      const label = `  ${row.session.title}`;
      output.push(`${marker} ${safeText(label, Math.max(10, width - 35))} ${color}${status}:${row.session.provider}${ansi.reset} ${ansi.dim}${formatAge(row.session.updated)}${ansi.reset}`);
    }
  }

  while (output.length < height - 1) output.push("");
  const archiveShortcut = state.archiveMode ? "u: unarchive" : "a: archive";
  const archiveViewShortcut = state.archiveMode ? "h: main" : "h: archives";
  output.push(`${ansi.dim}Shortcuts: j/k: move | space: collapse | enter: open | ${archiveShortcut} | ${archiveViewShortcut} | r: refresh | q: close${ansi.reset}`);
  process.stdout.write("\x1b[2J\x1b[H" + output.join("\n"));
}

function focusWorkspace(workspaceId) {
  if (workspaceId) {
    herdr(["workspace", "focus", workspaceId]);
  }
}

function openSession(row) {
  const { project, session } = row;
  const live = session.paneId;
  if (live) {
    herdr(["agent", "focus", live]);
    return;
  }

  let workspaceId = project.openWorkspaceId;
  let paneId;
  if (workspaceId) {
    const tab = herdr(["tab", "create", "--workspace", workspaceId, "--cwd", project.path, "--label", session.title, "--focus"]);
    paneId = tab?.root_pane?.pane_id;
  } else {
    const repoRoot = gitInfo(project.path, new Map())?.repoRoot;
    const worktree = repoRoot && project.path !== repoRoot
      ? herdr(["worktree", "open", "--cwd", repoRoot, "--path", project.path, "--label", project.name, "--focus"])
      : herdr(["workspace", "create", "--cwd", project.path, "--label", project.name, "--focus"]);
    workspaceId = worktree?.workspace?.workspace_id;
    paneId = worktree?.root_pane?.pane_id;
  }

  const commandToRun = resumeCommand(session);
  if (paneId && commandToRun) {
    herdr(["pane", "run", paneId, commandToRun]);
    return;
  }
  focusWorkspace(workspaceId);
}

function selectedRow(state) {
  return flatten(state.projects, state.collapsed, state.archived, state.archiveMode)[state.selected];
}

function openSelected(state, row) {
  if (state.archiveMode && row?.type === "session") {
    state.archived.delete(row.session.id);
    saveArchive(state.archived);
  }
  openSession(row);
}

function runDump() {
  process.stdout.write(`${JSON.stringify(collectData(), null, 2)}\n`);
}

function start() {
  const state = {
    projects: collectData(),
    collapsed: new Set(),
    archived: loadArchive(),
    archiveMode: false,
    selected: 0,
    offset: 0,
  };
  let input = "";

  const cleanup = () => {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  };

  const refresh = () => {
    state.projects = collectData();
    state.offset = 0;
    render(state);
  };

  const move = (delta) => {
    const rows = flatten(state.projects, state.collapsed, state.archived, state.archiveMode);
    state.selected = Math.min(Math.max(state.selected + delta, 0), Math.max(0, rows.length - 1));
    render(state);
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  render(state);

  process.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    while (input.length > 0) {
      if (input.startsWith("\x1b[A") || input.startsWith("\x1bOA")) {
        input = input.slice(3);
        move(-1);
      } else if (input.startsWith("\x1b[B") || input.startsWith("\x1bOB")) {
        input = input.slice(3);
        move(1);
      } else if (input.startsWith("\x1b[<")) {
        const match = input.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])/);
        if (!match) break;
        input = input.slice(match[0].length);
        const [button, , row] = match.slice(1).map(Number);
        if (button === 64) move(-1);
        else if (button === 65) move(1);
        else if (button === 0) {
          const index = state.offset + row - 4;
          const rows = flatten(state.projects, state.collapsed, state.archived, state.archiveMode);
          if (index >= 0 && index < rows.length) {
            state.selected = index;
            const selected = rows[index];
            if (selected.type === "project") {
              if (state.collapsed.has(selected.project.key)) state.collapsed.delete(selected.project.key);
              else state.collapsed.add(selected.project.key);
              render(state);
            } else {
              cleanup();
              openSelected(state, selected);
              process.exit(0);
            }
          }
        }
      } else {
        const byte = input.charCodeAt(0);
        input = input.slice(1);
        if (byte === 3 || byte === 27 || byte === 113) {
          cleanup();
          process.exit(0);
        } else if (byte === 106) move(1);
        else if (byte === 107) move(-1);
        else if (byte === 32) {
          const rows = flatten(state.projects, state.collapsed, state.archived, state.archiveMode);
          const selected = rows[state.selected];
          if (selected?.type === "project") {
            if (state.collapsed.has(selected.project.key)) state.collapsed.delete(selected.project.key);
            else state.collapsed.add(selected.project.key);
            render(state);
          }
        } else if (byte === 13) {
          const rows = flatten(state.projects, state.collapsed, state.archived, state.archiveMode);
          const selected = rows[state.selected];
          if (selected?.type === "project") {
            if (state.collapsed.has(selected.project.key)) state.collapsed.delete(selected.project.key);
            else state.collapsed.add(selected.project.key);
            render(state);
          } else if (selected) {
            cleanup();
            openSelected(state, selected);
            process.exit(0);
          }
        } else if (byte === 97) {
          const selected = selectedRow(state);
          if (!state.archiveMode && selected?.type === "session" && !selected.session.paneId) {
            state.archived.add(selected.session.id);
            saveArchive(state.archived);
            render(state);
          }
        } else if (byte === 104) {
          state.archiveMode = !state.archiveMode;
          state.selected = 0;
          state.offset = 0;
          render(state);
        } else if (byte === 117) {
          const selected = selectedRow(state);
          if (state.archiveMode && selected?.type === "session") {
            state.archived.delete(selected.session.id);
            saveArchive(state.archived);
            render(state);
          }
        } else if (byte === 114) refresh();
      }
    }
  });
}

if (process.argv.includes("--dump") || !process.stdin.isTTY) {
  runDump();
} else {
  start();
}
