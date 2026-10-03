import { Router, type IRouter } from "express";
import { requirePrivySession } from "../lib/privy-auth";
import { creditConfiguration } from "../lib/credit-config";
import { payStakingReward, stakeRewardState, stakingCapacity } from "../lib/staking-rewards";
import { findVerifiedWallet } from "./credit";

const router: IRouter = Router();

/** Principal is claimed on-chain by the user; this endpoint then pays the USDG reward wallet-to-wallet. */
router.post("/credit/staking/:id/reward", requirePrivySession, async (req, res): Promise<void> => {
  if (!req.privySession) { res.status(401).json({ error: "A verified Privy session is required." }); return; }
  try {
    if (!/^\d{1,18}$/.test(String(req.params.id))) { res.status(400).json({ error: "Invalid stake id." }); return; }
    const id = BigInt(String(req.params.id));
    const wallet = await findVerifiedWallet(req.privySession.userId, "robinhood");
    const stake = await stakeRewardState(id);
    if (!wallet || !stake || stake.user.toLowerCase() !== wallet.walletAddress.toLowerCase()) {
      res.status(404).json({ error: "Stake not found for your verified wallet." }); return;
    }
    if (!stake.claimed) { res.status(409).json({ error: "Claim the principal on-chain first.", reason: "stake_not_claimed" }); return; }
    const result = await payStakingReward(id);
    res.json({ stakeId: id.toString(), status: result.txHash ? "paid" : "pending", payoutTxHash: result.txHash, amountUsdgMicros: stake.payout.toString() });
  } catch (error) {
    req.log.warn({ reason: error instanceof Error ? error.message : "unknown" }, "Staking reward payout not completed");
    res.status(503).json({ error: "Reward payout is pending; try again shortly.", reason: "reward_payout_pending" });
  }
});

router.get("/credit/staking/:id/reward", async (req, res): Promise<void> => {
  try {
    if (!/^\d{1,18}$/.test(String(req.params.id))) { res.status(400).json({ error: "Invalid stake id." }); return; }
    const stake = await stakeRewardState(BigInt(String(req.params.id)));
    if (!stake) { res.status(404).json({ error: "Unknown stake." }); return; }
    res.json({ claimed: stake.claimed, paid: Boolean(stake.paidTxHash), payoutTxHash: stake.paidTxHash });
  } catch { res.status(503).json({ error: "Staking state unavailable." }); }
});

router.get("/credit/staking/capacity", async (_req, res): Promise<void> => {
  try {
    const config = creditConfiguration();
    const capacity = await stakingCapacity();
    res.json({ stakingAddress: config.addresses.stakingAddress, capacityUsdgMicros: capacity.toString() });
  } catch { res.status(503).json({ error: "Staking capacity unavailable." }); }
});

export default router;
