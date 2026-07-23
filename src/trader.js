// Auto trader — DEMO ACCOUNTS ONLY.
//
// Executes the "Market Wizard OverUnder" strategy (parameters lifted from the
// uploaded XML) through Deriv's real trading API on a demo account: OTP session,
// proposal, buy, settlement. The demo gate is structural: the session refuses
// to construct against a non-virtual account.
//
// Measured reality, stated where the code can see it: against fair digits this
// strategy averages -2.59 units per session and its bias filter is
// indistinguishable from trading blindly. This module exists so that result can
// be observed safely, not so it can be escaped.

import { APP_ID, isDemo } from './auth.js';
import { overUnderBaseline } from './contracts.js';

export const STRATEGY = {
  window: 25,
  minBias: 5,
  prediction: 4,
  martingale: 2.2,
  initialStake: 1,
  maxStake: 15,
  maxConsecutiveLosses: 6,
  profitTarget: 10,
  lossLimit: 20,
  maxTrades: 50,
};

const TRADING_OTP_PATH = (accountId) =>
  `/api/otp?account=${encodeURIComponent(accountId)}`;

export class DemoTradingSession {
  constructor({ account, token, symbol, onEvent, onState }) {
    if (!isDemo(account)) {
      throw new Error(
        'Auto trading is available on demo accounts only. Select your demo (VRTC) account.',
      );
    }
    this.account = account;
    this.token = token;
    this.symbol = symbol;
    this.onEvent = onEvent ?? (() => {});
    this.onState = onState ?? (() => {});
    this.ws = null;
    this.running = false;
    this.buffer = [];
    this.stake = STRATEGY.initialStake;
    this.consecutiveLosses = 0;
    this.profit = 0;
    this.trades = 0;
    this.wins = 0;
    this.awaiting = null; // { side, stake, proposalId }
    this.stopped = null;
  }

  emit(kind, detail) {
    this.onEvent({ time: new Date().toISOString().slice(11, 23), kind, detail });
  }

  state() {
    return {
      running: this.running,
      profit: this.profit,
      stake: this.stake,
      trades: this.trades,
      wins: this.wins,
      consecutiveLosses: this.consecutiveLosses,
      stopped: this.stopped,
      awaiting: Boolean(this.awaiting),
    };
  }

  push() {
    this.onState(this.state());
  }

