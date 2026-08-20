import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { DeployList } from "@/components/DeployList";
import { UploadForm } from "@/components/UploadForm";
import { Header } from "@/components/Header";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isAuthed())) redirect("/login");
  const deploys = getServer().db.listDeploys(50);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <Header />
      <div className="grid gap-6 md:grid-cols-[1fr_320px]">
        <section>
          <h1 className="mb-2 text-sm font-medium text-[var(--muted)]">New deploy</h1>
          <UploadForm />
        </section>
        <section>
          <h2 className="mb-2 text-sm font-medium text-[var(--muted)]">Deployment history</h2>
          <div className="max-h-[70vh] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-2">
            <DeployList deploys={deploys} />
          </div>
        </section>
      </div>
    </main>
  );
}
