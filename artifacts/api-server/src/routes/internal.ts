import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { quote, RouterError } from "../lib/internal-router";
import { handleSettlement } from "../lib/internal-settlement";
import { internalToken } from "../lib/internal-env";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function authorized(req: Request): boolean {
  const supplied = Buffer.from((req.header("authorization") ?? "").replace(/^Bearer /, ""));
  const expected = Buffer.from(internalToken());
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function fail(res: Response, error: unknown) {
  const status = error instanceof RouterError ? error.status : 500;
  const message = error instanceof Error ? error.message : "internal_error";
  if (status >= 500) logger.error({ err: error }, "internal credit service error");
  res.status(status).json({ executable: false, error: status >= 500 && !(error instanceof RouterError) ? "internal_error" : message });
}

router.post("/internal/credit/quote", async (req, res) => {
  if (!authorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  try { res.json(await quote(req.body)); } catch (error) { fail(res, error); }
});

router.post("/internal/credit/settlement", async (req, res) => {
  if (!authorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  try { res.json(await handleSettlement(req.body)); } catch (error) { fail(res, error); }
});

export default router;