  async start() {
    this.emit('info', `Opening demo trading session for ${this.account.loginid ?? this.account.account_id}`);
    let url;
    try {
      const response = await fetch(TRADING_OTP_PATH(this.account.loginid ?? this.account.account_id), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Deriv-App-ID': APP_ID,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error_description ?? payload.message ?? `OTP failed (HTTP ${response.status})`);
      }
      url = payload.url ?? payload.websocket_url ?? payload.ws_url;
      if (!url) throw new Error('OTP response contained no WebSocket URL');
    } catch (error) {
      this.emit('error', `Could not open trading session: ${error.message}`);
      this.stopped = 'error';
      this.push();
      return;
    }

    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.running = true;
      this.emit('info', 'Trading socket open — demo session armed');
      this.push();
    };
    this.ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.receive(msg);
    };
    this.ws.onerror = () => this.emit('error', 'Trading socket error');
    this.ws.onclose = () => {
      this.running = false;
      this.emit('info', 'Trading socket closed');
      this.push();
    };
  }

  stop(reason = 'stopped by user') {
    this.stopped = reason;
    this.running = false;
    this.ws?.close();
    this.emit('info', `Session ended: ${reason}`);
    this.push();
  }

  /** Fed each new last-digit from the public feed. Decides and trades. */
  onDigit(digit) {
    if (!this.running || this.stopped || this.awaiting) return;
    this.buffer.push(digit);
    if (this.buffer.length > STRATEGY.window) this.buffer.shift();
    if (this.buffer.length < STRATEGY.window) return;

    let high = 0, low = 0;
    for (const d of this.buffer) {
      if (d > STRATEGY.prediction) high += 1;
      else if (d < STRATEGY.prediction) low += 1;
    }
    const bias = high - low;
    let side = null;
    if (bias >= STRATEGY.minBias) side = 'DIGITOVER';
    else if (bias <= -STRATEGY.minBias) side = 'DIGITUNDER';
    if (!side) return;

    this.requestProposal(side);
  }

  requestProposal(side) {
    const stake = Math.min(this.stake, STRATEGY.maxStake);
    this.awaiting = { side, stake, proposalId: null };
    const base = {
      proposal: 1,
      contract_type: side,
      amount: stake,
      basis: 'stake',
      currency: this.account.currency ?? 'USD',
      duration: 1,
      duration_unit: 't',
      barrier: String(STRATEGY.prediction),
    };
    // New-API field first, legacy second; the socket tells us which it wants.
    this.candidates = [
      { ...base, underlying_symbol: this.symbol },
      { ...base, symbol: this.symbol },
    ];
    this.candidateIndex = 0;
    this.sendCandidate();
  }

  sendCandidate() {
    const payload = this.candidates[this.candidateIndex];
    if (!payload) {
      this.emit('error', 'Every proposal format was rejected — pausing.');
      this.awaiting = null;
      this.stop('proposal format rejected');
      return;
    }
    this.ws.send(JSON.stringify(payload));
    this.emit('sent', payload);
  }

  receive(msg) {
    if (msg.ping || msg.pong) return;
    if (msg.error) {
      this.emit('error', msg.error);
      if (this.awaiting && !this.awaiting.proposalId && this.candidateIndex + 1 < (this.candidates?.length ?? 0)) {
        this.candidateIndex += 1;
        this.sendCandidate();
        return;
      }
      // Fail safe: any unhandled error while a trade is in flight ends the session.
      if (this.awaiting) this.stop(`API error: ${msg.error.message ?? 'unknown'}`);
      return;
    }

    const proposal = msg.proposal ?? msg.data?.proposal;
    if (proposal && this.awaiting && !this.awaiting.proposalId) {
      const id = proposal.id ?? proposal.proposal_id;
      const price = proposal.ask_price ?? proposal.price ?? this.awaiting.stake;
      this.awaiting.proposalId = id;
      this.emit('received', `proposal ${id} ask ${price} payout ${proposal.payout ?? '?'}`);
      this.ws.send(JSON.stringify({ buy: id, price: Number(price) }));
      this.emit('sent', { buy: id, price: Number(price) });
      return;
    }

    const buy = msg.buy ?? msg.data?.buy;
    if (buy && this.awaiting) {
      this.awaiting.contractId = buy.contract_id ?? buy.contractId;
      this.emit('received', `bought contract ${this.awaiting.contractId} for ${buy.buy_price ?? this.awaiting.stake}`);
      const sub = { proposal_open_contract: 1, contract_id: this.awaiting.contractId, subscribe: 1 };
      this.ws.send(JSON.stringify(sub));
      return;
    }

    const poc = msg.proposal_open_contract ?? msg.data?.proposal_open_contract;
    if (poc && this.awaiting && (poc.contract_id === this.awaiting.contractId || !poc.contract_id)) {
      if (poc.is_sold || poc.status === 'sold' || poc.status === 'won' || poc.status === 'lost') {
        const profit = Number(poc.profit ?? poc.sell_price - poc.buy_price ?? 0);
        this.settle(Number.isFinite(profit) ? profit : 0);
      }
    }
  }

  settle(tradeProfit) {
    const { side, stake } = this.awaiting;
    this.awaiting = null;
    this.trades += 1;
    this.profit += tradeProfit;
    const won = tradeProfit > 0;
    if (won) {
      this.wins += 1;
      this.consecutiveLosses = 0;
      this.stake = STRATEGY.initialStake;
    } else {
      this.consecutiveLosses += 1;
      this.stake = Math.min(this.stake * STRATEGY.martingale, STRATEGY.maxStake);
    }
    const p = overUnderBaseline(side, STRATEGY.prediction);
    this.emit('trade', `${side} ${STRATEGY.prediction} stake ${stake.toFixed(2)} → ${won ? 'WIN' : 'LOSS'} ${tradeProfit.toFixed(2)} (baseline p=${p}) · total ${this.profit.toFixed(2)}`);
    this.push();

    if (this.profit >= STRATEGY.profitTarget) this.stop(`profit target +${STRATEGY.profitTarget} reached`);
    else if (this.profit <= -STRATEGY.lossLimit) this.stop(`loss limit -${STRATEGY.lossLimit} reached`);
    else if (this.consecutiveLosses >= STRATEGY.maxConsecutiveLosses) this.stop(`${STRATEGY.maxConsecutiveLosses} consecutive losses`);
    else if (this.trades >= STRATEGY.maxTrades) this.stop(`${STRATEGY.maxTrades}-trade session cap`);
  }
}
