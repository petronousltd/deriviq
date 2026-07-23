// Statistical tests for a stream of last-digits (0-9).
// No dependencies: the incomplete gamma function is implemented directly so the
// chi-square p-value is exact rather than table-interpolated.

const GAMMA_COEF = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];

function gammaln(x) {
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += GAMMA_COEF[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Regularised lower incomplete gamma P(a,x) via series expansion.
function gammaSeries(a, x) {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < 200; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
}

// Regularised upper incomplete gamma Q(a,x) via continued fraction.
function gammaContinuedFraction(a, x) {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}

// Upper tail probability Q(a,x) = P(X > x).
function gammaQ(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - gammaSeries(a, x);
  return gammaContinuedFraction(a, x);
}

/** p-value for a chi-square statistic with `df` degrees of freedom. */
export function chiSquarePValue(chi2, df) {
  if (!Number.isFinite(chi2) || chi2 < 0) return NaN;
  return gammaQ(df / 2, chi2 / 2);
}

/** Frequency of each digit 0-9. */
export function digitCounts(digits) {
  const counts = new Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d] += 1;
  return counts;
}

/**
 * Goodness-of-fit against a uniform 10%-each distribution.
 * A fair RNG should sit comfortably above p = 0.05.
 */
export function uniformityTest(digits) {
  const n = digits.length;
  const counts = digitCounts(digits);
  if (n === 0) return { chi2: 0, df: 9, p: 1, n: 0, counts, fair: true };
  const expected = n / 10;
  let chi2 = 0;
  for (let d = 0; d < 10; d++) {
    const diff = counts[d] - expected;
    chi2 += (diff * diff) / expected;
  }
  const p = chiSquarePValue(chi2, 9);
  return { chi2, df: 9, p, n, counts, fair: p >= 0.05 };
}

/** Shannon entropy in bits. Maximum for 10 equally likely digits is log2(10). */
export function shannonEntropy(digits) {
  const n = digits.length;
  if (n === 0) return { bits: 0, max: Math.log2(10) };
  const counts = digitCounts(digits);
  let bits = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / n;
    bits -= p * Math.log2(p);
  }
  return { bits, max: Math.log2(10) };
}

/**
 * Pearson autocorrelation of the digit series at a given lag.
 * Independent draws produce values inside a +/- 2/sqrt(N) white-noise band.
 */
export function autocorrelation(digits, lag) {
  const n = digits.length;
  if (n <= lag + 1) return 0;
  let mean = 0;
  for (const d of digits) mean += d;
  mean /= n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dev = digits[i] - mean;
    denominator += dev * dev;
    if (i + lag < n) numerator += dev * (digits[i + lag] - mean);
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** The white-noise band. Values outside it suggest genuine structure. */
export function noiseBand(n) {
  return n > 0 ? 2 / Math.sqrt(n) : 0;
}

export function autocorrelationScan(digits, lags = [1, 2, 3, 4, 5]) {
  const band = noiseBand(digits.length);
  return lags.map((lag) => {
    const r = autocorrelation(digits, lag);
    return { lag, r, band, outside: Math.abs(r) > band && digits.length > 30 };
  });
}

/**
 * Scores a naive "bet on the most frequent recent digit" strategy against what
 * actually came next. On a fair RNG this converges to 10% no matter how
 * confident the frequency gap looks -- which is the point of showing it.
 */
export function calibrate(digits, window = 50) {
  if (digits.length < window + 2) {
    return { scored: 0, hits: 0, rate: null, baseline: 0.1 };
  }
  let scored = 0;
  let hits = 0;
  for (let i = window; i < digits.length - 1; i++) {
    const slice = digits.slice(i - window, i);
    const counts = digitCounts(slice);
    let best = 0;
    for (let d = 1; d < 10; d++) if (counts[d] > counts[best]) best = d;
    scored += 1;
    if (digits[i + 1] === best) hits += 1;
  }
  return {
    scored,
    hits,
    rate: scored > 0 ? hits / scored : null,
    baseline: 0.1,
  };
}

/** Longest run of consecutive identical digits. */
export function longestRun(digits) {
  let best = 0;
  let current = 0;
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && digits[i] === digits[i - 1]) current += 1;
    else current = 1;
    if (current > best) best = current;
  }
  return best;
}
