export type LogChunk =
  | { stream: "stdout" | "stderr"; line: string }
  | { stream: "exit"; code: number };

export interface RunOpts { env?: Record<string, string>; cwd?: string }

export interface Executor {
  run(cmd: string, args: string[], opts: RunOpts): AsyncIterable<LogChunk>;
  /** Harus membuat direktori induk `path` yang belum ada (mkdir -p semantics) — pemanggil (Runner) tidak melakukannya sendiri. */
  writeFile(path: string, data: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}
