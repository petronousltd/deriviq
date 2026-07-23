// Per-contract-type analysis of the raw tick series.
//
// Each Deriv contract family settles on a measurable property of the ticks:
// direction (Up/Down, Reset), monotone runs (Only Ups/Only Downs), position of
// extremes (High/Low Ticks), last-vs-average (Asians), and band survival
// (Touch/No Touch, In/Out, Accumulators). These functions measure what the
// feed actually does. They describe behaviour; they do not predict it, and
// contract payouts are priced against these same probabilities.



/** Tick-to-tick direction behaviour: Up/Down, Reset Call/Put. */
export function directionStats(prices) {
  const n = prices.length;
  const result = {
    moves: 0, up: 0, down: 0, flat: 0,
    pUp: null, pUpAfterUp: null, pUpAfterDown: null, independent: true,
  };
  if (n < 3) return result;
  let prevDir = 0;
  let afterUp = 0, upAfterUp = 0, afterDown = 0, upAfterDown = 0;
  for (let i = 1; i < n; i++) {
    const diff = prices[i] - prices[i - 1];
    const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    result.moves += 1;
    if (dir > 0) result.up += 1;
    else if (dir < 0) result.down += 1;
    else result.flat += 1;
    if (prevDir === 1) { afterUp += 1; if (dir === 1) upAfterUp += 1; }
    if (prevDir === -1) { afterDown += 1; if (dir === 1) upAfterDown += 1; }
    prevDir = dir;
  }
  result.pUp = result.up / result.moves;
  result.pUpAfterUp = afterUp ? upAfterUp / afterUp : null;
  result.pUpAfterDown = afterDown ? upAfterDown / afterDown : null;
  if (result.pUpAfterUp !== null && result.pUpAfterDown !== null && afterUp > 50 && afterDown > 50) {
    // ~2-sigma band for the difference of two proportions around independence
    const se = Math.sqrt(0.25 / afterUp + 0.25 / afterDown);
    result.independent = Math.abs(result.pUpAfterUp - result.pUpAfterDown) < 2 * se;
  }
  return result;
}

/** Monotone run lengths: Only Ups / Only Downs. Compares observed frequency of
 * k consecutive same-direction moves with the independence prediction p^k. */
export function monotoneRuns(prices, maxK = 5) {
  const n = prices.length;
  const dirs = [];
  for (let i = 1; i < n; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff !== 0) dirs.push(diff > 0 ? 1 : -1);
  }
  const m = dirs.length;
  const rows = [];
  if (m < 50) return { rows, samples: m };
  const pUp = dirs.filter((d) => d === 1).length / m;
  for (let k = 2; k <= maxK; k++) {
    let windows = 0, allUp = 0, allDown = 0;
    for (let i = 0; i + k <= m; i++) {
      windows += 1;
      let ups = 0;
      for (let j = 0; j < k; j++) if (dirs[i + j] === 1) ups += 1;
      if (ups === k) allUp += 1;
      if (ups === 0) allDown += 1;
    }
    rows.push({
      k,
      obsUp: allUp / windows,
      expUp: Math.pow(pUp, k),
      obsDown: allDown / windows,
      expDown: Math.pow(1 - pUp, k),
    });
  }
  return { rows, samples: m, pUp };
}

/** Position of the highest and lowest tick inside w-tick windows: High/Low
 * Ticks. NOTE: on a random walk extremes are NOT uniform — the arcsine law
 * concentrates them at window endpoints. That clustering is expected physics,
 * priced into the contract, so this reports the distribution rather than
 * flagging it. */
export function extremePositions(prices, w = 5) {
  const n = prices.length;
  const hi = new Array(w).fill(0);
  const lo = new Array(w).fill(0);
  let windows = 0;
  for (let i = 0; i + w <= n; i += w) {
    let hiIdx = 0, loIdx = 0;
    for (let j = 1; j < w; j++) {
      if (prices[i + j] > prices[i + hiIdx]) hiIdx = j;
      if (prices[i + j] < prices[i + loIdx]) loIdx = j;
    }
    hi[hiIdx] += 1;
    lo[loIdx] += 1;
    windows += 1;
  }
  return { w, windows, hi, lo };
}

/** Last tick vs the window average: Asians. Under symmetry ~50%. */
export function asianStats(prices, w = 5) {
  const n = prices.length;
  let windows = 0, lastAbove = 0;
  for (let i = 0; i + w <= n; i += w) {
    let sum = 0;
    for (let j = 0; j < w; j++) sum += prices[i + j];
    const mean = sum / w;
    if (prices[i + w - 1] > mean) lastAbove += 1;
    windows += 1;
  }
  return { w, windows, pLastAbove: windows ? lastAbove / windows : null };
}

/**
 * Band survival: Touch/No Touch, In/Out, Accumulators. For a band of +/- b
 * around the entry price (b in multiples of the median absolute tick move),
 * the empirical probability the price stays inside for k consecutive ticks.
 */
export function bandSurvival(prices, ks = [1, 2, 3, 5, 8, 13], bandMult = 3) {
  const n = prices.length;
  if (n < 100) return { rows: [], band: null, samples: 0 };
  const moves = [];
  for (let i = 1; i < n; i++) moves.push(Math.abs(prices[i] - prices[i - 1]));
  moves.sort((a, b) => a - b);
  const median = moves[Math.floor(moves.length / 2)] || 0;
  const band = median * bandMult;
  if (band === 0) return { rows: [], band: 0, samples: 0 };
  const maxK = Math.max(...ks);
  const rows = ks.map((k) => ({ k, windows: 0, survived: 0 }));
  for (let i = 0; i + maxK < n; i += 1) {
    const entry = prices[i];
    let broke = maxK + 1;
    for (let j = 1; j <= maxK; j++) {
      if (Math.abs(prices[i + j] - entry) > band) { broke = j; break; }
    }
    for (const row of rows) {
      row.windows += 1;
      if (broke > row.k) row.survived += 1;
    }
  }
  return {
    band,
    medianMove: median,
    samples: n,
    rows: rows.map((r) => ({ k: r.k, p: r.windows ? r.survived / r.windows : null })),
  };
}
