import { html } from "lit";

import type { TerminalSession } from "../ui-types.ts";
import { icons } from "../icons.ts";

export type TerminalProps = {
  connected: boolean;
  sessions: TerminalSession[];
  activeId: string | null;
  mouseMode: boolean;
  onCreateSession: () => void;
  onCloseSession: (id: string) => void;
  onSwitchSession: (id: string) => void;
  onMount: (id: string, container: HTMLElement) => void;
  onToggleMouseMode: () => void;
};

function handleTabClose(e: Event, props: TerminalProps, id: string) {
  e.stopPropagation();
  props.onCloseSession(id);
}

// Track which terminals have been mounted to avoid duplicate mounts
const mountedTerminals = new Set<string>();

function scheduleMount(props: TerminalProps, id: string) {
  if (mountedTerminals.has(id)) return;

  requestAnimationFrame(() => {
    const container = document.querySelector(`[data-terminal-id="${id}"]`) as HTMLElement | null;
    if (container) {
      mountedTerminals.add(id);
      props.onMount(id, container);
    }
  });
}

export function cleanupTerminalMount(id: string) {
  mountedTerminals.delete(id);
}

export function renderTerminal(props: TerminalProps) {
  const { sessions, activeId, connected, mouseMode } = props;

  // Schedule mount for active terminal after render
  if (activeId && connected) {
    scheduleMount(props, activeId);
  }

  return html`
    <section class="card terminal-card">
      <div class="terminal-header">
        <div class="terminal-tabs">
          ${sessions.map(
            (session) => html`
              <button
                class="terminal-tab ${session.id === activeId ? "terminal-tab--active" : ""}"
                @click=${() => props.onSwitchSession(session.id)}
              >
                <span class="terminal-tab__icon">${icons.terminal}</span>
                <span class="terminal-tab__title">${session.title}</span>
                <button
                  class="terminal-tab__close"
                  @click=${(e: Event) => handleTabClose(e, props, session.id)}
                  title="Close terminal"
                >
                  ${icons.x}
                </button>
              </button>
            `,
          )}
          <button
            class="terminal-tab terminal-tab--new"
            @click=${props.onCreateSession}
            ?disabled=${!connected}
            title="New terminal"
          >
            +
          </button>
        </div>
        <div class="terminal-toolbar">
          <button
            class="terminal-toggle ${mouseMode ? "terminal-toggle--active" : ""}"
            @click=${props.onToggleMouseMode}
            ?disabled=${!connected || sessions.length === 0}
            title="${mouseMode ? "Mouse mode ON (scroll works, hold Shift to select)" : "Mouse mode OFF (select works, scroll disabled)"}"
          >
            ${icons.mousePointer ?? icons.monitor}
            <span>${mouseMode ? "Scroll" : "Select"}</span>
          </button>
        </div>
      </div>

      <!-- Command hint banner -->
      <div class="terminal-hint">
        <div class="terminal-hint__icon">${icons.zap}</div>
        <div class="terminal-hint__content">
          <strong>提示:</strong> 在容器内使用 <code>openclaw</code> 命令。例如: <code>openclaw --help</code>
          <br>
          <strong>鼠标:</strong> ${mouseMode
            ? html`滚动已启用。按住 <code>Shift</code> 拖动可选择文本。`
            : html`选择已启用。点击 <code>滚动</code> 按钮启用滚动。`}
          <strong>复制/粘贴:</strong> <code>Ctrl+Shift+C</code> / <code>Ctrl+Shift+V</code>
        </div>
      </div>

      <div class="terminal-content">
        ${
          !connected
            ? html`
                <div class="terminal-placeholder">
                  <p>Connect to the gateway to use the terminal.</p>
                </div>
              `
            : sessions.length === 0
              ? html`<div class="terminal-placeholder">
                <p>No terminal sessions.</p>
                <button class="btn" @click=${props.onCreateSession}>New Terminal</button>
              </div>`
              : sessions.map(
                  (session) => html`
                  <div
                    class="terminal-pane ${session.id === activeId ? "terminal-pane--active" : ""}"
                    data-terminal-id=${session.id}
                  ></div>
                `,
                )
        }
      </div>
    </section>

    <style>
      .terminal-card {
        display: flex;
        flex-direction: column;
        height: calc(100vh - 200px);
        min-height: 400px;
      }
      .terminal-header {
        flex-shrink: 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--border);
      }
      .terminal-toolbar {
        padding: 8px;
      }
      .terminal-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.15s;
      }
      .terminal-toggle:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .terminal-toggle--active {
        background: #3b82f620;
        border-color: #3b82f6;
        color: #3b82f6;
      }
      .terminal-toggle:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .terminal-toggle svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
      }
      .terminal-hint {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 16px;
        background: #1e3a8a15;
        border-left: 3px solid #3b82f6;
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-primary);
      }
      .terminal-hint__icon {
        flex-shrink: 0;
        width: 16px;
        height: 16px;
        margin-top: 2px;
        color: #3b82f6;
      }
      .terminal-hint__icon svg {
        width: 100%;
        height: 100%;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
      }
      .terminal-hint__content {
        flex: 1;
      }
      .terminal-hint__content strong {
        color: #3b82f6;
        font-weight: 600;
      }
      .terminal-hint__content code {
        padding: 2px 6px;
        background: var(--bg-tertiary);
        border-radius: 3px;
        font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        color: #3b82f6;
        font-weight: 500;
      }
      .terminal-tabs {
        display: flex;
        gap: 2px;
        padding: 8px 8px 0;
        overflow-x: auto;
      }
      .terminal-tab {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        border: none;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border-radius: 6px 6px 0 0;
        cursor: pointer;
        font-size: 13px;
        transition: background 0.15s, color 0.15s;
      }
      .terminal-tab:hover {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      .terminal-tab--active {
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .terminal-tab__icon {
        display: flex;
        width: 14px;
        height: 14px;
      }
      .terminal-tab__icon svg {
        width: 100%;
        height: 100%;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
      }
      .terminal-tab__close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--text-tertiary);
        cursor: pointer;
        border-radius: 3px;
        opacity: 0.6;
        transition: opacity 0.15s, background 0.15s;
      }
      .terminal-tab__close:hover {
        opacity: 1;
        background: var(--bg-tertiary);
      }
      .terminal-tab__close svg {
        width: 12px;
        height: 12px;
        stroke: currentColor;
        stroke-width: 2;
        fill: none;
      }
      .terminal-tab--new {
        padding: 8px 14px;
        font-size: 16px;
        font-weight: 500;
      }
      .terminal-content {
        flex: 1;
        position: relative;
        background: #1a1a1a;
        border-radius: 0 0 8px 8px;
        overflow: hidden;
      }
      .terminal-placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: 16px;
        color: var(--text-secondary);
      }
      .terminal-pane {
        position: absolute;
        inset: 0;
        padding: 8px;
        display: none;
      }
      .terminal-pane--active {
        display: block;
      }
    </style>
  `;
}
