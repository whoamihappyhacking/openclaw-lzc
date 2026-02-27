import { execSync } from "node:child_process";
import fs from "node:fs";
import nodePty from "@lydell/node-pty";
import type { WebSocket } from "ws";

const MAX_TERMINALS = 10;
const TMUX_SESSION_PREFIX = "clawdbot-term-";

type TerminalInstance = {
  id: string;
  pty: ReturnType<typeof nodePty.spawn>;
  ws: WebSocket;
  createdAt: number;
};

const terminals = new Map<string, TerminalInstance>();

// Check if tmux is available
let tmuxAvailable: boolean | null = null;
function isTmuxAvailable(): boolean {
  if (tmuxAvailable === null) {
    try {
      execSync("which tmux", { stdio: "ignore" });
      tmuxAvailable = true;
    } catch {
      tmuxAvailable = false;
    }
  }
  return tmuxAvailable;
}

// Check if a tmux session exists
function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// List existing tmux sessions with our prefix
export function listTmuxSessions(): string[] {
  if (!isTmuxAvailable()) {
    return [];
  }
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
      encoding: "utf-8",
    });
    return output
      .split("\n")
      .filter((s) => s.startsWith(TMUX_SESSION_PREFIX))
      .map((s) => s.replace(TMUX_SESSION_PREFIX, ""));
  } catch {
    return [];
  }
}

export function getTerminalCount(): number {
  return terminals.size;
}

export function hasTerminal(id: string): boolean {
  return terminals.has(id);
}

export function createTerminal(
  id: string,
  ws: WebSocket,
  opts: { cwd?: string; shell?: string } = {},
): { ok: true } | { ok: false; error: string } {
  if (terminals.size >= MAX_TERMINALS) {
    return { ok: false, error: `Maximum ${MAX_TERMINALS} terminals reached` };
  }

  if (terminals.has(id)) {
    return { ok: false, error: `Terminal ${id} already exists` };
  }

  const preferredCwd = opts.cwd || process.env.HOME || "/app";
  const cwd = fs.existsSync(preferredCwd) ? preferredCwd : process.cwd();
  const sessionName = `${TMUX_SESSION_PREFIX}${id}`;

  let term: ReturnType<typeof nodePty.spawn>;

  if (isTmuxAvailable()) {
    // Use tmux for persistent sessions
    const sessionExists = tmuxSessionExists(sessionName);

    if (sessionExists) {
      // Attach to existing tmux session
      term = nodePty.spawn("tmux", ["attach-session", "-t", sessionName], {
        name: "xterm-256color",
        cols: 80,
        rows: 30,
        cwd,
        env: process.env as Record<string, string>,
      });
    } else {
      // Create new tmux session
      term = nodePty.spawn("tmux", ["new-session", "-s", sessionName], {
        name: "xterm-256color",
        cols: 80,
        rows: 30,
        cwd,
        env: process.env as Record<string, string>,
      });
    }
  } else {
    // Fallback to regular shell if tmux not available
    const shell = opts.shell || process.env.SHELL || "/bin/bash";
    term = nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 30,
      cwd,
      env: process.env as Record<string, string>,
    });
  }

  const instance: TerminalInstance = {
    id,
    pty: term,
    ws,
    createdAt: Date.now(),
  };

  terminals.set(id, instance);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "data", id, data }));
    }
  });

  term.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", id, exitCode, signal }));
    }
    terminals.delete(id);
    // Note: tmux session persists even after PTY exit (detach)
  });

  return { ok: true };
}

export function writeToTerminal(id: string, data: string): boolean {
  const instance = terminals.get(id);
  if (!instance) {
    return false;
  }
  instance.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const instance = terminals.get(id);
  if (!instance) {
    return false;
  }
  instance.pty.resize(cols, rows);
  return true;
}

export function closeTerminal(id: string): boolean {
  const instance = terminals.get(id);
  if (!instance) {
    return false;
  }

  instance.pty.kill();
  terminals.delete(id);

  // Also kill the tmux session if it exists
  if (isTmuxAvailable()) {
    const sessionName = `${TMUX_SESSION_PREFIX}${id}`;
    try {
      execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // Session may not exist or already killed
    }
  }

  return true;
}

export function detachTerminalForSocket(ws: WebSocket): void {
  // When WebSocket disconnects, detach from tmux but don't kill the session
  for (const [id, instance] of terminals) {
    if (instance.ws === ws) {
      // Just kill the PTY (tmux attach process), tmux session stays alive
      instance.pty.kill();
      terminals.delete(id);
    }
  }
}

export function closeAllTerminalsForSocket(ws: WebSocket): void {
  // This now just detaches, doesn't destroy tmux sessions
  detachTerminalForSocket(ws);
}

export function listTerminals(): Array<{ id: string; createdAt: number }> {
  return Array.from(terminals.values()).map((t) => ({
    id: t.id,
    createdAt: t.createdAt,
  }));
}

// Get all persistent terminal IDs (both active and detached tmux sessions)
export function listPersistentTerminals(): string[] {
  if (!isTmuxAvailable()) {
    return Array.from(terminals.keys());
  }
  // Return tmux sessions that belong to clawdbot
  return listTmuxSessions();
}
