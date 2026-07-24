import { useMemo, useState } from 'react';
import { evenOdd, heatmap, martingaleLadder, overUnder, streaks } from './tools.js';
import { isDemo } from './auth.js';

const TABS = [
  { id: 'chart', label: 'Charts' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'risk', label: 'Risk calculator' },
  { id: 'account', label: 'Account' },
];

export default function Tools({ digits, prices, pipSize, accounts, token }) {
  const [tab, setTab] = useState('chart');

  return (
    <section className="panel" style={{ gridColumn: '1 / -1' }}>
      <h2>
        Tools
        <span className="verdict">{TABS.find((t) => t.id === tab)?.label}</span>
      </h2>

      <div className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tab ${tab === entry.id ? 'active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'chart' && <ChartTab prices={prices} digits={digits} pipSize={pipSize} />}
      {tab === 'analysis' && <AnalysisTab digits={digits} />}
      {tab === 'risk' && <RiskTab />}
      {tab === 'account' && <AccountTab accounts={accounts} token={token} />}
    </section>
  );
}

/* ---------- charts ---------- */

function ChartTab({ prices, digits, pipSize }) {
  const window = prices.slice(-300);
  const path = useMemo(() => {
    if (window.length < 2) return null;
    const min = Math.min(...window);
    const max = Math.max(...window);
    const span = max - min || 1;
    const step = 960 / (window.length - 1);
    return {
      min,
      max,
      d: window
        .map((price, i) => {
          const x = i * step;
          const y = 180 - ((price - min) / span) * 170 - 5;
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' '),
    };
  }, [window]);

  if (!path) return <p className="note">Waiting for ticks.</p>;

  const decimals = Number.isFinite(pipSize) ? pipSize : 3;

  return (
    <>
      <svg viewBox="0 0 960 190" className="chart" role="img" aria-label="Recent quotes">
        <line x1="0" y1="5" x2="960" y2="5" stroke="var(--grid)" strokeWidth="1" />
        <line x1="0" y1="92" x2="960" y2="92" stroke="var(--grid)" strokeWidth="1" strokeDasharray="4 6" />
        <line x1="0" y1="180" x2="960" y2="180" stroke="var(--grid)" strokeWidth="1" />
        <path d={path.d} fill="none" stroke="var(--signal)" strokeWidth="1.5" />
      </svg>
      <div className="chart-scale">
        <span>{path.max.toFixed(decimals)}</span>
        <span>{window.length} ticks</span>
        <span>{path.min.toFixed(decimals)}</span>
      </div>
      <div className="tape" style={{ marginTop: 10, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
        {digits.slice(-60).map((digit, index) => (
          <i key={index}>{digit}</i>
        ))}
      </div>
      <p className="note">
        The quote path for the last {window.length} ticks, with the corresponding last digits beneath. The
        line is the price; the digits are what digit contracts actually settle on.
      </p>
    </>
  );
}

/* ---------- analysis ---------- */

function AnalysisTab({ digits }) {
  const [barrier, setBarrier] = useState(4);
  const cells = useMemo(() => heatmap(digits), [digits]);
  const run = useMemo(() => streaks(digits), [digits]);
  const parity = useMemo(() => evenOdd(digits), [digits]);
  const ou = useMemo(() => overUnder(digits, barrier), [digits, barrier]);

  return (
    <>
      <div className="heat">
        {cells.map((cell) => (
          <div
            key={cell.digit}
            className={`cell ${Math.abs(cell.z) > 3 ? 'hot' : ''}`}
            style={{ background: shade(cell.z) }}
            title={`z = ${cell.z.toFixed(2)}`}
          >
            <b>{cell.digit}</b>
            <span>{(cell.share * 100).toFixed(1)}%</span>
            <em>{cell.count}</em>
          </div>
        ))}
      </div>
      <p className="note" style={{ marginTop: 10 }}>
        Shading is the standardised residual, not the raw count: how many standard errors each digit sits
        from a fair 10%. Colour appears at every sample size; only <strong>|z| above 3</strong> is unusual,
        and it is outlined then.
      </p>

      <div className="stat-grid" style={{ marginTop: 16 }}>
        <div className="stat"><b>{run.current}</b><span>current streak</span></div>
        <div className="stat"><b>{run.longest}</b><span>longest streak</span></div>
        <div className="stat"><b>{parity.pEven === null ? '—' : `${(parity.pEven * 100).toFixed(1)}%`}</b><span>even / 50.0%</span></div>
        <div className="stat"><b>{parity.pEven === null ? '—' : `${((1 - parity.pEven) * 100).toFixed(1)}%`}</b><span>odd / 50.0%</span></div>
        <div className="stat"><b>{digits.length}</b><span>sample</span></div>
      </div>

      <div className="bars" style={{ marginTop: 18, height: 110 }}>
        {cells.map((cell) => (
          <div key={cell.digit} className="bar">
            <div className="fill" style={{ height: `${Math.min(100, cell.share * 700)}%` }} />
            <span>{cell.digit}</span>
          </div>
        ))}
      </div>
      <p className="expected-line">Matches pays on one digit in ten; every bar is measured against that same 10%</p>
      <p className="note">
        Matches wins at 10% and Differs at 90%, fixed by the contract. Even/Odd sits at 50%.{' '}
        <strong>These are not estimates that drift — they are the definition of the contract, and the
        observed bars converge onto them.</strong>
      </p>

      <div className="barrier-row">
        <span className="micro">Barrier digit</span>
        <select value={barrier} onChange={(e) => setBarrier(Number(e.target.value))}>
          {Array.from({ length: 10 }, (_, d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      <div className="lags" style={{ marginTop: 10 }}>
        <div className="lag" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
          <span>Over {barrier}</span>
          <span className="value" style={{ textAlign: 'left' }}>obs {ou.pOver === null ? '—' : `${(ou.pOver * 100).toFixed(1)}%`}</span>
          <span className="value">theory {(ou.theoryOver * 100).toFixed(0)}%</span>
        </div>
        <div className="lag" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
          <span>Under {barrier}</span>
          <span className="value" style={{ textAlign: 'left' }}>obs {ou.pUnder === null ? '—' : `${(ou.pUnder * 100).toFixed(1)}%`}</span>
          <span className="value">theory {(ou.theoryUnder * 100).toFixed(0)}%</span>
        </div>
        <div className="lag" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
          <span>Exactly {barrier}</span>
          <span className="value" style={{ textAlign: 'left' }}>obs {ou.n ? `${((ou.equal / ou.n) * 100).toFixed(1)}%` : '—'}</span>
          <span className="value">theory 10%</span>
        </div>
      </div>
      <p className="note">
        Over {barrier} wins on digits above {barrier}, Under {barrier} on digits below it, and exactly{' '}
        {barrier} loses both — which is where the house edge on this contract lives. Observed sits beside
        theory so you can see the difference is sampling noise.
      </p>
    </>
  );
}

function shade(z) {
  const clamped = Math.max(-4, Math.min(4, z));
  const alpha = Math.min(Math.abs(clamped) / 5, 0.55);
  return clamped >= 0
    ? `rgba(46, 74, 92, ${alpha})`
    : `rgba(191, 61, 38, ${alpha})`;
}

/* ---------- risk calculator ---------- */

function RiskTab() {
  const [baseStake, setBaseStake] = useState(1);
  const [multiplier, setMultiplier] = useState(2.2);
  const [steps, setSteps] = useState(8);
  const [balance, setBalance] = useState(100);
  const [winProbability, setWinProbability] = useState(0.5);

  const ladder = useMemo(
    () => martingaleLadder({ baseStake, multiplier, steps, balance, winProbability }),
    [baseStake, multiplier, steps, balance, winProbability],
  );

  const gap = ladder.edge ?? 0;

  return (
    <>
      <div className="inputs">
        <label>Base stake<input type="number" min="0.35" step="0.05" value={baseStake} onChange={(e) => setBaseStake(Number(e.target.value) || 0)} /></label>
        <label>Multiplier<input type="number" min="1" step="0.1" value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value) || 1)} /></label>
        <label>Steps<input type="number" min="1" max="20" value={steps} onChange={(e) => setSteps(Math.min(20, Number(e.target.value) || 1))} /></label>
        <label>Balance<input type="number" min="1" value={balance} onChange={(e) => setBalance(Number(e.target.value) || 0)} /></label>
        <label>Win probability<input type="number" min="0.05" max="0.95" step="0.05" value={winProbability} onChange={(e) => setWinProbability(Number(e.target.value) || 0.5)} /></label>
      </div>

      <div className="stat-grid" style={{ marginTop: 16 }}>
        <div className="stat"><b>{(ladder.requiredWinRate * 100).toFixed(2)}%</b><span>win rate needed</span></div>
        <div className="stat"><b>{(winProbability * 100).toFixed(2)}%</b><span>actual probability</span></div>
        <div className="stat"><b className={gap < 0 ? 'flag' : ''}>{(gap * 100).toFixed(2)}pp</b><span>edge</span></div>
        <div className="stat"><b className={ladder.ruinStep ? 'flag' : ''}>{ladder.maxDrawdown.toFixed(2)}</b><span>total at risk</span></div>
      </div>

      <div className="ladder">
        <div className="ladder-head">
          <span>step</span><span>stake</span><span>cumulative</span><span>P(streak)</span>
        </div>
        {ladder.rows.map((row) => (
          <div className={`ladder-row ${row.survivable ? '' : 'over'}`} key={row.step}>
            <span>{row.step}</span>
            <span>{row.stake.toFixed(2)}</span>
            <span>{row.cumulative.toFixed(2)}</span>
            <span>{(row.probability * 100).toFixed(2)}%</span>
          </div>
        ))}
      </div>

      <p className="note">
        The payout ratio on a contract with probability {(winProbability * 100).toFixed(0)}% is{' '}
        {ladder.payoutRatio.toFixed(3)}, so breaking even needs{' '}
        <strong>{(ladder.requiredWinRate * 100).toFixed(2)}%</strong> of trades to win while the contract
        delivers {(winProbability * 100).toFixed(2)}%.{' '}
        {gap < 0 && (
          <strong>
            That {Math.abs(gap * 100).toFixed(2)}pp shortfall is fixed — no staking pattern changes it,
            because each trade is independent and martingale only redistributes when the losses arrive.
          </strong>
        )}{' '}
        {ladder.ruinStep
          ? `A balance of ${balance} is exhausted at step ${ladder.ruinStep}, which occurs with probability ${(Math.pow(1 - winProbability, ladder.ruinStep) * 100).toFixed(2)}% — roughly once every ${Math.round(1 / Math.pow(1 - winProbability, ladder.ruinStep))} sequences.`
          : `A balance of ${balance} survives all ${steps} steps, needing ${ladder.maxDrawdown.toFixed(2)} in total.`}
      </p>
    </>
  );
}

/* ---------- account (read only) ---------- */

function AccountTab({ accounts, token }) {
  if (!token) return <p className="note">Log in with Deriv to see your accounts.</p>;
  if (!accounts.length) return <p className="note">No accounts returned for this login.</p>;

  return (
    <>
      <div className="lags">
        {accounts.map((account, index) => {
          const id = account.loginid ?? account.account_id ?? account.id ?? `account ${index + 1}`;
          const balance = account.balance ?? account.amount ?? null;
          return (
            <div className="lag" key={id} style={{ gridTemplateColumns: '150px 90px 1fr' }}>
              <span style={{ color: 'var(--ink)' }}>{id}</span>
              <span className="verdict" style={{ justifySelf: 'start' }}>{isDemo(account) ? 'demo' : 'real'}</span>
              <span className="value" style={{ textAlign: 'left' }}>
                {balance === null ? 'balance not in this response' : `${Number(balance).toFixed(2)} ${account.currency ?? ''}`}
              </span>
            </div>
          );
        })}
      </div>
      <p className="note">
        Read only. This panel lists what Deriv returns for your login and nothing here can open, modify or
        sell a position.
      </p>
    </>
  );
}
