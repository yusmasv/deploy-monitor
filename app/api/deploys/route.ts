import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { normalizeProject } from "@/lib/project";
import { validateEnv, EnvInvalid, type EnvPair } from "@/lib/envfile";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  return Response.json({ deploys: getServer().db.listDeploys(50) });
}

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { runner, cfg } = getServer();
  const form = await req.formData();

  const file = form.get("zip");
  if (!(file instanceof File)) {
    return Response.json({ error: "File zip wajib diunggah." }, { status: 400 });
  }
  if (file.size > cfg.maxZipBytes) {
    return Response.json(
      { error: `Zip terlalu besar (${file.size} byte, batas ${cfg.maxZipBytes}).` },
      { status: 400 },
    );
  }

  let project: string;
  try {
    project = normalizeProject(String(form.get("project") ?? ""));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  let env: EnvPair[];
  try {
    env = validateEnv(JSON.parse(String(form.get("env") ?? "[]")) as EnvPair[]);
  } catch (e) {
    // EnvInvalid tidak pernah memuat nilai — aman dikirim ke klien.
    const message = e instanceof EnvInvalid ? e.message : "Format env tidak valid.";
    return Response.json({ error: message }, { status: 400 });
  }

  const id = await runner.enqueue({
    project,
    zip: Buffer.from(await file.arrayBuffer()),
    zipName: file.name,
    env,
  });

  return Response.json({ id, project }, { status: 202 });
}
