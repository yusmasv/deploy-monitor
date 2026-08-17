import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { stripAnsi } from "@/lib/phases";

export const dynamic = "force-dynamic";

// `id` disisipkan ke header Content-Disposition di bawah. Header BUKAN tempat
// untuk input mentah: tanda kutip di dalam id memalsukan nama file yang
// terunduh, dan CR/LF membuat konstruktor Response melempar (500 yang tidak
// perlu). Semua id yang sah dibuat randomUUID(), jadi menolak yang tidak
// berbentuk UUID di depan lebih tegas daripada sekadar menyaring karakter —
// dan sekaligus menolak id ngawur lebih awal, seperti rute lain.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return Response.json({ error: "Id deploy tidak valid." }, { status: 400 });
  }
  const plain = new URL(req.url).searchParams.get("plain") === "1";
  const lines = getServer().db.getLines(id, 0);

  const body = lines.map((l) => (plain ? stripAnsi(l.text) : l.text)).join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="deploy-${id}.log"`,
    },
  });
}
