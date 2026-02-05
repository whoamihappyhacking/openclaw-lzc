import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalSession } from "../ui-types.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { OpenClawApp } from "../app.ts";
import { cleanupTerminalMount } from "../views/terminal.ts";

export type TerminalState = {
  terminalSessions: TerminalSession[];
  terminalActiveId: string | null;
  terminalMouseMode: boolean;
};

type TerminalInstance = {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket | null;
  disposed: boolean;
};

const instances = new Map<string, TerminalInstance>();
let sessionCounter = 0;

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/terminal`;
}

export function createTerminalSession(state: TerminalState): string {
  sessionCounter++;
  const id = `term-${Date.now()}-${sessionCounter}`;
  const session: TerminalSession = {
    id,
    title: `Terminal ${sessionCounter}`,
    createdAt: Date.now(),
  };
  state.terminalSessions = [...state.terminalSessions, session];
  state.terminalActiveId = id;
  return id;
}

// Restore terminal sessions from backend (persistent tmux sessions)
export async function restoreTerminalSessions(
  app: OpenClawApp,
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    const result = await client.request("terminal.list", {});
    const sessions = (result as { sessions?: string[] })?.sessions ?? [];
    if (sessions.length === 0) return;

    // Create session entries for each persistent terminal
    const restored: TerminalSession[] = sessions.map((id, index) => ({
      id,
      title: `Terminal ${index + 1}`,
      createdAt: Date.now(),
    }));

    app.terminalSessions = restored;
    app.terminalActiveId = restored[0]?.id ?? null;
    sessionCounter = sessions.length;
    app.requestUpdate();
  } catch {
    // Failed to restore sessions, start fresh
  }
}

export function closeTerminalSession(state: TerminalState, id: string): void {
  const instance = instances.get(id);
  if (instance) {
    // Send close message to kill the tmux session on the backend
    if (instance.ws && instance.ws.readyState === WebSocket.OPEN) {
      instance.ws.send(JSON.stringify({ type: "close" }));
    }
    instance.disposed = true;
    if (instance.ws && instance.ws.readyState === WebSocket.OPEN) {
      instance.ws.close();
    }
    instance.terminal.dispose();
    instances.delete(id);
  }
  cleanupTerminalMount(id);
  state.terminalSessions = state.terminalSessions.filter((s) => s.id !== id);
  if (state.terminalActiveId === id) {
    state.terminalActiveId = state.terminalSessions[0]?.id ?? null;
  }
}

export function switchTerminalSession(state: TerminalState, id: string): void {
  if (state.terminalSessions.some((s) => s.id === id)) {
    state.terminalActiveId = id;
  }
}

export function initTerminalInstance(
  id: string,
  container: HTMLElement,
  token: string,
): TerminalInstance | null {
  if (instances.has(id)) {
    const existing = instances.get(id)!;
    if (existing.terminal.element?.parentElement !== container) {
      container.appendChild(existing.terminal.element!);
      existing.fitAddon.fit();
    }
    return existing;
  }

  // Dynamic imports for xterm modules
  return null;
}

export async function mountTerminal(
  id: string,
  container: HTMLElement,
  token: string,
): Promise<void> {
  if (instances.has(id)) {
    const existing = instances.get(id)!;
    if (existing.terminal.element) {
      if (existing.terminal.element.parentElement !== container) {
        container.innerHTML = "";
        container.appendChild(existing.terminal.element);
      }
      existing.fitAddon.fit();
    }
    return;
  }

  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 14,
    fontWeight: "400",
    fontWeightBold: "600",
    lineHeight: 1.4,
    letterSpacing: 0,
    scrollback: 10000,
    rightClickSelectsWord: true,
    allowProposedApi: true,
    theme: {
      background: "#1a1a1a",
      foreground: "#e0e0e0",
      cursor: "#f0f0f0",
      selectionBackground: "#444444",
    },
  });

  // Attach selection manager to enable mouse selection
  terminal.attachCustomKeyEventHandler((event) => {
    // Allow Shift+Click for selection, Ctrl+Shift+C/V for copy/paste
    if (event.shiftKey && (event.type === "keydown" || event.type === "keyup")) {
      if (event.key === "C" && event.ctrlKey) {
        return false; // Let our handler deal with it
      }
      if (event.key === "V" && event.ctrlKey) {
        return false; // Let our handler deal with it
      }
    }
    return true;
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  container.innerHTML = "";
  terminal.open(container);
  fitAddon.fit();

  const instance: TerminalInstance = {
    id,
    terminal,
    fitAddon,
    ws: null,
    disposed: false,
  };
  instances.set(id, instance);

  const wsUrl = `${getWsUrl()}?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`;
  const ws = new WebSocket(wsUrl);
  instance.ws = ws;

  ws.onopen = () => {
    terminal.write("\x1b[32mConnected to terminal.\x1b[0m\r\n");
    const { cols, rows } = terminal;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  };

  ws.onmessage = (event) => {
    if (instance.disposed) return;
    try {
      const msg = JSON.parse(event.data as string) as { type: string; data?: string };
      if (msg.type === "data" && msg.data) {
        terminal.write(msg.data);
      } else if (msg.type === "exit") {
        terminal.write("\r\n\x1b[31mTerminal session ended.\x1b[0m\r\n");
      }
    } catch {
      // Treat as raw data
      terminal.write(event.data as string);
    }
  };

  ws.onerror = () => {
    terminal.write("\r\n\x1b[31mConnection error.\x1b[0m\r\n");
  };

  ws.onclose = () => {
    if (!instance.disposed) {
      terminal.write("\r\n\x1b[33mDisconnected.\x1b[0m\r\n");
    }
  };

  terminal.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  terminal.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });

  // Handle paste from clipboard
  container.addEventListener("paste", (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: text }));
    }
  });

  // Handle Ctrl+Shift+C for copy, Ctrl+Shift+V for paste
  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "C") {
      e.preventDefault();
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          // Fallback: use execCommand
          const textarea = document.createElement("textarea");
          textarea.value = selection;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
        });
      }
    }
    if (e.ctrlKey && e.shiftKey && e.key === "V") {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: text }));
        }
      }).catch(() => {
        // Clipboard read failed
      });
    }
  });

  // Also try automatic copy on selection (works in HTTPS)
  terminal.onSelectionChange(() => {
    const selection = terminal.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => {
        // Clipboard API not available, user can use Ctrl+Shift+C
      });
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!instance.disposed) {
      fitAddon.fit();
    }
  });
  resizeObserver.observe(container);
}

export function resizeTerminal(id: string): void {
  const instance = instances.get(id);
  if (instance && !instance.disposed) {
    instance.fitAddon.fit();
  }
}

export function getTerminalInstance(id: string): TerminalInstance | undefined {
  return instances.get(id);
}

export function disposeAllTerminals(state: TerminalState): void {
  for (const [id] of instances) {
    closeTerminalSession(state, id);
  }
}

// Toggle tmux mouse mode for scrolling vs selecting
export function toggleTerminalMouseMode(state: TerminalState): void {
  const newMode = !state.terminalMouseMode;
  state.terminalMouseMode = newMode;

  // Send mouse mode command to all active terminals
  for (const [, instance] of instances) {
    if (instance.ws && instance.ws.readyState === WebSocket.OPEN) {
      // Send tmux command to toggle mouse mode
      const cmd = newMode ? "set -g mouse on" : "set -g mouse off";
      instance.ws.send(JSON.stringify({ type: "input", data: `tmux ${cmd}\r` }));
    }
  }
}
