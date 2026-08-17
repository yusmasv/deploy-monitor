export type LogColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";
export interface Span { text: string; color?: LogColor; bold?: boolean }

const COLORS: Record<number, LogColor> = {
  31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan",
};

// Semua escape CSI. Yang berakhiran 'm' adalah SGR (warna); sisanya (gerakan
// kursor dari docker) dibuang.
const CSI = /\x1b\[([0-9;]*)([A-Za-z])/g;

export function parseAnsi(line: string): Span[] {
  const spans: Span[] = [];
  let color: LogColor | undefined;
  let bold = false;
  let last = 0;

  const push = (text: string) => {
    if (!text) return;
    spans.push({ text, ...(color && { color }), ...(bold && { bold }) });
  };

  for (const m of line.matchAll(CSI)) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;

    if (m[2] !== "m") continue;                    // bukan SGR: dibuang saja
    for (const p of (m[1] || "0").split(";")) {
      const n = Number(p);
      if (n === 0) { color = undefined; bold = false; }
      else if (n === 1) bold = true;
      else if (COLORS[n]) color = COLORS[n];
    }
  }
  push(line.slice(last));
  return spans;
}
