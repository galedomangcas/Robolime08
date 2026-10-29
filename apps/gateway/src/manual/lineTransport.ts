import { ReadlineParser, SerialPort } from 'serialport';

/**
 * Line-oriented USB serial link to the gateway LoRa bridge for manual control
 * (D57). The Sprint 1 bridge sketch reads one command per `\n`-terminated
 * line and prints its own log lines back. This is NOT the D22 binary framing
 * used by the telemetry bridge runtime, which stays simulation-only.
 */
export interface LineTransport {
  /** Resolves once lines can flow; rejects if the port cannot be opened. */
  open(onLine: (line: string) => void, onClose: (error: Error | null) => void): Promise<void>;
  writeLine(line: string): Promise<void>;
  close(): Promise<void>;
}

/** Baud rate of `Serial.begin(115200)` in the bridge sketch. */
export const DEFAULT_BRIDGE_BAUD = 115_200;

export function createSerialLineTransport(path: string, baudRate: number = DEFAULT_BRIDGE_BAUD): LineTransport {
  let port: SerialPort | null = null;
  let closing = false;

  return {
    open(onLine, onClose) {
      closing = false;
      return new Promise((resolve, reject) => {
        const next = new SerialPort({ path, baudRate, autoOpen: false });
        const parser = next.pipe(new ReadlineParser({ delimiter: '\n' }));
        parser.on('data', (line: string) => onLine(line.replace(/\r$/, '')));
        next.on('close', (error: Error | null) => {
          port = null;
          if (!closing) onClose(error ?? null);
        });
        next.on('error', () => {
          // Reported through 'close' (unplugged) or the open/write callbacks.
        });
        next.open((error) => {
          if (error) {
            reject(error);
            return;
          }
          port = next;
          resolve();
        });
      });
    },
    writeLine(line) {
      return new Promise((resolve, reject) => {
        const current = port;
        if (!current) {
          reject(new Error('The bridge serial port is not open.'));
          return;
        }
        current.write(`${line}\n`, (error) => {
          if (error) {
            reject(error);
            return;
          }
          current.drain((drainError) => (drainError ? reject(drainError) : resolve()));
        });
      });
    },
    close() {
      closing = true;
      const current = port;
      port = null;
      if (!current || !current.isOpen) return Promise.resolve();
      return new Promise((resolve) => current.close(() => resolve()));
    },
  };
}
