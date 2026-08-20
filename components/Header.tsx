import Link from "next/link";

export function Header({ back }: { back?: boolean }) {
  return (
    <header className="mb-6 flex items-center justify-between">
      <Link href="/" className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)]" />
        <span className="text-sm font-semibold tracking-tight">Deploy Monitor</span>
      </Link>
      {back && (
        <Link href="/" className="text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]">
          ← All deployments
        </Link>
      )}
    </header>
  );
}
