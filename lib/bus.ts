import { EventEmitter } from "node:events";

export interface LineEvent { deployId: string; seq: number; stream: string; ts: number; text: string }
export interface StateEvent { deployId: string }

class Bus extends EventEmitter {
  emitLine(e: LineEvent) { this.emit(`line:${e.deployId}`, e); }
  emitState(e: StateEvent) { this.emit(`state:${e.deployId}`, e); }
}

// Satu instans per proses. SSE fan-out dilakukan di sini, bukan lewat polling DB.
export const bus = new Bus();
bus.setMaxListeners(0);
