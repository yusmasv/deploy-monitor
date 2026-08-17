export type ExecutorKind = "local" | "ssh";

export interface Config {
  monitorToken: string;
  executor: ExecutorKind;
  deploySh: string;
  uploadsDir: string;
  dbPath: string;
  publicHost: string;
  maxZipBytes: number;
  ssh?: { host: string; user: string; keyPath: string };
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const monitorToken = (env.MONITOR_TOKEN ?? "").trim();
  if (!monitorToken) {
    throw new Error("MONITOR_TOKEN wajib diisi — aplikasi ini menjalankan deploy sebagai root.");
  }

  const executor = (env.EXECUTOR ?? "local") as ExecutorKind;
  if (executor !== "local" && executor !== "ssh") {
    throw new Error(`EXECUTOR harus 'local' atau 'ssh', bukan '${executor}'.`);
  }

  let ssh: Config["ssh"];
  if (executor === "ssh") {
    const host = (env.SSH_HOST ?? "").trim();
    if (!host) throw new Error("EXECUTOR=ssh membutuhkan SSH_HOST.");
    ssh = {
      host,
      user: env.SSH_USER ?? "root",
      keyPath: env.SSH_KEY ?? `${env.HOME ?? ""}/.ssh/id_ed25519`,
    };
  }

  let maxZipBytes = 200 * 1024 * 1024;
  if (env.MAX_ZIP_BYTES !== undefined) {
    const raw = env.MAX_ZIP_BYTES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `MAX_ZIP_BYTES harus berupa bilangan bulat positif, bukan '${raw}'.`,
      );
    }
    maxZipBytes = parsed;
  }

  return {
    monitorToken,
    executor,
    deploySh: env.DEPLOY_SH ?? "/srv/platform/deploy.sh",
    uploadsDir: env.UPLOADS_DIR ?? "/srv/uploads",
    dbPath: env.DB_PATH ?? "/srv/monitor/monitor.db",
    publicHost: (env.PUBLIC_HOST ?? "").trim(),
    maxZipBytes,
    ssh,
  };
}

let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
