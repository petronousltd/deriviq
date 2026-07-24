// Market scanner — runs the full randomness battery across every volatility
// index simultaneously and ranks them by how far each departs from fair.
//
// This is the honest form of a "market scanner". It does not emit signals,
// pressure readings or entry calls: on a CSPRNG feed those are noise dressed
// as information. It answers the only question a scanner can honestly answer —
// "is any market measurably behaving differently from a fair generator right
// now?" — and applies a Bonferroni correction, because scanning ten markets at
// once means roughly one in two scans would show a p < 0.05 by pure chance.

import { PUBLIC_WS_URL, FALLBACK_SYMBOLS, lastDigit } from './deriv.js';
import { uniformityTest, runsTest, serialTest } from './stats.js';

const CANDIDATES = (symbol) => [
  { ticks: { underlying_symbol: symbol }, subscribe: 1 },
  { ticks: symbol, subscribe: 1 },
  { ticks: { symbol }, subscribe: 1 },
];

function symbolOf(msg) {
  const tick = msg.tick ?? msg.data?.tick ?? {};
  const echo = msg.echo_req ?? {};
  return (
    tick.underlying_symbol ??
    tick.symbol ??
    echo.ticks?.underlying_symbol ??
    echo.ticks?.symbol ??
    (typeof echo.ticks === 'string' ? echo.ticks : null)
  );
}

export class MarketScanner {
  constructor({ symbols, onUpdate, onStatus } = {}) {
    this.symbols = (symbols?.length ? symbols : FALLBACK_SYMBOLS.map((s) => s.symbol)).slice(0, 12);
    this.onUpdate = onUpdate ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.digits = new Map(this.symbols.map((s) => [s, []]));
    this.pips = new Map();
    this.attempt = new Map(this.symbols.map((s) => [s, 0]));
    this.ws = null;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.onStatus('connecting');
    try {
      this.ws = new WebSocket(PUBLIC_WS_URL);
    } catch (error) {
      this.onStatus('error', String(error.message ?? error));
      return;
    }

    this.ws.onopen = () => {
      this.running = true;
      this.onStatus('scanning');
      for (const symbol of this.symbols) this.subscribe(symbol);
      this.heartbeat = setInterval(() => this.send({ ping: 1 }), 20000);
      this.timer = setInterval(() => this.publish(), 1000);
    };

    this.ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.receive(msg);
    };

    this.ws.onerror = () => this.onStatus('error', 'socket error');
    this.ws.onclose = () => {
      this.running = false;
      clearInterval(this.heartbeat);
      clearInterval(this.timer);
      this.onStatus('stopped');
    };
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  subscribe(symbol) {
    const index = this.attempt.get(symbol) ?? 0;
    const list = CANDIDATES(symbol);
    if (index >= list.length) return;
    this.send(list[index]);
  }

  receive(msg) {
    if (msg.ping || msg.pong) return;

    if (msg.error) {
      const symbol = symbolOf(msg);
      if (symbol && this.attempt.has(symbol)) {
        this.attempt.set(symbol, (this.attempt.get(symbol) ?? 0) + 1);
        this.subscribe(symbol);
      }
      return;
    }

    const tick = msg.tick ?? msg.data?.tick ?? null;
    if (!tick) return;
    const symbol = symbolOf(msg);
    if (!symbol || !this.digits.has(symbol)) return;

    const raw = tick.quote ?? tick.price ?? tick.value;
    const quote = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(quote)) return;

    const pip = tick.pip_size ?? tick.pipSize;
    if (Number.isFinite(pip)) this.pips.set(symbol, pip);

    const digit = lastDigit(quote, this.pips.get(symbol));
    if (digit === null) return;

    const list = this.digits.get(symbol);
    list.push(digit);
    if (list.length > 3000) list.shift();
  }

  /** Ranked results, most anomalous first. */
  results() {
    const tests = this.symbols.length;
    const alpha = 0.05 / tests; // Bonferroni threshold for the whole scan
    const rows = this.symbols.map((symbol) => {
      const digits = this.digits.get(symbol) ?? [];
      const uniform = uniformityTest(digits);
      const runs = runsTest(digits);
      const serial = serialTest(digits);
      const worst = Math.min(
        Number.isFinite(uniform.p) ? uniform.p : 1,
        Number.isFinite(runs.p) ? runs.p : 1,
        serial.ready && Number.isFinite(serial.p) ? serial.p : 1,
      );
      return {
        symbol,
        n: digits.length,
        uniformP: uniform.p,
        runsP: runs.p,
        markovP: serial.ready ? serial.p : null,
        worst,
        ready: digits.length >= 300,
        flagged: digits.length >= 300 && worst < alpha,
      };
    });
    rows.sort((a, b) => a.worst - b.worst);
    return { rows, alpha, tests };
  }

  publish() {
    this.onUpdate(this.results());
  }

  stop() {
    this.running = false;
    clearInterval(this.heartbeat);
    clearInterval(this.timer);
    this.ws?.close();
  }
}
