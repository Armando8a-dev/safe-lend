"use client";

import { useState, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatEther, parseEther } from "viem";
import { LEND_ADDRESS, MARKETS, LEND_ABI, ERC20_ABI } from "./abi";

const WETH = MARKETS[0]; // collateral
const USDC = MARKETS[1]; // borrowable

export default function Home() {
  const { address, isConnected } = useAccount();
  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isMining;

  const [depositAmt, setDepositAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [borrowAmt, setBorrowAmt] = useState("");
  const [repayAmt, setRepayAmt] = useState("");

  // ─── reads ────────────────────────────────────────────────────────────
  const acc = (address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const P = { refetchInterval: 8000 as const };

  const { data: collateral, refetch: r1 } = useReadContract({
    address: LEND_ADDRESS, abi: LEND_ABI, functionName: "collateralValue", args: [acc], query: { enabled: !!address, ...P },
  });
  const { data: debt, refetch: r2 } = useReadContract({
    address: LEND_ADDRESS, abi: LEND_ABI, functionName: "debtValue", args: [acc], query: { enabled: !!address, ...P },
  });
  const { data: hf, refetch: r3 } = useReadContract({
    address: LEND_ADDRESS, abi: LEND_ABI, functionName: "healthFactor", args: [acc], query: { enabled: !!address, ...P },
  });
  const { data: wethDep, refetch: r4 } = useReadContract({
    address: LEND_ADDRESS, abi: LEND_ABI, functionName: "deposits", args: [acc, WETH.token], query: { enabled: !!address },
  });
  const { data: usdcDebt, refetch: r5 } = useReadContract({
    address: LEND_ADDRESS, abi: LEND_ABI, functionName: "borrows", args: [acc, USDC.token], query: { enabled: !!address },
  });
  const { data: usdcLiq, refetch: r6 } = useReadContract({
    address: LEND_ADDRESS, abi: LEND_ABI, functionName: "availableLiquidity", args: [USDC.token], query: P,
  });

  const { data: wethBal, refetch: r7 } = useReadContract({
    address: WETH.token, abi: ERC20_ABI, functionName: "balanceOf", args: [acc], query: { enabled: !!address },
  });
  const { data: usdcBal, refetch: r8 } = useReadContract({
    address: USDC.token, abi: ERC20_ABI, functionName: "balanceOf", args: [acc], query: { enabled: !!address },
  });
  const { data: wethAllow, refetch: r9 } = useReadContract({
    address: WETH.token, abi: ERC20_ABI, functionName: "allowance", args: [acc, LEND_ADDRESS], query: { enabled: !!address },
  });
  const { data: usdcAllow, refetch: r10 } = useReadContract({
    address: USDC.token, abi: ERC20_ABI, functionName: "allowance", args: [acc, LEND_ADDRESS], query: { enabled: !!address },
  });

  useEffect(() => {
    if (isSuccess) { [r1,r2,r3,r4,r5,r6,r7,r8,r9,r10].forEach((f) => f()); reset(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  // ─── derived ──────────────────────────────────────────────────────────
  const usd = (v?: bigint) => (v !== undefined ? `$${Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—");
  const tok = (v?: bigint) => (v !== undefined ? Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—");

  const MAXU = 2n ** 256n - 1n;
  const noDebt = hf !== undefined && (hf as bigint) === MAXU;
  const hfNum = hf !== undefined && !noDebt ? Number(hf) / 10000 : null;
  const hfColor = noDebt ? "text-emerald-400" : hfNum === null ? "text-white/50"
    : hfNum >= 1.5 ? "text-emerald-400" : hfNum >= 1.0 ? "text-amber-400" : "text-rose-400";
  const hfLabel = noDebt ? "∞ (no debt)" : hfNum === null ? "—" : `${hfNum.toFixed(2)}`;

  // ─── actions ──────────────────────────────────────────────────────────
  const faucet = (token: `0x${string}`) => writeContract({ address: token, abi: ERC20_ABI, functionName: "faucet" });
  const approve = (token: `0x${string}`, amount: bigint) =>
    writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [LEND_ADDRESS, amount] });
  const act = (fn: "deposit" | "withdraw" | "borrow" | "repay", token: `0x${string}`, amount: bigint) =>
    writeContract({ address: LEND_ADDRESS, abi: LEND_ABI, functionName: fn, args: [token, amount] });

  const wethAmt = depositAmt ? parseEther(depositAmt) : 0n;
  const repayWei = repayAmt ? parseEther(repayAmt) : 0n;
  const needWethApproval = wethAllow !== undefined && wethAmt > 0n && (wethAllow as bigint) < wethAmt;
  const needUsdcApproval = usdcAllow !== undefined && repayWei > 0n && (usdcAllow as bigint) < repayWei;

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-teal-400">🏦 SafeLend</h1>
          <p className="text-sm text-white/50">Over-collateralized lending · Sepolia</p>
        </div>
        <ConnectButton />
      </div>

      {!isConnected ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-12 text-center">
          <p className="text-4xl mb-4">🏦</p>
          <p className="text-white/60">Connect your wallet to deposit collateral and borrow against it.</p>
        </div>
      ) : (
        <>
          {/* Health card */}
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="flex items-end justify-between mb-4">
              <div>
                <p className="text-sm text-white/50">Health factor</p>
                <p className={`text-4xl font-bold ${hfColor}`}>{hfLabel}</p>
                <p className="text-xs text-white/40 mt-1">
                  {hfNum !== null && hfNum < 1 ? "⚠️ Liquidatable — repay or add collateral" : "Safe while ≥ 1.00"}
                </p>
              </div>
              <div className="text-right text-sm">
                <p className="text-white/50">Collateral (borrow power)</p>
                <p className="font-semibold text-emerald-400">{usd(collateral as bigint)}</p>
                <p className="text-white/50 mt-2">Debt</p>
                <p className="font-semibold text-rose-400">{usd(debt as bigint)}</p>
              </div>
            </div>
          </div>

          {/* Collateral panel: WETH */}
          <div className="mb-4 rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-teal-400">Collateral · WETH</h2>
              <button onClick={() => faucet(WETH.token)} disabled={busy}
                className="text-xs bg-white/10 hover:bg-white/20 disabled:opacity-40 px-3 py-1 rounded-lg transition-colors">
                {busy ? "..." : "Faucet 100 WETH"}
              </button>
            </div>
            <p className="text-xs text-white/40 mb-4">
              Deposited: {tok(wethDep as bigint)} WETH · Wallet: {tok(wethBal as bigint)} WETH · Price ${WETH.price} · 75% LTV
            </p>

            <div className="flex gap-2 mb-2">
              <input type="number" min="0" step="0.01" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)}
                placeholder="Deposit WETH"
                className="flex-1 bg-white/10 border border-white/20 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-teal-400" />
              {needWethApproval ? (
                <button onClick={() => approve(WETH.token, wethAmt)} disabled={busy || !depositAmt}
                  className="bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-black font-semibold px-5 rounded-xl transition-colors">
                  {busy ? "..." : "Approve"}
                </button>
              ) : (
                <button onClick={() => act("deposit", WETH.token, wethAmt)} disabled={busy || !depositAmt}
                  className="bg-teal-500 hover:bg-teal-400 disabled:opacity-40 text-black font-semibold px-5 rounded-xl transition-colors">
                  {busy ? "..." : "Deposit"}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <input type="number" min="0" step="0.01" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)}
                placeholder="Withdraw WETH"
                className="flex-1 bg-white/10 border border-white/20 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-teal-400" />
              <button onClick={() => act("withdraw", WETH.token, parseEther(withdrawAmt || "0"))} disabled={busy || !withdrawAmt}
                className="border border-white/20 hover:bg-white/10 disabled:opacity-40 font-semibold px-5 rounded-xl transition-colors">
                {busy ? "..." : "Withdraw"}
              </button>
            </div>
          </div>

          {/* Borrow panel: USDC */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-teal-400">Borrow · USDC</h2>
              <span className="text-xs text-white/40">Pool liquidity: {tok(usdcLiq as bigint)} USDC</span>
            </div>
            <p className="text-xs text-white/40 mb-4">
              Your debt: {tok(usdcDebt as bigint)} USDC · Wallet: {tok(usdcBal as bigint)} USDC · Price ${USDC.price}
            </p>

            <div className="flex gap-2 mb-2">
              <input type="number" min="0" step="1" value={borrowAmt} onChange={(e) => setBorrowAmt(e.target.value)}
                placeholder="Borrow USDC"
                className="flex-1 bg-white/10 border border-white/20 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-teal-400" />
              <button onClick={() => act("borrow", USDC.token, parseEther(borrowAmt || "0"))} disabled={busy || !borrowAmt}
                className="bg-teal-500 hover:bg-teal-400 disabled:opacity-40 text-black font-semibold px-5 rounded-xl transition-colors">
                {busy ? "..." : "Borrow"}
              </button>
            </div>
            <div className="flex gap-2">
              <input type="number" min="0" step="1" value={repayAmt} onChange={(e) => setRepayAmt(e.target.value)}
                placeholder="Repay USDC"
                className="flex-1 bg-white/10 border border-white/20 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-teal-400" />
              {needUsdcApproval ? (
                <button onClick={() => approve(USDC.token, repayWei)} disabled={busy || !repayAmt}
                  className="bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-black font-semibold px-5 rounded-xl transition-colors">
                  {busy ? "..." : "Approve"}
                </button>
              ) : (
                <button onClick={() => act("repay", USDC.token, repayWei)} disabled={busy || !repayAmt}
                  className="border border-white/20 hover:bg-white/10 disabled:opacity-40 font-semibold px-5 rounded-xl transition-colors">
                  {busy ? "..." : "Repay"}
                </button>
              )}
            </div>
          </div>

          <p className="text-xs text-white/40 mt-6 text-center">
            Deposit WETH → borrow up to 75% of its value in USDC → repay to free your collateral.
            Health factor below 1.00 means the position can be liquidated.
          </p>
        </>
      )}

      <p className="text-center text-xs text-white/30 mt-6">
        Protocol:{" "}
        <a href={`https://sepolia.etherscan.io/address/${LEND_ADDRESS}`} target="_blank" rel="noreferrer" className="underline">
          {LEND_ADDRESS.slice(0, 6)}…{LEND_ADDRESS.slice(-4)}
        </a>
      </p>
    </main>
  );
}
