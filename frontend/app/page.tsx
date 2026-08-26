"use client";

import { useState, useEffect, useMemo } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatEther, parseEther } from "viem";
import { LEND_ADDRESS, MARKETS, LEND_ABI, ERC20_ABI } from "./abi";

const WETH = MARKETS[0];   // volatile collateral
const USDC = MARKETS[1];   // stable, borrowable
const MAXU = 2n ** 256n - 1n;

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const tok = (v?: bigint, d = 4) =>
  v === undefined ? "—" : Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: d });

/* ═════════ RISK GAUGE ═════════ */
function Gauge({ hf, projected }: { hf: number | null; projected: number | null }) {
  // sweep 0..3+ across 220 degrees, starting bottom-left
  const START = -200, SWEEP = 220;
  const angle = (v: number) => START + (Math.min(v, 3) / 3) * SWEEP;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const pt = (deg: number, r: number) => [100 + Math.cos(rad(deg)) * r, 100 + Math.sin(rad(deg)) * r];

  const arc = (from: number, to: number, r: number) => {
    const [x1, y1] = pt(angle(from), r);
    const [x2, y2] = pt(angle(to), r);
    const large = angle(to) - angle(from) > 180 ? 1 : 0;
    return `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2}`;
  };

  const zone = hf === null ? "var(--safe)" : hf < 1 ? "var(--danger)" : hf < 1.5 ? "var(--caution)" : "var(--safe)";
  const danger = hf !== null && hf < 1;

  return (
    <div className="relative w-full max-w-[320px] mx-auto">
      <svg viewBox="0 0 200 150" className="w-full" aria-label="Health factor gauge">
        {/* zones */}
        <path d={arc(0, 1, 78)} fill="none" stroke="var(--danger)" strokeWidth="11" strokeOpacity="0.85" />
        <path d={arc(1, 1.5, 78)} fill="none" stroke="var(--caution)" strokeWidth="11" strokeOpacity="0.85" />
        <path d={arc(1.5, 3, 78)} fill="none" stroke="var(--safe)" strokeWidth="11" strokeOpacity="0.85" />

        {/* ticks */}
        {[0, 0.5, 1, 1.5, 2, 2.5, 3].map((v) => {
          const a = angle(v);
          const [x1, y1] = pt(a, 66);
          const [x2, y2] = pt(a, 72);
          const [lx, ly] = pt(a, 56);
          return (
            <g key={v}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.35)" strokeWidth={v === 1 ? 1.8 : 1} />
              <text x={lx} y={ly + 2.5} textAnchor="middle" className="font-num"
                style={{ fontSize: 7, fill: v === 1 ? "var(--danger)" : "rgba(255,255,255,0.4)" }}>
                {v.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* projected needle (stress test) */}
        {projected !== null && (
          <g className="needle-ghost" style={{ transform: `rotate(${angle(projected) + 90}deg)` }}>
            <line x1="100" y1="100" x2="100" y2="38" stroke="rgba(255,255,255,0.4)"
              strokeWidth="1.6" strokeDasharray="3 3" strokeLinecap="round" />
          </g>
        )}

        {/* live needle */}
        {hf !== null && (
          <g className="needle" style={{ transform: `rotate(${angle(hf) + 90}deg)` }}>
            <line x1="100" y1="100" x2="100" y2="34" stroke={zone} strokeWidth="2.6" strokeLinecap="round" />
          </g>
        )}
        <circle cx="100" cy="100" r="6" fill="#0b1017" stroke={zone} strokeWidth="2" />
      </svg>

      <div className="text-center -mt-6">
        <p className="font-num text-[10px] tracking-[0.28em] text-white/40">HEALTH FACTOR</p>
        <p className={`font-display text-5xl font-black tabular leading-none mt-1 ${danger ? "alarm" : ""}`}
          style={{ color: zone }}>
          {hf === null ? "∞" : hf.toFixed(2)}
        </p>
        <p className="font-num text-[11px] mt-2" style={{ color: danger ? "var(--danger)" : "rgba(255,255,255,0.4)" }}>
          {hf === null ? "no debt — nothing at risk"
            : danger ? "⚠ LIQUIDATABLE AT A 5% DISCOUNT"
            : hf < 1.5 ? "thin margin — one drop from trouble"
            : "comfortable"}
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const [depositAmt, setDepositAmt] = useState("1");
  const [borrowAmt, setBorrowAmt] = useState("500");
  const [repayAmt, setRepayAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [shock, setShock] = useState(0); // % price drop for the stress test

  const L = { address: LEND_ADDRESS, abi: LEND_ABI } as const;
  const acc = (address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const on = !!address;

  const { data: collateral, refetch: r1 } = useReadContract({
    ...L, functionName: "collateralValue", args: [acc], query: { enabled: on, refetchInterval: 10000 },
  });
  const { data: debt, refetch: r2 } = useReadContract({
    ...L, functionName: "debtValue", args: [acc], query: { enabled: on, refetchInterval: 10000 },
  });
  const { data: hfRaw, refetch: r3 } = useReadContract({
    ...L, functionName: "healthFactor", args: [acc], query: { enabled: on, refetchInterval: 10000 },
  });
  const { data: wethDep, refetch: r4 } = useReadContract({
    ...L, functionName: "deposits", args: [acc, WETH.token], query: { enabled: on },
  });
  const { data: usdcDep, refetch: r5 } = useReadContract({
    ...L, functionName: "deposits", args: [acc, USDC.token], query: { enabled: on },
  });
  const { data: usdcDebt, refetch: r6 } = useReadContract({
    ...L, functionName: "borrows", args: [acc, USDC.token], query: { enabled: on },
  });
  const { data: liq, refetch: r7 } = useReadContract({
    ...L, functionName: "availableLiquidity", args: [USDC.token], query: { refetchInterval: 10000 },
  });
  const { data: wethBal, refetch: r8 } = useReadContract({
    address: WETH.token, abi: ERC20_ABI, functionName: "balanceOf", args: [acc], query: { enabled: on },
  });
  const { data: usdcBal, refetch: r9 } = useReadContract({
    address: USDC.token, abi: ERC20_ABI, functionName: "balanceOf", args: [acc], query: { enabled: on },
  });
  const { data: wethAllow, refetch: r10 } = useReadContract({
    address: WETH.token, abi: ERC20_ABI, functionName: "allowance", args: [acc, LEND_ADDRESS], query: { enabled: on },
  });
  const { data: usdcAllow, refetch: r11 } = useReadContract({
    address: USDC.token, abi: ERC20_ABI, functionName: "allowance", args: [acc, LEND_ADDRESS], query: { enabled: on },
  });

  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isMining;
  useEffect(() => {
    if (isSuccess) { [r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11].forEach((f) => f()); reset(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  const colN = collateral ? Number(formatEther(collateral as bigint)) : 0;
  const debtN = debt ? Number(formatEther(debt as bigint)) : 0;
  const noDebt = hfRaw !== undefined && (hfRaw as bigint) === MAXU;
  const hf = noDebt || debtN === 0 ? null : Number(hfRaw) / 10000;

  // stress test: only WETH is volatile, so shock its share of the collateral
  const wethValue = wethDep ? Number(formatEther(wethDep as bigint)) * Number(WETH.price) * 0.75 : 0;
  const stableValue = colN - wethValue;
  const projected = useMemo(() => {
    if (shock === 0 || debtN === 0) return null;
    const shocked = stableValue + wethValue * (1 - shock / 100);
    return shocked / debtN;
  }, [shock, stableValue, wethValue, debtN]);

  const wethWei = depositAmt ? parseEther(depositAmt) : 0n;
  const repayWei = repayAmt ? parseEther(repayAmt) : 0n;
  const needWeth = wethAllow !== undefined && wethWei > 0n && (wethAllow as bigint) < wethWei;
  const needUsdc = usdcAllow !== undefined && repayWei > 0n && (usdcAllow as bigint) < repayWei;

  const faucet = (t: `0x${string}`) =>
    writeContract({ address: t, abi: ERC20_ABI, functionName: "faucet" });
  const approve = (t: `0x${string}`, amt: bigint) =>
    writeContract({ address: t, abi: ERC20_ABI, functionName: "approve", args: [LEND_ADDRESS, amt] });
  const act = (fn: "deposit" | "withdraw" | "borrow" | "repay", t: `0x${string}`, amt: bigint) =>
    writeContract({ ...L, functionName: fn, args: [t, amt] });

  const input = "w-full bg-transparent font-num text-2xl font-bold tabular focus:outline-none placeholder:text-white/15";

  return (
    <div className="relative min-h-dvh">
      <div className="room" />

      <div className="relative z-10 min-h-dvh flex flex-col">
        <header className="flex items-center justify-between gap-6 px-5 md:px-10 py-5">
          <div>
            <h1 className="font-display text-2xl font-black tracking-tight">
              Safe<span style={{ color: "var(--collateral)" }}>Lend</span>
            </h1>
            <p className="font-num text-[10px] tracking-[0.22em] text-white/35 mt-1.5">
              RISK DESK · OVER-COLLATERALIZED LENDING · SEPOLIA
            </p>
          </div>
          <ConnectButton />
        </header>

        <main className="flex-1 grid lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-10 lg:gap-16 px-5 md:px-10 pb-10 items-start max-w-[1440px] w-full mx-auto">
          {/* ═══ INSTRUMENT ═══ */}
          <section className="space-y-6 lg:sticky lg:top-6">
            <div className="panel rounded-2xl p-6 pt-8">
              <Gauge hf={hf} projected={projected} />

              {/* collateral vs debt plates */}
              <div className="flex items-end gap-4 mt-8 h-[110px]">
                {[
                  { k: "BORROWING POWER", v: colN, c: "var(--collateral)" },
                  { k: "DEBT", v: debtN, c: "var(--debt)" },
                ].map((p) => {
                  const max = Math.max(colN, debtN, 1);
                  return (
                    <div key={p.k} className="flex-1 flex flex-col justify-end h-full">
                      <p className="font-num text-sm font-bold tabular mb-1.5" style={{ color: p.c }}>
                        {usd(p.v)}
                      </p>
                      <div className="plate rounded-t-lg"
                        style={{
                          height: `${Math.max(4, (p.v / max) * 74)}%`,
                          background: `linear-gradient(180deg, ${p.c}, ${p.c}55)`,
                          boxShadow: `0 0 24px ${p.c}44`,
                        }} />
                      <p className="font-num text-[9px] tracking-[0.14em] text-white/35 mt-2">{p.k}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* stress test */}
            <div className="panel rounded-2xl p-5">
              <p className="font-num text-[10px] tracking-[0.2em] text-white/40 mb-3">
                STRESS TEST — WHAT IF WETH DROPS?
              </p>
              <div className="flex gap-2">
                {[0, 10, 25, 50].map((s) => (
                  <button key={s} onClick={() => setShock(s)} data-on={shock === s && s > 0}
                    className="chip flex-1 font-num text-[12px] py-2 rounded-lg">
                    {s === 0 ? "now" : `−${s}%`}
                  </button>
                ))}
              </div>
              <p className="font-num text-[11px] mt-3 leading-relaxed"
                style={{ color: projected !== null && projected < 1 ? "var(--danger)" : "rgba(255,255,255,0.4)" }}>
                {debtN === 0 ? "Borrow something first — with no debt there is no risk to model."
                  : shock === 0 ? "Pick a drop to project the needle without touching the chain."
                  : projected !== null && projected < 1
                    ? `A ${shock}% drop puts you at ${projected.toFixed(2)} — under water, open to liquidation.`
                    : `A ${shock}% drop leaves you at ${projected?.toFixed(2)} — still solvent.`}
              </p>
            </div>
          </section>

          {/* ═══ DESK ═══ */}
          <section className="space-y-5">
            {!isConnected ? (
              <div className="panel rounded-2xl p-8">
                <h2 className="font-display text-4xl font-black leading-[1.06]">
                  Borrow against<br />what you hold.<br />
                  <span style={{ color: "var(--danger)" }}>Watch the needle.</span>
                </h2>
                <p className="text-white/45 mt-5 leading-relaxed max-w-md">
                  Every market carries a price, so collateral and debt are compared by value.
                  Let the health factor fall below 1.00 and anyone can repay your debt and take
                  your collateral at a 5% discount.
                </p>
              </div>
            ) : (
              <>
                {/* collateral */}
                <div className="panel rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="font-display text-lg font-bold" style={{ color: "var(--collateral)" }}>
                      Collateral · WETH
                    </h3>
                    <button onClick={() => faucet(WETH.token)} disabled={busy}
                      className="font-num text-[11px] text-white/35 hover:text-white transition-colors disabled:opacity-40">
                      wallet {tok(wethBal as bigint, 2)} · faucet
                    </button>
                  </div>
                  <p className="font-num text-[11px] text-white/35 mb-4">
                    deposited {tok(wethDep as bigint, 4)} WETH · ${WETH.price} each · 75% LTV
                  </p>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div>
                      <div className="field-input rounded-xl px-4 py-3 mb-2">
                        <input type="number" min="0" step="0.1" value={depositAmt}
                          onChange={(e) => setDepositAmt(e.target.value)} placeholder="0" className={input} />
                      </div>
                      {needWeth ? (
                        <button onClick={() => approve(WETH.token, wethWei)} disabled={busy || wethWei === 0n}
                          className="w-full py-3 rounded-xl font-bold text-sm border transition-colors disabled:opacity-35 hover:bg-white/5"
                          style={{ borderColor: "var(--collateral)", color: "var(--collateral)" }}>
                          {busy ? "…" : "Approve WETH"}
                        </button>
                      ) : (
                        <button onClick={() => act("deposit", WETH.token, wethWei)} disabled={busy || wethWei === 0n}
                          className="act-collateral w-full py-3 rounded-xl font-bold text-sm disabled:opacity-35">
                          {busy ? "…" : "Deposit"}
                        </button>
                      )}
                    </div>
                    <div>
                      <div className="field-input rounded-xl px-4 py-3 mb-2">
                        <input type="number" min="0" step="0.1" value={withdrawAmt}
                          onChange={(e) => setWithdrawAmt(e.target.value)} placeholder="0" className={input} />
                      </div>
                      <button onClick={() => act("withdraw", WETH.token, parseEther(withdrawAmt || "0"))}
                        disabled={busy || !withdrawAmt}
                        className="w-full py-3 rounded-xl font-bold text-sm border border-white/15 hover:bg-white/5 transition-colors disabled:opacity-35">
                        {busy ? "…" : "Withdraw"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* debt */}
                <div className="panel rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="font-display text-lg font-bold" style={{ color: "var(--debt)" }}>
                      Debt · USDC
                    </h3>
                    <span className="font-num text-[11px] text-white/35">
                      pool liquidity {tok(liq as bigint, 0)}
                    </span>
                  </div>
                  <p className="font-num text-[11px] text-white/35 mb-4">
                    you owe {tok(usdcDebt as bigint, 2)} USDC · wallet {tok(usdcBal as bigint, 2)}
                  </p>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <div>
                      <div className="field-input rounded-xl px-4 py-3 mb-2">
                        <input type="number" min="0" step="10" value={borrowAmt}
                          onChange={(e) => setBorrowAmt(e.target.value)} placeholder="0" className={input} />
                      </div>
                      <button onClick={() => act("borrow", USDC.token, parseEther(borrowAmt || "0"))}
                        disabled={busy || !borrowAmt}
                        className="act-debt w-full py-3 rounded-xl font-bold text-sm disabled:opacity-35">
                        {busy ? "…" : "Borrow"}
                      </button>
                    </div>
                    <div>
                      <div className="field-input rounded-xl px-4 py-3 mb-2">
                        <input type="number" min="0" step="10" value={repayAmt}
                          onChange={(e) => setRepayAmt(e.target.value)} placeholder="0" className={input} />
                      </div>
                      {needUsdc ? (
                        <button onClick={() => approve(USDC.token, repayWei)} disabled={busy || repayWei === 0n}
                          className="w-full py-3 rounded-xl font-bold text-sm border transition-colors disabled:opacity-35 hover:bg-white/5"
                          style={{ borderColor: "var(--debt)", color: "var(--debt)" }}>
                          {busy ? "…" : "Approve USDC"}
                        </button>
                      ) : (
                        <button onClick={() => act("repay", USDC.token, repayWei)} disabled={busy || repayWei === 0n}
                          className="w-full py-3 rounded-xl font-bold text-sm border border-white/15 hover:bg-white/5 transition-colors disabled:opacity-35">
                          {busy ? "…" : "Repay"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* supplied stable note */}
                {usdcDep !== undefined && (usdcDep as bigint) > 0n && (
                  <div className="panel rounded-2xl p-4">
                    <p className="font-num text-[11px] text-white/45 leading-relaxed">
                      You also supply <span className="text-white">{tok(usdcDep as bigint, 0)} USDC</span> to the pool.
                      Supplied assets double as collateral here, which is why your borrowing power is
                      already {usd(colN)} before depositing any WETH.
                    </p>
                  </div>
                )}

                {txHash && !isSuccess && (
                  <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer"
                    className="block text-center font-num text-[10px] tracking-[0.16em]"
                    style={{ color: "var(--collateral)" }}>
                    ◆ AWAITING CONFIRMATION — VIEW TX
                  </a>
                )}
              </>
            )}
          </section>
        </main>

        <footer className="px-5 md:px-10 pb-7 flex flex-wrap items-center justify-between gap-3 font-num text-[10px] tracking-[0.16em] text-white/25">
          <span>PRICES ARE OWNER-SET — A PRODUCTION DEPLOY WOULD READ CHAINLINK</span>
          <a href={`https://sepolia.etherscan.io/address/${LEND_ADDRESS}`} target="_blank" rel="noreferrer"
            className="hover:text-white/55 transition-colors">
            {LEND_ADDRESS.slice(0, 10)}…{LEND_ADDRESS.slice(-8)}
          </a>
        </footer>
      </div>
    </div>
  );
}
