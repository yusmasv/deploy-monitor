const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const name =
    typeof args[0] === "string"
      ? args[0]
      : typeof warning === "object" && "name" in warning
        ? (warning as Error).name
        : (args[0] as { type?: string } | undefined)?.type;

  if (name === "ExperimentalWarning" && /SQLite is an experimental feature/.test(message)) {
    return;
  }
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
