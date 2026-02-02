import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ResolvedGatewayAuth } from "../auth.js";
import {
  createTerminal,
  writeToTerminal,
  resizeTerminal,
  closeTerminal,
  detachTerminalForSocket,
  listPersistentTerminals,
} from "./pty-manager.js";

export { listPersistentTerminals };

type TerminalWsMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" };

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function verifyAuth(auth: ResolvedGatewayAuth, token: string): boolean {
  if (auth.mode === "token" && auth.token) {
    return safeEqual(token, auth.token);
  }
  if (auth.mode === "password" && auth.password) {
    return safeEqual(token, auth.password);
  }
  return false;
}

export function createTerminalWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}

export function handleTerminalUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: {
    resolvedAuth: ResolvedGatewayAuth;
    defaultCwd?: string;
  },
): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname !== "/ws/terminal") {
    return false;
  }

  const token = url.searchParams.get("token");
  const terminalId = url.searchParams.get("id");

  if (!token || !terminalId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return true;
  }

  // Verify token
  if (!verifyAuth(opts.resolvedAuth, token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return true;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleTerminalConnection(ws, terminalId, {
      cwd: opts.defaultCwd,
    });
  });

  return true;
}

function handleTerminalConnection(ws: WebSocket, terminalId: string, opts: { cwd?: string }): void {
  const result = createTerminal(terminalId, ws, { cwd: opts.cwd ?? "/app" });

  if (!result.ok) {
    ws.send(JSON.stringify({ type: "error", error: result.error }));
    ws.close(1008, result.error);
    return;
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as TerminalWsMessage;

      switch (msg.type) {
        case "input":
          if (typeof msg.data === "string") {
            writeToTerminal(terminalId, msg.data);
          }
          break;
        case "resize":
          if (typeof msg.cols === "number" && typeof msg.rows === "number") {
            resizeTerminal(terminalId, msg.cols, msg.rows);
          }
          break;
        case "close":
          closeTerminal(terminalId);
          ws.close(1000, "Terminal closed");
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    // Detach from terminal but keep tmux session alive for reconnection
    detachTerminalForSocket(ws);
  });

  ws.on("error", () => {
    detachTerminalForSocket(ws);
  });
}
