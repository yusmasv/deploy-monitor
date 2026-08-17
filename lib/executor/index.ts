import type { Config } from "../config";
import type { Executor } from "./types";
import { LocalExecutor } from "./local";
import { SshExecutor } from "./ssh";

export type { Executor, LogChunk, RunOpts } from "./types";

export function getExecutor(cfg: Config): Executor {
  if (cfg.executor === "ssh") {
    if (!cfg.ssh) throw new Error("EXECUTOR=ssh tapi konfigurasi SSH tidak lengkap.");
    return new SshExecutor(cfg.ssh);
  }
  return new LocalExecutor();
}
