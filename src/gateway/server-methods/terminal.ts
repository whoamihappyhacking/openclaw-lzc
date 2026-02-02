import type { GatewayRequestHandlers } from "./types.js";
import { listPersistentTerminals } from "../terminal/ws-handler.js";

export const terminalHandlers: GatewayRequestHandlers = {
  "terminal.list": async ({ respond }) => {
    const sessions = listPersistentTerminals();
    respond(true, { sessions }, undefined);
  },
};
