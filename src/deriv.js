// Live market-data feed for Deriv volatility indices.
//
// Public market data needs no authentication and no OTP -- it is served
// directly from the public WebSocket. Only trading requires a token, and this
// analyzer deliberately does not trade, so it never asks for one.
//
// Deriv has been migrating its request format, so each request is expressed as
// an ordered list of candidate shapes. If the server rejects the first, the
// client automatically retries the next and remembers which one worked. Every
// frame is recorded in a log the UI displays, so a failure is visible rather
// than silent.

export const PUBLIC_WS_URL =
  'wss://api.derivws.com/trading/v1/options/ws/public';

/** Used until active_symbols responds; keeps the app usable if it never does. */
export const FALLBACK_SYMBOLS = [
  { symbol: 'R_10', display_name: 'Volatility 10 Index' },
  { symbol: 'R_25', display_name: 'Volatility 25 Index' },
  { symbol: 'R_50', display_name: 'Volatility 50 Index' },
  { symbol: 'R_75', display_name: 'Volatility 75 Index' },
  { symbol: 'R_100', display_name: 'Volatility 100 Index' },
  { symbol: '1HZ10V', display_name: 'Volatility 10 (1s) Index' },
  { symbol: '1HZ25V', display_name: 'Volatility 25 (1s) Index' },
  { symbol: '1HZ50V', display_name: 'Volatility 50 (1s) Index' },
  { symbol: '1HZ75V', display_name: 'Volatility 75 (1s) Index' },
  { symbol: '1HZ100V', display_name: 'Volatility 100 (1s) Index' },
];

const tickCandidates = (symbol) => [
  { ticks: symbol, subscribe: 1 },
  { ticks: { underlying_symbol: symbol }, subscribe: 1 },
  { ticks: { symbol }, subscribe: 1 },
];

const historyCandidates = (symbol) => [
  {
    ticks_history: symbol,
    count: 500,
    end: 'latest',
    style: 'ticks',
  },
  {
    ticks_history: { underlying_symbol: symbol },
    count: 500,
    end: 'latest',
    style: 'ticks',
  },
];

const symbolCandidates = () => [
  { active_symbols: 'brief', product_type: 'basic' },
  { active_symbols: {} },
];

/** Pulls a numeric price out of whichever response shape arrived. */
function extractQuote(msg) {
  const tick = msg.tick ?? msg.data?.tick ?? null;
  const raw =
    tick?.quote ?? tick?.price ?? tick?.value ?? msg.quote ?? msg.price ?? null;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(value) ? value : null;
}

function extractHistory(msg) {
  const prices = msg.history?.prices ?? msg.prices ?? null;
  if (!Array.isArray(prices)) return null;
  return prices.map(Number).filter(Number.isFinite);
}

function extractSymbols(msg) {
  const list = msg.active_symbols ?? msg.symbols ?? null;
  if (!Array.isArray(list)) return null;
  return list
    .map((entry) => ({
      symbol: entry.underlying_symbol ?? entry.symbol,
      display_name: entry.display_name ?? entry.name ?? entry.symbol,
      market: entry.market ?? '',
    }))
    .filter((entry) => entry.symbol);
}

/** The last digit of a price, respecting the instrument's decimal places. */
export function lastDigit(quote, pipSize) {
  if (!Number.isFinite(quote)) return null;
  const decimals = Number.isFinite(pipSize) ? pipSize : inferDecimals(quote);
  const text = quote.toFixed(decimals);
  const digit = text[text.length - 1];
  return /[0-9]/.test(digit) ? Number(digit) : null;
}

function inferDecimals(quote) {
  const text = String(quote);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(text.length - dot - 1, 8);
}

export class DerivFeed {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.symbol = null;
    this.attempt = 0;
    this.pending = null;
    this.closedByUser = false;
    this.retryDelay = 1000;
    this.heartbeat = null;
  }

  log(direction, payload) {
    this.handlers.onLog?.({
      time: new Date().toISOString().slice(11, 23),
      direction,
      payload,
    });
  }

  connect() {
    this.closedByUser = false;
    this.handlers.onStatus?.('connecting');

    let socket;
    try {
      socket = new WebSocket(PUBLIC_WS_URL);
    } catch (error) {
      this.handlers.onStatus?.('error', String(error));
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.retryDelay = 1000;
      this.handlers.onStatus?.('open');
      this.request(symbolCandidates(), 'symbols');
      if (this.symbol) this.startSymbol(this.symbol);
      this.heartbeat = setInterval(() => this.send({ ping: 1 }), 20000);
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.receive(msg);
    };

    socket.onerror = () => {
      this.handlers.onStatus?.('error', 'WebSocket error');
    };

    socket.onclose = (event) => {
      clearInterval(this.heartbeat);
      this.handlers.onStatus?.('closed', `code ${event.code}`);
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.closedByUser) return;
    const delay = Math.min(this.retryDelay, 15000);
    this.handlers.onStatus?.('reconnecting', `retrying in ${delay / 1000}s`);
    setTimeout(() => this.connect(), delay);
    this.retryDelay = Math.min(this.retryDelay * 2, 15000);
  }

  send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    if (!('ping' in payload)) this.log('sent', payload);
    return true;
  }

  /** Sends candidate[index]; onError we advance to the next shape. */
  request(candidates, kind, index = 0) {
    if (index >= candidates.length) {
      this.handlers.onStatus?.(
        'error',
        `Every request format for "${kind}" was rejected. See the log below.`,
      );
      return;
    }
    this.pending = { candidates, kind, index };
    this.send(candidates[index]);
  }

  retryPending() {
    if (!this.pending) return false;
    const { candidates, kind, index } = this.pending;
    if (index + 1 >= candidates.length) return false;
    this.request(candidates, kind, index + 1);
    return true;
  }

  startSymbol(symbol) {
    this.symbol = symbol;
    this.handlers.onReset?.();
    this.request(historyCandidates(symbol), 'history');
    this.request(tickCandidates(symbol), 'ticks');
  }

  changeSymbol(symbol) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ forget_all: 'ticks' });
    }
    this.startSymbol(symbol);
  }

  receive(msg) {
    if (msg.ping || msg.pong) return;

    if (msg.error) {
      this.log('error', msg.error);
      if (!this.retryPending()) {
        this.handlers.onStatus?.(
          'error',
          msg.error.message ?? 'Request rejected',
        );
      }
      return;
    }

    const symbols = extractSymbols(msg);
    if (symbols?.length) {
      this.pending = null;
      this.log('received', `active_symbols: ${symbols.length} instruments`);
      this.handlers.onSymbols?.(symbols);
      return;
    }

    const history = extractHistory(msg);
    if (history?.length) {
      this.pending = null;
      this.log('received', `history: ${history.length} ticks`);
      this.handlers.onHistory?.(history);
      return;
    }

    const quote = extractQuote(msg);
    if (quote !== null) {
      this.pending = null;
      const tick = msg.tick ?? msg.data?.tick ?? {};
      this.handlers.onTick?.({
        quote,
        pipSize: tick.pip_size ?? tick.pipSize,
        epoch: tick.epoch ?? Math.floor(Date.now() / 1000),
      });
    }
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
