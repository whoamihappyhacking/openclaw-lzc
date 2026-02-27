import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { rawDataToString } from "../../infra/ws.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { authorizeWsControlUiGatewayConnect, isLocalDirectRequest } from "../auth.js";
import { resolveClientIp } from "../net.js";
import { checkBrowserOrigin } from "../origin-check.js";
import type { GatewayWsClient } from "../server/ws-types.js";
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
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return typeof value === "string" ? value : undefined;
}

function hasAuthorizedWsClientForIp(clients: Set<GatewayWsClient>, clientIp: string): boolean {
  for (const client of clients) {
    if (client.clientIp && client.clientIp === clientIp) {
      return true;
    }
  }
  return false;
}

function extractClientAuthToken(client: GatewayWsClient): string | undefined {
  const auth = client.connect?.auth;
  if (!auth || typeof auth !== "object") {
    return undefined;
  }

  const token =
    typeof auth.token === "string" && auth.token.trim().length > 0
      ? auth.token.trim()
      : typeof auth.deviceToken === "string" && auth.deviceToken.trim().length > 0
        ? auth.deviceToken.trim()
        : undefined;
  return token;
}

function hasAuthorizedWsClientForToken(params: {
  req: IncomingMessage;
  token: string;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<GatewayWsClient>;
}): boolean {
  const { req, token, trustedProxies, allowRealIpFallback, clients } = params;
  if (isLocalDirectRequest(req, trustedProxies, allowRealIpFallback)) {
    for (const client of clients) {
      const clientToken = extractClientAuthToken(client);
      if (clientToken && safeEqual(clientToken, token)) {
        return true;
      }
    }
    return false;
  }

  const clientIp = resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: getHeader(req, "x-forwarded-for"),
    realIp: getHeader(req, "x-real-ip"),
    trustedProxies,
    allowRealIpFallback,
  });
  if (!clientIp) {
    return false;
  }

  for (const client of clients) {
    if (!client.clientIp || client.clientIp !== clientIp) {
      continue;
    }
    const clientToken = extractClientAuthToken(client);
    if (clientToken && safeEqual(clientToken, token)) {
      return true;
    }
  }
  return false;
}

function isAuthorizedByExistingGatewayClient(params: {
  req: IncomingMessage;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<GatewayWsClient>;
}): boolean {
  const { req, trustedProxies, allowRealIpFallback, clients } = params;
  if (isLocalDirectRequest(req, trustedProxies, allowRealIpFallback)) {
    return true;
  }

  const clientIp = resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: getHeader(req, "x-forwarded-for"),
    realIp: getHeader(req, "x-real-ip"),
    trustedProxies,
    allowRealIpFallback,
  });
  if (!clientIp) {
    return false;
  }
  return hasAuthorizedWsClientForIp(clients, clientIp);
}

export function createTerminalWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}

export async function handleTerminalUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: {
    resolvedAuth: ResolvedGatewayAuth;
    defaultCwd?: string;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    clients?: Set<GatewayWsClient>;
    controlUiConfig?: {
      allowedOrigins?: string[];
      dangerouslyAllowHostHeaderOriginFallback?: boolean;
      dangerouslyDisableDeviceAuth?: boolean;
    };
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname !== "/ws/terminal") {
    return false;
  }

  const token = url.searchParams.get("token");
  const terminalId = url.searchParams.get("id");

  if (!terminalId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return true;
  }

  const tokenValue = typeof token === "string" ? token.trim() : "";
  const trustedProxies = opts.trustedProxies ?? [];
  const allowRealIpFallback = opts.allowRealIpFallback === true;
  const clients = opts.clients;
  const gatewayAuthResult = await authorizeWsControlUiGatewayConnect({
    auth: opts.resolvedAuth,
    connectAuth:
      tokenValue.length > 0
        ? {
            token: tokenValue,
            password: tokenValue,
          }
        : undefined,
    req,
    trustedProxies,
    allowRealIpFallback,
  });
  const tokenOkByExistingClient =
    tokenValue.length > 0 && clients
      ? hasAuthorizedWsClientForToken({
          req,
          token: tokenValue,
          trustedProxies,
          allowRealIpFallback,
          clients,
        })
      : false;
  const tokenOk = gatewayAuthResult.ok || tokenOkByExistingClient;

  if (!tokenOk) {
    const allowWithoutToken =
      clients &&
      isAuthorizedByExistingGatewayClient({
        req,
        trustedProxies,
        allowRealIpFallback,
        clients,
      });
    const allowControlUiBypass =
      opts.controlUiConfig?.dangerouslyDisableDeviceAuth === true &&
      checkBrowserOrigin({
        requestHost: getHeader(req, "host"),
        origin: getHeader(req, "origin"),
        allowedOrigins: opts.controlUiConfig?.allowedOrigins,
        allowHostHeaderOriginFallback:
          opts.controlUiConfig?.dangerouslyAllowHostHeaderOriginFallback === true,
      }).ok;

    if (!allowWithoutToken && !allowControlUiBypass) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }
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
      const msg = JSON.parse(rawDataToString(data)) as TerminalWsMessage;

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
