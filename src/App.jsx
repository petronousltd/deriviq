import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DerivFeed,
  FALLBACK_SYMBOLS,
  lastDigit,
} from './deriv.js';
import {
  autocorrelationScan,
  calibrate,
  longestRun,
  runsTest,
  scoreboard,
  serialTest,
  shannonEntropy,
  uniformityTest,
} from './stats.js';
import {
  APP_ID,
  REDIRECT_URI,
  beginLogin,
  completeLogin,
  fetchAccounts,
  isDemo,
  logout,
  storedToken,
} from './auth.js';

const MAX_DIGITS = 5000;
const TAPE_LENGTH = 48;

const STATUS_TEXT = {
  idle: 'standby',
  connecting: 'connecting',
  open: 'live',
  closed: 'disconnected',
  reconnecting: 'reconnecting',
  error: 'error',
};

export default function App() {
  const [symbols, setSymbols] = useState(FALLBACK_SYMBOLS);
  const [symbol, setSymbol] = useState('R_100');
  const [status, setStatus] = useState('idle');
  const [detail, setDetail] = useState('');
  const [quote, setQuote] = useState(null);
  const [pipSize, setPipSize] = useState(null);
  const [digits, setDigits] = useState([]);
  const [log, setLog] = useState([]);
  const [token, setToken] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const feedRef = useRef(null);
  // History prices arrive as numbers, which drop trailing zeros; seeding digits
  // from them without the instrument's true decimal count systematically
  // undercounts digit 0. Keep the raw prices and re-derive the seed once the
  // first live tick reveals the pip size.
  const historyRef = useRef([]);
  const liveRef = useRef([]);
  const pipRef = useRef(null);
  const reseededRef = useRef(false);

  // Handles the return leg of the OAuth redirect, and restores an existing
  // session on an ordinary page load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAuthBusy(true);
      try {
        const fresh = await completeLogin();
        const active = fresh ?? storedToken();
        if (cancelled || !active) return;
        setToken(active);
        setAccounts(await fetchAccounts(active));
      } catch (error) {
        if (!cancelled) setAuthError(error.message);
      } finally {
        if (!cancelled) setAuthBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onLogin = async () => {
    setAuthError('');
    try {
      await beginLogin();
    } catch (error) {
      setAuthError(error.message);
    }
  };

  const onLogout = () => {
    logout();
    setToken(null);
    setAccounts([]);
  };

  const pushLog = useCallback((entry) => {
    setLog((prev) => [
      { ...entry, payload: stringify(entry.payload) },
      ...prev,
    ].slice(0, 200));
  }, []);

  useEffect(() => {
    const feed = new DerivFeed({
      onStatus: (next, info = '') => {
        setStatus(next);
        setDetail(info);
      },
      onSymbols: (list) => {
        const volatility = list.filter((entry) =>
          /^(R_\d+|1HZ\d+V)$/.test(entry.symbol),
        );
        if (volatility.length) setSymbols(volatility);
      },
      onHistory: (prices) => {
        historyRef.current = prices;
        liveRef.current = [];
        reseededRef.current = false;
        const pip = pipRef.current;
        const seed = prices
          .map((price) => lastDigit(price, pip ?? undefined))
          .filter((digit) => digit !== null);
        if (pip !== null) reseededRef.current = true;
        setDigits(seed.slice(-MAX_DIGITS));
        setQuote(prices[prices.length - 1] ?? null);
      },
      onTick: ({ quote: value, pipSize: pip }) => {
        setQuote(value);
        if (Number.isFinite(pip)) {
          setPipSize(pip);
          pipRef.current = pip;
        }
        const digit = lastDigit(value, pip);
        if (digit === null) return;
        liveRef.current.push(digit);
        if (
          Number.isFinite(pip) &&
          !reseededRef.current &&
          historyRef.current.length
        ) {
          // First tick with a known pip size: rebuild the seed correctly so
          // trailing-zero prices count as digit 0 rather than being skewed.
          reseededRef.current = true;
          const seed = historyRef.current
            .map((price) => lastDigit(price, pip))
            .filter((d) => d !== null);
          setDigits([...seed, ...liveRef.current].slice(-MAX_DIGITS));
          return;
        }
        setDigits((prev) => {
          const next = prev.length >= MAX_DIGITS ? prev.slice(1) : prev.slice();
          next.push(digit);
          return next;
        });
      },
      onReset: () => {
        historyRef.current = [];
        liveRef.current = [];
        pipRef.current = null;
        reseededRef.current = false;
        setDigits([]);
        setQuote(null);
      },
      onLog: pushLog,
    });

    feedRef.current = feed;
    feed.symbol = symbol;
    feed.connect();
    return () => feed.close();
    // Deliberately mounts once; symbol changes are pushed through changeSymbol.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushLog]);

  const onSymbolChange = (event) => {
    const next = event.target.value;
    setSymbol(next);
    setPipSize(null);
    feedRef.current?.changeSymbol(next);
  };

  const uniformity = useMemo(() => uniformityTest(digits), [digits]);
  const entropy = useMemo(() => shannonEntropy(digits), [digits]);
  const lags = useMemo(() => autocorrelationScan(digits), [digits]);
  const calibration = useMemo(() => calibrate(digits), [digits]);
  const run = useMemo(() => longestRun(digits), [digits]);
  const runs = useMemo(() => runsTest(digits), [digits]);
  const serial = useMemo(() => serialTest(digits), [digits]);
  const board = useMemo(() => scoreboard(digits), [digits]);

  const tape = digits.slice(-TAPE_LENGTH);
  const current = digits.length ? digits[digits.length - 1] : null;
  const live = status === 'open';
  const counts = uniformity.counts;
  const peak = Math.max(1, ...counts);
  const anomalous = uniformity.n > 200 && !uniformity.fair;

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            DerivIQ <span>Analyzer</span>
          </h1>
          <p className="tagline">Last-digit randomness instrumentation</p>
        </div>
        <div className="controls">
          <label className="micro" htmlFor="symbol">
            Instrument
          </label>
          <select id="symbol" value={symbol} onChange={onSymbolChange}>
            {symbols.map((entry) => (
              <option key={entry.symbol} value={entry.symbol}>
                {entry.display_name}
              </option>
            ))}
          </select>
          <span className="status">
            <i
              className={`dot ${live ? 'live' : ''} ${
                status === 'error' ? 'warn' : ''
              }`}
            />
            {STATUS_TEXT[status] ?? status}
            {detail ? ` · ${detail}` : ''}
          </span>
          {token ? (
            <span className="account">
              {accounts.length ? (
                <>
                  <b>{accounts[0].loginid ?? accounts[0].account_id}</b>
                  <em>{isDemo(accounts[0]) ? 'demo' : 'real'}</em>
                </>
              ) : (
                <b>signed in</b>
              )}
              <button type="button" onClick={onLogout}>
                Sign out
              </button>
            </span>
          ) : (
            <button type="button" className="login" onClick={onLogin} disabled={authBusy}>
              {authBusy ? 'Checking…' : 'Log in with Deriv'}
            </button>
          )}
        </div>
      </header>

      {authError && (
        <div className="auth-error" role="alert">
          <strong>Login failed.</strong> {authError}
          <span>
            App ID {APP_ID} · redirect {REDIRECT_URI} — this exact URI must be
            registered on the Deriv application.
          </span>
        </div>
      )}

      <section className="readout">
        <div>
          <p className="micro">Quote</p>
          <div className="quote">{formatQuote(quote, pipSize)}</div>
        </div>
        <div className="current-digit">
          <div>
            <p className="micro">Last digit</p>
            <b>{current ?? '–'}</b>
          </div>
        </div>
        <div>
          <p className="micro">Ticks observed</p>
          <div className="quote" style={{ fontSize: 24 }}>
            {digits.length}
          </div>
        </div>
      </section>

      <div className="tape-frame">
        <div className="tape" aria-label="Recent last digits, newest at right">
          {tape.map((digit, index) => (
            <i
              key={`${index}-${digit}`}
              className={index === tape.length - 1 ? 'head' : ''}
            >
              {digit}
            </i>
          ))}
          {tape.length === 0 && <i>·</i>}
        </div>
      </div>

      <div className="panels">
        <section className="panel">
          <h2>
            Digit distribution
            <span className="verdict">n = {uniformity.n}</span>
          </h2>
          <div className="bars">
            {counts.map((count, digit) => (
              <div
                key={digit}
                className={`bar ${count === peak && uniformity.n > 0 ? 'high' : ''}`}
              >
                <div
                  className="fill"
                  style={{ height: `${(count / peak) * 100}%` }}
                />
                <span>{digit}</span>
              </div>
            ))}
          </div>
          <p className="expected-line">
            Expected {(uniformity.n / 10).toFixed(0)} per digit at 10% each
          </p>
        </section>

        <section className="panel">
          <h2>
            Uniformity test
            <span className={`verdict ${anomalous ? 'flag' : ''}`}>
              {uniformity.n < 200
                ? 'gathering'
                : anomalous
                  ? 'deviation'
                  : 'indistinguishable from fair'}
            </span>
          </h2>
          <div className="stat-grid">
            <div className="stat">
              <b>{uniformity.chi2.toFixed(2)}</b>
              <span>χ² df 9</span>
            </div>
            <div className="stat">
              <b className={anomalous ? 'flag' : ''}>
                {uniformity.p < 0.001
                  ? uniformity.p.toExponential(1)
                  : uniformity.p.toFixed(3)}
              </b>
              <span>p-value</span>
            </div>
            <div className="stat">
              <b>{entropy.bits.toFixed(3)}</b>
              <span>bits / {entropy.max.toFixed(2)}</span>
            </div>
            <div className="stat">
              <b>{run}</b>
              <span>longest run</span>
            </div>
          </div>
          <p className="note">
            Tests whether the ten digits depart from a fair 10% each. A p-value
            above 0.05 means the feed is <strong>statistically
            indistinguishable from uniform</strong> — the expected result on a
            secure generator. Only a low p-value would indicate a real skew.
          </p>
        </section>

        <section className="panel">
          <h2>
            Serial correlation
            <span
              className={`verdict ${lags.some((l) => l.outside) ? 'flag' : ''}`}
            >
              lags 1–5
            </span>
          </h2>
          <div className="lags">
            {lags.map(({ lag, r, band, outside }) => (
              <div className="lag" key={lag}>
                <span>lag {lag}</span>
                <div className="track">
                  <div
                    className="band"
                    style={{
                      left: `${50 - Math.min(band, 0.5) * 100}%`,
                      width: `${Math.min(band, 0.5) * 200}%`,
                    }}
                  />
                  <div className="centre" />
                  <div
                    className={`needle ${outside ? 'out' : ''}`}
                    style={{
                      left: `${clamp(50 + r * 100, 1, 99)}%`,
                    }}
                  />
                </div>
                <span className={`value ${outside ? 'out' : ''}`}>
                  {r >= 0 ? '+' : ''}
                  {r.toFixed(3)}
                </span>
              </div>
            ))}
          </div>
          <p className="note">
            Independent draws stay inside the shaded ±2/√N band. A needle
            outside it is the one signal here that would suggest genuinely
            exploitable structure.
          </p>
        </section>

        <section className="panel">
          <h2>
            Structure tests
            <span className={`verdict ${(!runs.ok || (serial.ready && !serial.ok)) ? 'flag' : ''}`}>
              {serial.ready ? (!runs.ok || !serial.ok ? 'structure detected' : 'no structure') : 'gathering'}
            </span>
          </h2>
          <div className="stat-grid">
            <div className="stat"><b className={runs.ok ? '' : 'flag'}>{runs.z.toFixed(2)}</b><span>runs z</span></div>
            <div className="stat"><b className={runs.ok ? '' : 'flag'}>{runs.p.toFixed(3)}</b><span>runs p</span></div>
            <div className="stat"><b className={serial.ok ? '' : 'flag'}>{serial.chi2.toFixed(0)}</b><span>markov chi-sq df {serial.df}</span></div>
            <div className="stat"><b className={serial.ok ? '' : 'flag'}>{serial.p < 0.001 ? serial.p.toExponential(1) : serial.p.toFixed(3)}</b><span>markov p</span></div>
          </div>
          <p className="note">
            The Wald–Wolfowitz runs test catches streakiness; the Markov test checks the full 10×10 digit→next-digit transition matrix against uniformity. <strong>Any genuinely predictable dependence between digits would surface here as a red p-value.</strong> Verified against synthetic dependent data: injected structure is detected at p ≈ 0.
          </p>
        </section>

        <section className="panel">
          <h2>
            Model scoreboard
            <span className="verdict">{board.scored ? `${board.scored} scored` : 'gathering'}</span>
          </h2>
          <div className="lags">
            {board.entries.map((entry) => (
              <div className="lag" key={entry.id}>
                <span style={{ width: 96 }}>{entry.label}</span>
                <div className="track">
                  <div className="band" style={{ left: '5%', width: '10%' }} />
                  <div className="centre" style={{ left: '10%' }} />
                  <div className={`needle ${entry.rate !== null && entry.rate > 0.13 ? 'out' : ''}`} style={{ left: `${clamp((entry.rate ?? 0) * 100, 1, 99)}%` }} />
                </div>
                <span className="value">{entry.rate === null ? '—' : `${(entry.rate * 100).toFixed(1)}%`}</span>
              </div>
            ))}
          </div>
          <p className="note">
            Four models — hot digit, cold digit, an online-learned Markov predictor, and repeat-last — each forecast every next digit using only prior data, scored against what actually happened. The marker at 10% is chance. <strong>On an independent RNG all four converge there; a model staying meaningfully above it would be the first real evidence of an edge.</strong>
          </p>
        </section>

        <section className="panel">
          <h2>
            Predictability check
            <span className="verdict">
              {calibration.scored ? `${calibration.scored} scored` : 'gathering'}
            </span>
          </h2>
          <div className="stat-grid">
            <div className="stat">
              <b>
                {calibration.rate === null
                  ? '—'
                  : `${(calibration.rate * 100).toFixed(1)}%`}
              </b>
              <span>hit rate</span>
            </div>
            <div className="stat">
              <b>10.0%</b>
              <span>chance</span>
            </div>
            <div className="stat">
              <b>
                {calibration.rate === null
                  ? '—'
                  : `${((calibration.rate - 0.1) * 100).toFixed(1)}pp`}
              </b>
              <span>edge</span>
            </div>
          </div>
          <p className="note">
            This continuously backtests the most common trading heuristic —
            betting on the hottest digit of the last 50 ticks — against what
            actually came next. <strong>If any edge existed, it would show up
            here as a hit rate above 10%.</strong> Watch this number before
            trusting any signal, including your own.
          </p>
        </section>
      </div>

      <details>
        <summary>Connection log ({log.length})</summary>
        <div className="log">
          {log.length === 0 && <div>No frames yet.</div>}
          {log.map((entry, index) => (
            <div key={index}>
              <time>{entry.time}</time>
              <span className={`tag ${entry.direction}`}>
                {entry.direction}
              </span>
              <span>{entry.payload}</span>
            </div>
          ))}
        </div>
      </details>

      <footer className="colophon">
        <p>
          <strong>What this is.</strong> A measurement instrument for Deriv
          volatility indices. It reads the public tick feed, extracts the last
          digit of each quote, and reports what the sample actually contains:
          distribution, uniformity, serial correlation, and whether the standard
          hot-digit heuristic beats chance.
        </p>
        <p>
          <strong>What it is not.</strong> A predictor. Deriv&apos;s volatility
          indices are generated by a cryptographically secure random number
          generator, so each digit is independent of every digit before it. No
          model can raise the odds above the contract&apos;s fixed baseline, and
          this app makes no attempt to claim otherwise — the panels above are
          built to show you that honestly rather than to sell you a signal.
          Trade only what you can afford to lose.
        </p>
      </footer>
    </div>
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatQuote(quote, pipSize) {
  if (!Number.isFinite(quote)) return '––––';
  const text = Number.isFinite(pipSize) ? quote.toFixed(pipSize) : String(quote);
  return (
    <>
      {text.slice(0, -1)}
      <span className="tail">{text.slice(-1)}</span>
    </>
  );
}

function stringify(payload) {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
