export interface Phase { id: string; label: string }

export const PHASES: readonly Phase[] = [
  { id: "source",    label: "Source" },
  { id: "configure", label: "Configuration" },
  { id: "build",     label: "Build" },
  { id: "push",      label: "Push" },
  { id: "ship",      label: "Ship Config" },
  { id: "runtime",   label: "Runtime" },
  { id: "migrate",   label: "Migrate" },
  { id: "start",     label: "Start" },
  { id: "health",    label: "Health Check" },
] as const;

// PERINGATAN: ini string matching terhadap teks yang dicetak deploy.sh/run.sh.
// Sengaja dipakai karena murah, dan sengaja dibuat TIDAK menentukan apa pun yang
// penting: sukses/gagal SELALU dari exit code. Kalau satu penanda meleset,
// timeline-nya saja yang tidak maju — status deploy tetap benar.
const MARKERS: [RegExp, string][] = [
  [/^Cloning repository/,              "source"],
  [/^Updating existing repository/,    "source"],
  [/^Detecting configuration/,         "configure"],
  [/^Building image/,                  "build"],
  [/^Pushing image/,                   "push"],
  [/^Shipping app config/,             "ship"],
  [/^Triggering runtime deployment/,   "runtime"],
  [/^Running migration:/,              "migrate"],
  [/^Starting application/,            "start"],
  [/^Waiting for application/,         "health"],
];

export function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function detectPhase(plainLine: string): string | null {
  const s = plainLine.trim();
  for (const [re, id] of MARKERS) if (re.test(s)) return id;
  return null;
}

export interface Summary { sha: string; image: string; appPort: number }

export function detectSummary(plainLine: string): Partial<Summary> | null {
  const s = plainLine.trim();

  const commit = /^Commit\s*:\s*(\S+)$/.exec(s);
  if (commit) return { sha: commit[1] };

  const image = /^Image\s*:\s*(\S+)$/.exec(s);
  if (image) return { image: image[1] };

  const port = /^Port\s*:\s*(\d+)$/.exec(s);
  if (port) return { appPort: Number(port[1]) };

  return null;
}
