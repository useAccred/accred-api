import { Contract, Interface, Wallet, getAddress, isAddress } from "ethers";
import { eq } from "drizzle-orm";
import { db, settlementOperationsTable } from "@workspace/db";
import { creditConfiguration } from "./credit-config";
import { rpcProvider } from "./internal-router";
import { runOnce } from "./internal-settlement";

const STAKE_FROM_BLOCK = 0x4a15000; // before the staking contract deployment
const stakingAbi = [
  "function stakes(uint256) view returns (address user,uint256 amount,uint256 payout,uint256 unlockAt,bool claimed)",
  "function nextStakeId() view returns (uint256)",
];
const erc20Abi = ["function transfer(address to,uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const rewardKey = (id: bigint) => `staking-reward:${id}`;

function stakingContract() {
  const { stakingAddress } = creditConfiguration().addresses;
  if (!stakingAddress || !isAddress(stakingAddress)) throw new Error("staking_not_configured");
  return new Contract(stakingAddress, stakingAbi, rpcProvider());
}

/** Reward state for one stake, read from the contract (authoritative) and the payout ledger. */
export async function stakeRewardState(id: bigint) {
  const s = await stakingContract().stakes!(id) as { user: string; amount: bigint; payout: bigint; unlockAt: bigint; claimed: boolean };
  if (s.user === "0x0000000000000000000000000000000000000000") return null;
  const [row] = await db.select().from(settlementOperationsTable).where(eq(settlementOperationsTable.idempotencyKey, rewardKey(id)));
  return { user: s.user, payout: s.payout, claimed: s.claimed, paidTxHash: row?.txHash ?? null, payoutStatus: row?.status ?? null };
}

/** Pays the USDG reward for a stake whose principal has been claimed on-chain. Idempotent per stake id. */
export async function payStakingReward(id: bigint): Promise<{ txHash: string | null; state: string }> {
  const state = await stakeRewardState(id);
  if (!state || !state.claimed) throw new Error("stake_not_claimed");
  const { usdgAddress } = creditConfiguration().addresses;
  const key = process.env.CASHBACK_PAYOUT_PRIVATE_KEY;
  if (!key || !usdgAddress) throw new Error("reward_wallet_not_configured");
  return runOnce(rewardKey(id), "staking_reward", async () => {
    const signer = new Wallet(key).connect(rpcProvider());
    const usdg = new Contract(usdgAddress, erc20Abi, signer);
    if ((await usdg.balanceOf!(signer.address) as bigint) < state.payout) throw new Error("presend:reward_wallet_unfunded");
    const tx = await usdg.transfer!(getAddress(state.user), state.payout);
    const done = await tx.wait();
    if (done?.status !== 1) throw new Error("reward_payout_reverted");
    return tx.hash as string;
  });
}

/** USDG the reward wallet can still commit to new stakes: its balance minus rewards owed on open or unpaid stakes. */
export async function stakingCapacity(): Promise<bigint> {
  const { usdgAddress, cashbackAddress, stakingAddress } = creditConfiguration().addresses;
  if (!usdgAddress || !cashbackAddress || !stakingAddress) return 0n;
  const provider = rpcProvider();
  const balance = await new Contract(usdgAddress, erc20Abi, provider).balanceOf!(cashbackAddress) as bigint;
  const contract = stakingContract();
  const next = await contract.nextStakeId!() as bigint;
  let owed = 0n;
  for (let id = 0n; id < next; id++) {
    const s = await stakeRewardState(id);
    if (s && !s.paidTxHash) owed += s.payout;
  }
  return balance > owed ? balance - owed : 0n;
}

export const stakedEventTopic = new Interface(["event Staked(uint256 indexed id,address indexed user,uint256 credits,uint256 payout,uint256 unlockAt,uint256 daysLocked)"]).getEvent("Staked")!.topicHash;
export { STAKE_FROM_BLOCK };
