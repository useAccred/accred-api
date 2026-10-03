import { Router, type IRouter } from "express";
import { GetHealthzResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = GetHealthzResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
