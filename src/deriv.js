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

// Ordered by confidence. The Deriv API index states plainly that "the symbol
// field is `underlying_symbol`", so that shape is tried first; the older string
// form is kept as a fallback for endpoints that have not migrated yet.
const tickCandidates = (symbol) => [
  { ticks: { underlying_symbol: symbol }, subscribe: 1 },
  { ticks: symbol, subscribe: 1 },
  { ticks: { symbol }, subscribe: 1 },
  { subscribe: { ticks: { underlying_symbol: symbol } } },
  { ticks_stream: { underlying_symbol: symbol } },
];

const historyCandidates = (symbol) => [
  {
    ticks_history: { underlying_symbol: symbol },
    count: 500,
    end: 'latest',
    style: 'ticks',
  },
  {
    ticks_history: symbol,
    count: 500,
    end: 'latest',
    style: 'ticks',
  },
];

const symbolCandidates = () => [
  { active_symbols: 'brief', product_type: 'basic' },
  { active_symbols: 'brief' },
  { active_symbols: 'full' },
  { active_symbols: {} },
];

/** Requests whose failure should not surface as an app-level error. */
const OPTIONAL_KINDS = new Set(['symbols']);

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
    this.pending = new Map();
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

  /** Sends candidate[index]; on rejection we advance to the next shape. */
  request(candidates, kind, index = 0) {
    if (index >= candidates.length) {
      if (OPTIONAL_KINDS.has(kind)) {
        this.log(
          'received',
          `${kind}: every format rejected — continuing with the built-in list`,
        );
        this.pending.delete(kind);
      } else {
        this.handlers.onStatus?.(
          'error',
          `Every known request format for "${kind}" was rejected — fetching the official schema, see the log.`,
        );
      }
      this.fetchSchema(kind);
      return;
    }
    this.pending.set(kind, { candidates, index });
    this.send(candidates[index]);
  }

  /**
   * Pulls Deriv's own documentation for the failed endpoint through the
   * same-origin docs relay and prints the JSON examples it contains into the
   * connection log, so the correct request shape is visible on the page itself.
   */
  async fetchSchema(kind) {
    const page = { ticks: 'ticks', history: 'ticks-history', symbols: 'active-symbols' }[kind];
    if (!page || this[`docs_${page}`]) return;
    this[`docs_${page}`] = true;
    try {
      const response = await fetch(`/api/docs?page=${page}`);
      const text = await response.text();
      if (!response.ok) {
        this.log('error', `docs relay for ${page}: HTTP ${response.status}`);
        return;
      }
      const blocks = [...text.matchAll(/```(?:json[c5]?)?\n([\s\S]*?)```/g)]
        .map((match) => match[1].trim())
        .filter((block) => block.startsWith('{'))
        .slice(0, 3);
      if (blocks.length) {
        this.log('received', `official ${page}.md schema examples:`);
        for (const block of blocks) {
          this.log('received', block.replace(/\s+/g, ' ').slice(0, 400));
        }
      } else {
        this.log(
          'received',
          `official ${page}.md (excerpt): ${text.replace(/\s+/g, ' ').slice(0, 500)}`,
        );
      }
    } catch (error) {
      this.log('error', `docs fetch for ${page} failed: ${error.message}`);
    }
  }

  /**
   * Works out which in-flight request an error belongs to. Deriv echoes the
   * original request back as `echo_req`, so the endpoint key identifies it;
   * several requests are in flight at once and must not be confused.
   */
  kindOf(msg) {
    const echo = msg.echo_req ?? {};
    if ('ticks' in echo || 'ticks_stream' in echo || 'subscribe' in echo)
      return 'ticks';
    if ('ticks_history' in echo) return 'history';
    if ('active_symbols' in echo) return 'symbols';
    return this.pending.size === 1 ? [...this.pending.keys()][0] : null;
  }

  retryPending(msg) {
    const kind = this.kindOf(msg);
    if (!kind) return false;
    const entry = this.pending.get(kind);
    if (!entry || entry.index + 1 >= entry.candidates.length) return false;
    this.request(entry.candidates, kind, entry.index + 1);
    return true;
  }

  /** Records which candidate shape the server accepted, then clears it. */
  resolvePending(kind) {
    const entry = this.pending.get(kind);
    if (!entry) return;
    this.log(
      'accepted',
      `${kind}: format ${entry.index + 1} of ${
        entry.candidates.length
      } — ${JSON.stringify(entry.candidates[entry.index])}`,
    );
    this.pending.delete(kind);
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
      if (!this.retryPending(msg)) {
        const kind = this.kindOf(msg);
        if (!OPTIONAL_KINDS.has(kind)) {
          this.handlers.onStatus?.(
            'error',
            msg.error.message ?? 'Request rejected',
          );
        } else {
          this.pending.delete(kind);
          this.log(
            'received',
            `${kind}: rejected — continuing with the built-in list`,
          );
        }
      }
      return;
    }

    const symbols = extractSymbols(msg);
    if (symbols?.length) {
      this.resolvePending('symbols');
      this.log('received', `active_symbols: ${symbols.length} instruments`);
      this.handlers.onSymbols?.(symbols);
      return;
    }

    const history = extractHistory(msg);
    if (history?.length) {
      this.resolvePending('history');
      this.log('received', `history: ${history.length} ticks`);
      this.handlers.onHistory?.(history);
      return;
    }

    const quote = extractQuote(msg);
    if (quote !== null) {
      this.resolvePending('ticks');
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
