// Maths for the Charts, Analysis and Risk Calculator panels.
//
// Everything here is descriptive or arithmetic. Nothing forecasts a digit,
// because on this feed nothing can.

import { digitCounts } from './stats.js';

/* ---------- distribution analysis ---------- */

/** Current and longest run of the same digit. */
export function streaks(digits) {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < digits.length; i++) {
    current = i > 0 && digits[i] === digits[i - 1] ? current + 1 : 1;
    if (current > longest) longest = current;
  }
  return { current: digits.length ? current : 0, longest };
}

/** Even/odd split against the 50% baseline. */
export function evenOdd(digits) {
  let even = 0;
  for (const d of digits) if (d % 2 === 0) even += 1;
  const n = digits.length;
  return {
    n,
    even,
    odd: n - even,
    pEven: n ? even / n : null,
    baseline: 0.5,
  };
}

/**
 * Over/Under for a barrier digit. Deriv settles strictly: Over N wins on
 * digits > N, Under N wins on digits < N, and exactly N loses both.
 */
export function overUnder(digits, barrier) {
  const n = digits.length;
  let over = 0;
  let under = 0;
  let equal = 0;
  for (const d of digits) {
    if (d > barrier) over += 1;
    else if (d < barrier) under += 1;
    else equal += 1;
  }
  return {
    n,
    barrier,
    over,
    under,
    equal,
    pOver: n ? over / n : null,
    pUnder: n ? under / n : null,
    theoryOver: (9 - barrier) / 10,
    theoryUnder: barrier / 10,
  };
}

/** Per-digit deviation from the expected 10%, for the heatmap. */
export function heatmap(digits) {
  const n = digits.length;
  const counts = digitCounts(digits);
  const expected = n / 10;
  return counts.map((count, digit) => ({
    digit,
    count,
    share: n ? count / n : 0,
    deviation: n ? count / n - 0.1 : 0,
    // standardised residual: how many standard errors from fair
    z: n ? (count - expected) / Math.sqrt(n * 0.1 * 0.9) : 0,
  }));
}

/* ---------- risk arithmetic ---------- */

/**
 * The break-even win rate a strategy needs, given the payout ratio R
 * (total return divided by stake on a win). Win w of the time:
 *   w * (R - 1) = (1 - w)  =>  w = 1 / R
 */
export function breakEvenWinRate(payoutRatio) {
  return payoutRatio > 0 ? 1 / payoutRatio : null;
}

/**
 * Deriv prices digit contracts at roughly a 95% return of the fair payout,
 * so the payout ratio on a contract with true probability p is 0.95 / p.
 */
export function payoutRatioFor(probability, houseReturn = 0.95) {
  return probability > 0 ? houseReturn / probability : null;
}

/**
 * Martingale ladder. For each step: the stake, the cumulative amount risked,
 * and the balance needed to reach that step at all.
 */
export function martingaleLadder({
  baseStake = 1,
  multiplier = 2.2,
  steps = 8,
  balance = 100,
  winProbability = 0.5,
} = {}) {
  const rows = [];
  let stake = baseStake;
  let cumulative = 0;
  let ruinStep = null;

  for (let step = 1; step <= steps; step++) {
    cumulative += stake;
    const survivable = cumulative <= balance;
    if (!survivable && ruinStep === null) ruinStep = step;
    rows.push({
      step,
      stake,
      cumulative,
      balanceRequired: cumulative,
      survivable,
      // probability of losing this many in a row
      probability: Math.pow(1 - winProbability, step),
    });
    stake *= multiplier;
  }

  const maxDrawdown = cumulative;
  const payoutRatio = payoutRatioFor(winProbability);
  const required = breakEvenWinRate(payoutRatio);

  return {
    rows,
    maxDrawdown,
    ruinStep,
    winProbability,
    payoutRatio,
    requiredWinRate: required,
    // negative means the contract cannot clear its own break-even point
    edge: required === null ? null : winProbability - required,
    probabilityOfRuin: ruinStep === null
      ? Math.pow(1 - winProbability, steps)
      : Math.pow(1 - winProbability, ruinStep),
  };
}
