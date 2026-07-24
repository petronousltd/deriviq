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
import { DemoTradingSession, STRATEGY } from './trader.js';
import { MarketScanner } from './scanner.js';
import Tools from './Tools.jsx';
import {
  asianStats,
  bandSurvival,
  directionStats,
  extremePositions,
  monotoneRuns,
} from './analysis.js';
import {
  APP_ID,
  REDIRECT_URI,
  beginLogin,
  completeLogin,
  fetchAccounts,
  accountSummary,
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
  const [prices, setPrices] = useState([]);
  const [log, setLog] = useState([]);
  const [token, setToken] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [family, setFamily] = useState('updown');
  const [botEvents, setBotEvents] = useState([]);
  const [botState, setBotState] = useState(null);
  const [scan, setScan] = useState(null);
  const [scanStatus, setScanStatus] = useState('idle');
  const [installPrompt, setInstallPrompt] = useState(null);
  const scannerRef = useRef(null);
  const sessionRef = useRef(null);
  const digitsRef = useRef([]);
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

  useEffect(() => {
    const handler = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => () => scannerRef.current?.stop(), []);

  const toggleScan = () => {
    if (scannerRef.current) {
      scannerRef.current.stop();
      scannerRef.current = null;
      setScanStatus('idle');
      return;
    }
    const scanner = new MarketScanner({
      symbols: symbols.map((entry) => entry.symbol),
      onUpdate: setScan,
      onStatus: (state) => setScanStatus(state),
    });
    scannerRef.current = scanner;
    scanner.start();
  };

  const onInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
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
        setPrices(prices.slice(-MAX_DIGITS));
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
        setPrices((prev) => {
          const next = prev.length >= MAX_DIGITS ? prev.slice(1) : prev.slice();
          next.push(value);
          return next;
        });
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
        sessionRef.current?.onDigit(digit);
      },
      onReset: () => {
        setPrices([]);
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
    sessionRef.current?.stop('instrument changed');
    sessionRef.current = null;
    feedRef.current?.changeSymbol(next);
  };

  const demoAccount = accounts.find((a) => isDemo(a)) ?? null;
  const canTrade = Boolean(token && demoAccount);

  const startBot = () => {
    if (!canTrade || sessionRef.current) return;
    setBotEvents([]);
    try {
      const session = new DemoTradingSession({
        account: demoAccount,
        token,
        symbol,
        onEvent: (e) => setBotEvents((prev) => [e, ...prev].slice(0, 200)),
        onState: (st) => setBotState(st),
      });
      sessionRef.current = session;
      session.start();
    } catch (error) {
      setBotEvents([{ time: '', kind: 'error', detail: error.message }]);
    }
  };

  const stopBot = () => {
    sessionRef.current?.stop('stopped by user');
    sessionRef.current = null;
  };

  const uniformity = useMemo(() => uniformityTest(digits), [digits]);
  const entropy = useMemo(() => shannonEntropy(digits), [digits]);
  const lags = useMemo(() => autocorrelationScan(digits), [digits]);
  const calibration = useMemo(() => calibrate(digits), [digits]);
  const run = useMemo(() => longestRun(digits), [digits]);
  const runs = useMemo(() => runsTest(digits), [digits]);
  const serial = useMemo(() => serialTest(digits), [digits]);
  const board = useMemo(() => scoreboard(digits), [digits]);
  const dir = useMemo(() => directionStats(prices), [prices]);
  const mono = useMemo(() => monotoneRuns(prices), [prices]);
  const extremes = useMemo(() => extremePositions(prices), [prices]);
  const asian = useMemo(() => asianStats(prices), [prices]);
  const survival = useMemo(() => bandSurvival(prices), [prices]);

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
          {installPrompt && (
            <button type="button" className="login" onClick={onInstall}>Install app</button>
          )}
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
            Contract analysis
            <span className="verdict">{prices.length} ticks</span>
          </h2>
          <select value={family} onChange={(e) => setFamily(e.target.value)} style={{ width: '100%', marginBottom: 12 }}>
            <option value="updown">Up/Down · Reset Call/Put</option>
            <option value="onlyups">Only Ups / Only Downs</option>
            <option value="hilo">High/Low Ticks</option>
            <option value="asians">Asians</option>
            <option value="range">Touch/No Touch · In/Out · Accumulators</option>
            <option value="digits">Digits</option>
          </select>

          {family === 'updown' && (
            <>
              <div className="stat-grid">
                <div className="stat"><b>{dir.pUp === null ? '—' : `${(dir.pUp * 100).toFixed(1)}%`}</b><span>ticks up</span></div>
                <div className="stat"><b>{dir.pUpAfterUp === null ? '—' : `${(dir.pUpAfterUp * 100).toFixed(1)}%`}</b><span>up after up</span></div>
                <div className="stat"><b>{dir.pUpAfterDown === null ? '—' : `${(dir.pUpAfterDown * 100).toFixed(1)}%`}</b><span>up after down</span></div>
                <div className="stat"><b className={dir.independent ? '' : 'flag'}>{dir.independent ? 'no' : 'yes'}</b><span>momentum</span></div>
              </div>
              <p className="note">If "up after up" and "up after down" match, direction carries no memory — the exact condition under which Rise/Fall and Reset contracts are fairly priced.</p>
            </>
          )}

          {family === 'onlyups' && (
            <>
              <div className="lags">
                {mono.rows.map((row) => (
                  <div className="lag" key={row.k} style={{ gridTemplateColumns: '70px 1fr 1fr' }}>
                    <span>{row.k} ticks</span>
                    <span className="value" style={{ textAlign: 'left' }}>obs {(row.obsUp * 100).toFixed(1)}% up</span>
                    <span className="value">theory {(row.expUp * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
              <p className="note">Frequency of k consecutive rises, observed vs the independence prediction p^k. Agreement means streaks appear exactly as often as chance dictates — an Only Ups entry has no better odds after any setup.</p>
            </>
          )}

          {family === 'hilo' && (
            <>
              <div className="bars" style={{ height: 90 }}>
                {extremes.hi.map((count, idx) => (
                  <div key={idx} className="bar">
                    <div className="fill" style={{ height: `${(count / Math.max(1, ...extremes.hi)) * 100}%` }} />
                    <span>t{idx + 1}</span>
                  </div>
                ))}
              </div>
              <p className="note">Where the highest tick lands inside 5-tick windows ({extremes.windows} windows). The clustering at the ends is the <strong>arcsine law</strong> — real, expected random-walk physics, and already priced into High/Low Ticks payouts. It is structure you can see but not profit from.</p>
            </>
          )}

          {family === 'asians' && (
            <>
              <div className="stat-grid">
                <div className="stat"><b>{asian.pLastAbove === null ? '—' : `${(asian.pLastAbove * 100).toFixed(1)}%`}</b><span>last above mean</span></div>
                <div className="stat"><b>{asian.windows}</b><span>windows</span></div>
              </div>
              <p className="note">How often the final tick finishes above the 5-tick average. Symmetric ticks keep this near 50% — the assumption Asian contracts are priced on.</p>
            </>
          )}

          {family === 'range' && (
            <>
              <div className="lags">
                {survival.rows.map((row) => (
                  <div className="lag" key={row.k}>
                    <span>{row.k} ticks</span>
                    <div className="track">
                      <div className="centre" style={{ left: '50%' }} />
                      <div className="needle" style={{ left: `${clamp((row.p ?? 0) * 100, 1, 99)}%` }} />
                    </div>
                    <span className="value">{row.p === null ? '—' : `${(row.p * 100).toFixed(0)}%`}</span>
                  </div>
                ))}
              </div>
              <p className="note">Empirical probability the price stays within ±{survival.band ? survival.band.toFixed(4) : '—'} (3× the median tick move) of entry for k consecutive ticks. This survival curve is what Touch/No Touch, In/Out and Accumulator payouts are built from — measured here from your live feed.</p>
            </>
          )}

          {family === 'digits' && (
            <p className="note">Digit contracts (Matches/Differs, Over/Under, Even/Odd) are analysed by the dedicated panels on this page: distribution, uniformity, structure tests, and the live model scoreboard above.</p>
          )}
        </section>

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>
            Auto trader
            <span className={`verdict ${botState?.running ? '' : 'flag'}`}>demo only</span>
          </h2>

          <div className="auth-error" role="note" style={{ marginTop: 0, borderColor: 'var(--rule)' }}>
            <strong>Measured before you run it.</strong> This executes the uploaded
            “Market Wizard OverUnder” strategy on your <strong>demo</strong> account via
            Deriv’s real API. Backtested on 40,000 fair-digit sessions it averages
            <strong> −2.59 units per session</strong>, and its 25-tick bias filter performs
            identically to trading blindly — because, as the Contract analysis panel shows,
            the digits carry no exploitable structure. Real-money trading is deliberately not offered here.
            <span>Strategy: Over/Under {STRATEGY.prediction} · martingale ×{STRATEGY.martingale} · stop +{STRATEGY.profitTarget}/−{STRATEGY.lossLimit} · max stake {STRATEGY.maxStake}</span>
          </div>

          {!token && <p className="note">Log in with Deriv to enable demo auto-trading.</p>}
          {token && !demoAccount && (
            <>
              <p className="note">
                <strong>No demo account found on this login.</strong> Deriv returned {accounts.length} account{accounts.length === 1 ? '' : 's'}, shown raw below so we can see exactly what the API sends. If none is your demo: open app.deriv.com, use the account switcher (top right), select the <strong>Demo</strong> tab — Deriv creates the VRTC demo account there if it doesn’t exist yet — then sign out and back in here.
              </p>
              <div className="log" style={{ maxHeight: 140, marginTop: 10, border: '1px solid var(--grid)', borderRadius: 'var(--radius)' }}>
                {accounts.length === 0 && <div>Account list was empty.</div>}
                {accounts.map((a, i) => (
                  <div key={i}><span className="tag">acct {i + 1}</span><span>{accountSummary(a)}</span></div>
                ))}
              </div>
            </>
          )}

          {canTrade && (
            <>
              <div className="stat-grid" style={{ marginTop: 16 }}>
                <div className="stat"><b className={botState && botState.profit < 0 ? 'flag' : ''}>{botState ? botState.profit.toFixed(2) : '0.00'}</b><span>demo P&L</span></div>
                <div className="stat"><b>{botState ? botState.trades : 0}</b><span>trades</span></div>
                <div className="stat"><b>{botState && botState.trades ? `${((botState.wins / botState.trades) * 100).toFixed(0)}%` : '—'}</b><span>win rate</span></div>
                <div className="stat"><b>{botState ? botState.stake.toFixed(2) : STRATEGY.initialStake.toFixed(2)}</b><span>next stake</span></div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                {!botState?.running ? (
                  <button type="button" className="login" onClick={startBot}>
                    Start on demo ({demoAccount.loginid ?? demoAccount.account_id})
                  </button>
                ) : (
                  <button type="button" className="login" style={{ background: 'var(--alert)', borderColor: 'var(--alert)' }} onClick={stopBot}>
                    Stop
                  </button>
                )}
              </div>

              {botState?.stopped && <p className="note"><strong>Session ended:</strong> {botState.stopped}. This is the strategy’s designed stop behaviour — note whether P&L above is the +{STRATEGY.profitTarget} target or the −{STRATEGY.lossLimit} limit, and how often each occurs across runs.</p>}

              {botEvents.length > 0 && (
                <div className="log" style={{ maxHeight: 220, marginTop: 12, border: '1px solid var(--grid)', borderRadius: 'var(--radius)' }}>
                  {botEvents.map((e, i) => (
                    <div key={i}>
                      <time>{e.time}</time>
                      <span className={`tag ${e.kind === 'error' ? 'error' : ''}`}>{e.kind}</span>
                      <span>{typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <Tools
          digits={digits}
          prices={prices}
          pipSize={pipSize}
          accounts={accounts}
          token={token}
        />

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>
            Market scanner
            <span className={`verdict ${scan?.rows?.some((r) => r.flagged) ? 'flag' : ''}`}>
              {scanStatus === 'scanning' ? `${symbols.length} markets live` : scanStatus}
            </span>
          </h2>

          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button type="button" className="login" onClick={toggleScan}>
              {scannerRef.current ? 'Stop scan' : 'Scan all markets'}
            </button>
          </div>

          {scan?.rows?.length ? (
            <div className="lags">
              {scan.rows.map((row) => (
                <div className="lag" key={row.symbol} style={{ gridTemplateColumns: '132px 68px 1fr 1fr 1fr' }}>
                  <span style={{ color: 'var(--ink)' }}>{nameFor(symbols, row.symbol)}</span>
                  <span>n {row.n}</span>
                  <span className={`value ${row.flagged ? 'out' : ''}`} style={{ textAlign: 'left' }}>
                    uniform {fmtP(row.uniformP)}
                  </span>
                  <span className={`value ${row.flagged ? 'out' : ''}`} style={{ textAlign: 'left' }}>
                    runs {fmtP(row.runsP)}
                  </span>
                  <span className={`value ${row.flagged ? 'out' : ''}`} style={{ textAlign: 'left' }}>
                    markov {row.markovP === null ? '—' : fmtP(row.markovP)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="note">Not scanning. Starting the scan subscribes to every volatility index at once and runs the full randomness battery on each in parallel.</p>
          )}

          <p className="note">
            Every market is tested for digit uniformity, streakiness and digit-to-digit dependence, then ranked worst-first. <strong>A market is only flagged if it beats a Bonferroni-corrected threshold of p &lt; {scan ? (scan.alpha).toFixed(4) : '0.0050'}</strong> — scanning {symbols.length} markets at once means raw p &lt; 0.05 readings appear constantly by pure chance, and treating those as “signals” is exactly how a scanner manufactures confidence it hasn’t earned. Verified against injected dependence: the rigged market ranks first and is flagged, while fair markets showing raw p &lt; 0.05 correctly are not.
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

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? p.toExponential(1) : p.toFixed(3);
}

function nameFor(list, symbol) {
  return list.find((entry) => entry.symbol === symbol)?.display_name ?? symbol;
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
