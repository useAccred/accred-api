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

const router: IRouter = Router();

router.use(healthRouter);
router.use(protocolRouter);
router.use(authRouter);
router.use(customerRouter);
router.use(xBotRouter);
router.use(solanaAuthRouter);
router.use(creditRouter);
router.use(solanaDepositRouter);
router.use(stakingRouter);
router.use(internalRouter);

export default router;
