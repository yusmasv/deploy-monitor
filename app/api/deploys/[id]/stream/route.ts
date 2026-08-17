import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { bus, type LineEvent } from "@/lib/bus";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["success", "failed", "interrupted"]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await ctx.params;
  const { db } = getServer();
  if (!db.getDeploy(id)) return Response.json({ error: "Deploy tidak ditemukan." }, { status: 404 });

  // Reconnect: browser mengirim balik id event terakhir yang diterimanya, jadi
  // refresh di tengah build tidak kehilangan satu baris pun.
  const resume = Number(req.headers.get("last-event-id") ?? 0) || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown, eventId?: number) => {
        if (closed) return;
        const idLine = eventId === undefined ? "" : `id: ${eventId}\n`;
        controller.enqueue(encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // 1. Putar ulang dari database dulu.
      for (const l of db.getLines(id, resume)) {
        send("line", { seq: l.seq, stream: l.stream, text: l.text }, l.seq);
      }
      send("state", { deploy: db.getDeploy(id) });

      const onLine = (e: LineEvent) => send("line", { seq: e.seq, stream: e.stream, text: e.text }, e.seq);
      const onState = () => {
        const d = db.getDeploy(id);
        send("state", { deploy: d });
        if (d && TERMINAL.has(d.status)) finish();
      };

      // Proxy memutus koneksi yang diam; komentar SSE menahannya tetap hidup.
      // enqueue() di sini TIDAK lewat bus.emit, jadi try/catch Runner di sisi
      // lain tidak menjangkaunya — kalau koneksi sudah mati duluan sebelum
      // event 'abort' sempat kita terima, enqueue() bisa melempar, dan kalau
      // itu tidak ditangkap di sini akan jadi uncaught exception di dalam
      // callback setInterval (bisa merobohkan proses). Callback ini baru bisa
      // terpanggil setelah timer-nya menyala, jauh setelah start() (dan
      // deklarasi finish di bawah) selesai dieksekusi — beda dengan bus.on di
      // bawah yang bisa terpicu sinkron, jadi tidak ada masalah TDZ di sini.
      const ping = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { finish(); }
      }, 20000);

      // finish HARUS dideklarasikan sebelum bus.on di bawah. onState memanggil
      // finish, jadi kalau listener terpasang lebih dulu dan sebuah event tiba
      // di jendela itu, finish masih berada di temporal dead zone dan melempar
      // ReferenceError.
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        bus.off(`line:${id}`, onLine);
        bus.off(`state:${id}`, onState);
        try { controller.close(); } catch { /* sudah tertutup */ }
      };

      req.signal.addEventListener("abort", finish);

      // 2. Baru menyambung ke siaran langsung.
      bus.on(`line:${id}`, onLine);
      bus.on(`state:${id}`, onState);

      const current = db.getDeploy(id);
      if (current && TERMINAL.has(current.status)) finish();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",   // matikan buffering nginx kalau ada di depan
    },
  });
}
