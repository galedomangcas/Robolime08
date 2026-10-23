/**
 * Half-duplex downlink scheduling for the gateway radio.
 *
 * An SX1278 can either transmit or receive, never both. The robot initiates
 * every exchange: after each uplink it listens for a short response window,
 * and the gateway transmits only inside that window (the same idea as a
 * LoRaWAN class-A device, without LoRaWAN). Outside a window the robot may be
 * transmitting or not listening, so the gateway stays silent and keeps its
 * receiver open. While a transmission is in flight (LORA_TX sent, no
 * LORA_TX_RESULT yet) nothing else is transmitted.
 *
 * The window timing is NOT confirmed (OPEN_ITEMS #20): it must cover the
 * laptop's SQLite commit plus a USB round trip, and the firmware owner must
 * agree to it. Pure and clock-injected; all times are epoch milliseconds.
 */
import { assertManualCommandingEnabled } from './manualCommands';
import type { LoRaTxResult } from './serial';

export interface RadioScheduleConfig {
  /** Delay after the gateway sees an uplink before the robot's receive window opens. */
  readonly responseWindowDelayMs: number;
  readonly responseWindowMs: number;
  readonly maxTransmissionsPerWindow: number;
  /** Give up waiting for LORA_TX_RESULT after this long (bridge stalled or unplugged). */
  readonly txResultTimeoutMs: number;
}

/** NOT CONFIRMED (OPEN_ITEMS #20). */
export const RADIO_SCHEDULE: RadioScheduleConfig | null = null;

/** Lower index = sent first. A STOP never waits behind storage ACKs. */
export const DOWNLINK_PRIORITIES = ['stop_command', 'storage_ack', 'manual_command'] as const;
export type DownlinkPriority = (typeof DOWNLINK_PRIORITIES)[number];

interface QueuedDownlink<T> {
  key: string;
  priority: DownlinkPriority;
  item: T;
}

export type TxResultOutcome = 'sent' | 'retry_later' | 'dropped' | 'unexpected';

export class HalfDuplexScheduler<T> {
  private queue: QueuedDownlink<T>[] = [];
  private window: { opensAtMs: number; closesAtMs: number; used: number } | null = null;
  private inFlight: { key: string; startedAtMs: number } | null = null;
  /** Transmissions whose result never arrived (diagnostics). */
  lostTxResults = 0;

  constructor(private readonly config: RadioScheduleConfig) {}

  /**
   * Adds an item; an item with the same key is replaced in place (e.g. a
   * re-ACK of a retried reading). Command priorities are refused while the
   * manual-command gate is closed (D21), so no command can be queued for air.
   */
  enqueue(key: string, priority: DownlinkPriority, item: T): void {
    if (priority !== 'storage_ack') assertManualCommandingEnabled();
    const existing = this.queue.find((q) => q.key === key);
    if (existing) {
      existing.priority = priority;
      existing.item = item;
      return;
    }
    this.queue.push({ key, priority, item });
  }

  remove(key: string): void {
    this.queue = this.queue.filter((q) => q.key !== key);
  }

  get pending(): number {
    return this.queue.length;
  }

  get transmissionInFlight(): boolean {
    return this.inFlight !== null;
  }

  /** Every received uplink opens a fresh response window. */
  onUplinkReceived(atMs: number): void {
    const opensAtMs = atMs + this.config.responseWindowDelayMs;
    this.window = { opensAtMs, closesAtMs: opensAtMs + this.config.responseWindowMs, used: 0 };
  }

  /** Returns the item to hand to the bridge now, or null if the gateway must stay silent. */
  next(nowMs: number): { key: string; item: T } | null {
    if (this.inFlight && nowMs - this.inFlight.startedAtMs >= this.config.txResultTimeoutMs) {
      this.inFlight = null;
      this.lostTxResults += 1;
    }
    if (this.inFlight || !this.window) return null;
    const w = this.window;
    if (nowMs < w.opensAtMs || nowMs >= w.closesAtMs || w.used >= this.config.maxTransmissionsPerWindow) return null;

    for (const priority of DOWNLINK_PRIORITIES) {
      const pick = this.queue.find((q) => q.priority === priority);
      if (pick) {
        w.used += 1;
        this.inFlight = { key: pick.key, startedAtMs: nowMs };
        return { key: pick.key, item: pick.item };
      }
    }
    return null;
  }

  onTransmissionResult(key: string, result: LoRaTxResult): TxResultOutcome {
    if (this.inFlight?.key !== key) return 'unexpected';
    this.inFlight = null;
    switch (result) {
      case 'SENT':
        this.remove(key);
        return 'sent';
      case 'REJECTED_TOO_LARGE':
        this.remove(key);
        return 'dropped';
      case 'CHANNEL_BUSY_RX':
      case 'RADIO_ERROR':
      case 'TX_TIMEOUT':
        return 'retry_later';
    }
  }

  /** Abandons an item handed out by `next` that could not be encoded (it is removed, not retried). */
  discard(key: string): void {
    if (this.inFlight?.key === key) this.inFlight = null;
    this.remove(key);
  }

  /** On USB disconnect: forget the in-flight transmission and the window; queued items stay. */
  resetLink(): void {
    this.inFlight = null;
    this.window = null;
  }
}
