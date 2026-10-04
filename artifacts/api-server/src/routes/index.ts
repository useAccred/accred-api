import { Router, type IRouter } from "express";
import healthRouter from "./health";
import protocolRouter from "./protocol";
import authRouter from "./auth";
import customerRouter from "./customer";
import xBotRouter from "./x-bot";
import solanaAuthRouter from "./solana-auth";
import creditRouter from "./credit";
import solanaDepositRouter from "./solana-deposit";
import stakingRouter from "./staking";
import internalRouter from "./internal";
import oauthRouter from "./oauth";
import mcpRouter from "./mcp";
import openaiRouter from "./openai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(protocolRouter);
router.use(authRouter);
router.use(openaiRouter);
router.use(customerRouter);
router.use(xBotRouter);
router.use(solanaAuthRouter);
router.use(creditRouter);
router.use(solanaDepositRouter);
router.use(stakingRouter);
router.use(internalRouter);
router.use(oauthRouter);
router.use(mcpRouter);

export default router;
