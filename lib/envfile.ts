export interface EnvPair { key: string; value: string }

export class EnvInvalid extends Error {
  constructor(public key: string, public reason: string) {
    super(reason);            // TIDAK PERNAH menyertakan nilai — lihat Global Constraints
    this.name = "EnvInvalid";
  }
}

// Sekaligus membuat interpolasi key ke dalam regex grep di run.sh aman:
// tidak ada metakarakter regex yang bisa lolos.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Di-override = akibat yang mengagetkan. Diberi peringatan di UI, tidak diblokir. */
export const DANGEROUS_KEYS = new Set([
  "BETTER_AUTH_SECRET",  // DEPLOYMENT.md §4: semua session user langsung invalid
  "NEXTAUTH_SECRET",
  "SECRET_KEY",
  "SECRET_KEY_BASE",
  "APP_KEY",
  "DATABASE_URL",        // data lama tetap di /srv/data/<project>, tampak seperti hilang
]);

export function validateEnv(pairs: EnvPair[]): EnvPair[] {
  const seen = new Set<string>();
  const out: EnvPair[] = [];

  for (const p of pairs) {
    const key = p.key.trim();
    if (!KEY_RE.test(key)) {
      throw new EnvInvalid(
        key,
        `Nama env '${key}' tidak valid. Harus diawali huruf atau '_', lalu hanya huruf, angka, dan '_'.`,
      );
    }
    if (seen.has(key)) throw new EnvInvalid(key, `Env '${key}' ditulis lebih dari sekali (duplikat).`);
    seen.add(key);

    if (/[\r\n]/.test(p.value)) {
      throw new EnvInvalid(key, `Nilai '${key}' mengandung newline, yang tidak didukung env_file Docker.`);
    }
    out.push({ key, value: p.value.trim() });
  }
  return out;
}

export function parseDotenv(text: string): EnvPair[] {
  const out: EnvPair[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

/** Format yang dibaca run.sh: KEY=VALUE literal, satu per baris, tanpa kutip. */
export function serializeOverrides(pairs: EnvPair[]): string {
  return pairs.map((p) => `${p.key}=${p.value}\n`).join("");
}
