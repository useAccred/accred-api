import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { lookupAccessToken, MCP_INTERNAL_SECRET, publicOrigin } from "../lib/mcp-oauth";

const router: IRouter = Router();
const PROTOCOL_VERSION = "2025-06-18";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const TOOLS = [
  {
    name: "accred_account",
    description: "Show the signed-in user's Accred credit balance (deposited, reserved and available service credits).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "accred_models",
    description: "List the models available through Accred with their per-million-token costs. Use a model id from here with accred_chat.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "accred_chat",
    description: "Send a prompt to a model and pay for it with the user's Accred credits. Returns the reply and the exact credits charged.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id from accred_models." },
        prompt: { type: "string", description: "The user message to send." },
        system: { type: "string", description: "Optional system instruction." },
        maxOutputTokens: { type: "integer", minimum: 1, description: "Optional cap on reply length." },
      },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "accred_swap_link",
    description: "Get a link to the Accred app where the user can swap tokens for credits. Swaps are signed by the user's own wallet in the app and cannot be done from chat.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function loopback(req: Request, token: string, method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${process.env["PORT"]}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-mcp-internal": MCP_INTERNAL_SECRET,
      "content-type": "application/json",
      ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

async function callTool(req: Request, token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === "accred_account") {
    const r = await loopback(req, token, "GET", "/credit/account");
    if (!r.ok) return text(String(r.data.error ?? "Could not read the account."), true);
    const { walletAddress, enabled, reason, depositedCredits, reservedCredits, availableCredits } = r.data;
    return text({ walletAddress, enabled, reason, depositedCredits, reservedCredits, availableCredits });
  }
  if (name === "accred_models") {
    const r = await loopback(req, token, "GET", "/customer/models");
    if (!r.ok) return text(String(r.data.error ?? "Models are unavailable."), true);
    const models = (r.data.models as Array<Record<string, unknown>>).filter((m) => m.available).map((m) => ({
      id: m.id, name: m.name,
      inputCostUsdPerMillion: m.inputCostUsdPerMillion, outputCostUsdPerMillion: m.outputCostUsdPerMillion,
    }));
    return text(models);
  }
  if (name === "accred_chat") {
    const model = typeof args.model === "string" ? args.model : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!model || !prompt) return text("model and prompt are required.", true);
    const messages: Array<{ role: string; content: string }> = [];
    if (typeof args.system === "string" && args.system) messages.push({ role: "system", content: args.system });
    messages.push({ role: "user", content: prompt });
    const body: Record<string, unknown> = { model, messages };
    if (typeof args.maxOutputTokens === "number") body.maxOutputTokens = args.maxOutputTokens;
    const r = await loopback(req, token, "POST", "/customer/playground", body);
    if (!r.ok) return text(String(r.data.error ?? "The request failed."), true);
    return text({
      reply: r.data.content,
      model: r.data.model,
      creditsCharged: r.data.creditsChargedExact,
      remainingCredits: r.data.remainingCreditsExact,
    });
  }
  if (name === "accred_swap_link") {
    return text(`Open ${publicOrigin(req)}/app/swap to swap tokens for credits. The swap is signed by your own wallet in the app.`);
  }
  return text(`Unknown tool: ${name}`, true);
}

function unauthorized(req: Request, res: Response): void {
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer resource_metadata="${publicOrigin(req)}/api/.well-known/oauth-protected-resource"`)
    .json({ error: "Sign in with Accred to use this connector." });
}

router.get("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json({ error: "Use POST." });
});

router.post("/mcp", async (req, res): Promise<void> => {
  const header = req.get("authorization");
  const token = header && /^Bearer\s+\S+$/i.test(header) ? header.replace(/^Bearer\s+/i, "") : "";
  const ctx = token ? await lookupAccessToken(token).catch(() => null) : null;
  if (!ctx) return unauthorized(req, res);

  const msg = req.body as RpcRequest;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  if (msg.id === undefined) { // notification
    res.status(202).end();
    return;
  }
  const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => res.json({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  try {
    switch (msg.method) {
      case "initialize":
        return void reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "accred", version: "1.0.0" },
        });
      case "ping":
        return void reply({});
      case "tools/list":
        return void reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        return void reply(await callTool(req, token, name, args));
      }
      default:
        return void fail(-32601, "Method not found");
    }
  } catch (error) {
    req.log.warn({ error }, "MCP request failed");
    fail(-32603, "Internal error");
  }
});

export default router;
