// Deriv contract families and the parameters each one requires.
//
// These are Deriv's own documented contract types — public API surface, not
// anyone's proprietary configuration. `baseline` records the mathematically
// fixed win probability where one exists; it is null where the probability
// depends on barrier, duration and current price rather than being fixed.

export const CONTRACT_FAMILIES = [
  {
    id: 'rise_fall',
    label: 'Rise/Fall',
    sides: [
      { code: 'CALL', label: 'Rise' },
      { code: 'PUT', label: 'Fall' },
    ],
    params: ['symbol', 'stake', 'duration'],
    baseline: null,
    note: 'Settles on whether the exit price is above or below the entry price.',
  },
  {
    id: 'higher_lower',
    label: 'Higher/Lower',
    sides: [
      { code: 'CALL', label: 'Higher' },
      { code: 'PUT', label: 'Lower' },
    ],
    params: ['symbol', 'stake', 'duration', 'barrier'],
    baseline: null,
    note: 'As Rise/Fall, but measured against a barrier you choose.',
  },
  {
    id: 'touch_no_touch',
    label: 'Touch/No Touch',
    sides: [
      { code: 'ONETOUCH', label: 'Touch' },
      { code: 'NOTOUCH', label: 'No Touch' },
    ],
    params: ['symbol', 'stake', 'duration', 'barrier'],
    baseline: null,
    note: 'Whether the barrier is touched at any point before expiry.',
  },
  {
    id: 'matches_differs',
    label: 'Matches/Differs',
    sides: [
      { code: 'DIGITMATCH', label: 'Matches', baseline: 0.1 },
      { code: 'DIGITDIFF', label: 'Differs', baseline: 0.9 },
    ],
    params: ['symbol', 'stake', 'duration', 'digit'],
    baseline: 0.1,
    note: 'Last digit of the exit quote against a digit you nominate.',
  },
  {
    id: 'over_under',
    label: 'Over/Under',
    sides: [
      { code: 'DIGITOVER', label: 'Over' },
      { code: 'DIGITUNDER', label: 'Under' },
    ],
    params: ['symbol', 'stake', 'duration', 'digit'],
    baseline: null,
    note: 'Baseline varies with the barrier digit: Over 3 wins on 4-9, so 0.6.',
  },
  {
    id: 'even_odd',
    label: 'Even/Odd',
    sides: [
      { code: 'DIGITEVEN', label: 'Even', baseline: 0.5 },
      { code: 'DIGITODD', label: 'Odd', baseline: 0.5 },
    ],
    params: ['symbol', 'stake', 'duration'],
    baseline: 0.5,
    note: 'Parity of the last digit. Note 0 counts as even.',
  },
  {
    id: 'accumulators',
    label: 'Accumulators',
    sides: [{ code: 'ACCU', label: 'Accumulate' }],
    params: ['symbol', 'stake', 'growth_rate'],
    baseline: null,
    note: 'Compounds while price stays inside a range; ends the moment it leaves.',
  },
  {
    id: 'multipliers',
    label: 'Multipliers',
    sides: [
      { code: 'MULTUP', label: 'Up' },
      { code: 'MULTDOWN', label: 'Down' },
    ],
    params: ['symbol', 'stake', 'multiplier'],
    baseline: null,
    note: 'Leveraged exposure. Losses are capped at the stake.',
  },
  {
    id: 'turbos',
    label: 'Turbos',
    sides: [
      { code: 'TURBOSLONG', label: 'Long' },
      { code: 'TURBOSSHORT', label: 'Short' },
    ],
    params: ['symbol', 'stake', 'duration', 'barrier'],
    baseline: null,
    note: 'Leveraged with a knock-out barrier that ends the contract if hit.',
  },
  {
    id: 'vanillas',
    label: 'Vanillas',
    sides: [
      { code: 'VANILLALONGCALL', label: 'Call' },
      { code: 'VANILLALONGPUT', label: 'Put' },
    ],
    params: ['symbol', 'stake', 'duration', 'barrier'],
    baseline: null,
    note: 'Payout scales with how far past the strike the price finishes.',
  },
];

/** Digit families run on the RNG feed and have fixed, unbeatable baselines. */
export const DIGIT_FAMILIES = new Set([
  'matches_differs',
  'over_under',
  'even_odd',
]);

export function familyById(id) {
  return CONTRACT_FAMILIES.find((family) => family.id === id) ?? null;
}

/**
 * Win probability for Over/Under, which depends on the barrier digit.
 * DIGITOVER n wins on digits n+1..9; DIGITUNDER n wins on 0..n-1.
 */
export function overUnderBaseline(code, digit) {
  if (code === 'DIGITOVER') return (9 - digit) / 10;
  if (code === 'DIGITUNDER') return digit / 10;
  return null;
}

/** Builds a `proposal` request for live pricing. */
export function proposalRequest({
  code,
  symbol,
  stake,
  duration = 5,
  durationUnit = 't',
  digit,
  barrier,
  multiplier,
  growthRate,
  currency = 'USD',
}) {
  const request = {
    proposal: 1,
    contract_type: code,
    underlying_symbol: symbol,
    amount: Number(stake),
    basis: 'stake',
    currency,
  };

  if (code.startsWith('MULT')) {
    request.multiplier = Number(multiplier);
  } else if (code === 'ACCU') {
    request.growth_rate = Number(growthRate);
  } else {
    request.duration = Number(duration);
    request.duration_unit = durationUnit;
  }

  if (digit !== undefined && digit !== null) request.barrier = String(digit);
  else if (barrier !== undefined && barrier !== null) request.barrier = String(barrier);

  return request;
}

/** Buys a previously priced proposal. `price` caps what you are willing to pay. */
export function buyRequest(proposalId, price) {
  return { buy: proposalId, price: Number(price) };
}
