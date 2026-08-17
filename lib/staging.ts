import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { extractZip, type ExtractResult, type ZipLimits } from "./intake";
import { normalizeProject } from "./project";

const exec = promisify(execFile);

// Identitas disuntik lewat -c supaya VPS1 tidak perlu `git config --global` apa pun.
const GIT_IDENTITY = [
  "-c", "user.email=deploy-monitor@localhost",
  "-c", "user.name=deploy-monitor",
];

const git = (dir: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...GIT_IDENTITY, ...args], { maxBuffer: 32 * 1024 * 1024 });

export interface PrepareOpts {
  project: string;
  zip: Buffer;
  uploadsDir: string;
  limits: ZipLimits;
}

export async function prepareStaging(
  opts: PrepareOpts,
): Promise<{ dir: string; extract: ExtractResult }> {
  // normalizeProject sudah terbukti idempoten (Task 2): nama yang pemanggil
  // (mis. API route) sudah normalkan lolos di sini tanpa berubah, jadi
  // memanggilnya lagi tidak merusak apa pun untuk jalur yang sudah benar.
  // Tapi prepareStaging TIDAK BOLEH mempercayai pemanggil melakukan itu:
  // Runner meneruskan job.project apa adanya, dan satu pemanggil masa depan
  // yang lupa memanggil normalizeProject akan membuat kita menulis file di
  // sembarang tempat di host — SEBAGAI ROOT.
  const project = normalizeProject(opts.project);
  const dir = join(opts.uploadsDir, project);

  // Lapis kedua, independen dari aturan normalisasi nama: pastikan LANGSUNG
  // bahwa path yang di-resolve benar-benar di dalam uploadsDir, alih-alih
  // menyimpulkannya dari aturan nama semata. Sama seperti safeJoin() di
  // lib/intake.ts. Ini jaring pengaman kalau aturan normalisasi nama di atas
  // suatu saat dilonggarkan dan mulai meloloskan '/'.
  const root = resolve(opts.uploadsDir);
  const resolvedDir = resolve(dir);
  if (resolvedDir === root || !resolvedDir.startsWith(root + sep)) {
    throw new Error(
      `Nama project '${opts.project}' menghasilkan path di luar direktori uploads — ditolak.`,
    );
  }

  // Extract ke temp DULU. Zip yang ditolak tidak boleh menyentuh staging repo
  // yang sudah berisi upload sebelumnya yang baik-baik saja.
  const staged = await mkdtemp(join(tmpdir(), "dm-extract-"));
  let extract: ExtractResult;
  // Dari titik initRepo() berhasil, `dir` adalah repo git nyata yang mungkin
  // sudah punya riwayat dari upload sebelumnya yang baik. Kalau langkah
  // sesudahnya gagal (mengosongkan working tree, cp, git add, atau git
  // commit — mis. ditolak pre-commit hook, atau ENOSPC), working tree/index
  // repo itu bisa tertinggal dalam keadaan tidak konsisten dengan commit
  // terakhirnya. dirTouched menandai kapan pemulihan itu perlu dicoba.
  let dirTouched = false;
  try {
    extract = await extractZip(opts.zip, staged, opts.limits);

    await mkdir(dir, { recursive: true });
    await initRepo(dir);
    dirTouched = true;

    // Kosongkan isi kerja, sisakan .git — git yang mencatat penghapusannya.
    for (const name of await readdir(dir)) {
      if (name === ".git") continue;
      await rm(join(dir, name), { recursive: true, force: true });
    }
    await cp(staged, dir, { recursive: true });

    await git(dir, "add", "-A");
    // --allow-empty WAJIB: tanpa ini, mengunggah zip yang sama persis membuat
    // `git commit` exit 1 dan deploy gagal sebelum sempat mulai.
    await git(dir, "commit", "--allow-empty", "-m", `upload ${new Date().toISOString()}`);
  } catch (err) {
    if (dirTouched) {
      // Jangan sampai kegagalan pemulihan menutupi error ASLI yang memicu
      // catch ini — err asli tetap yang dilempar ke pemanggil apa pun yang
      // terjadi di sini.
      await restoreWorkingTree(dir).catch(() => {});
    }
    throw err;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }

  return { dir, extract };
}

/**
 * Kembalikan working tree & index `dir` ke persis commit terakhirnya.
 * deploy.sh mengonsumsi staging repo lewat `git clone` (deploy/deploy.sh:104)
 * — yaitu riwayat yang SUDAH di-commit, bukan working tree — jadi working
 * tree yang kotor tidak pernah membuat deploy manapun (lalu atau nanti)
 * memakai isi yang salah. Fungsi ini membuat jaminan itu nyata, bukan cuma
 * "kebetulan tidak masalah": diverifikasi empiris bahwa `git reset --hard`
 * + `git clean -fd` memulihkan working tree SEPENUHNYA dari riwayat —
 * file yang terhapus kembali, file yang berubah kembali ke isi ter-commit.
 */
async function restoreWorkingTree(dir: string): Promise<void> {
  try {
    await git(dir, "rev-parse", "--verify", "HEAD");
  } catch {
    // Repo baru saja di-init dan belum pernah punya commit sama sekali —
    // HEAD belum lahir, tidak ada riwayat untuk dipulihkan. `git reset
    // --hard HEAD` pada repo begini gagal (unknown revision), jadi jangan
    // dicoba.
    return;
  }
  await git(dir, "reset", "--hard", "HEAD");
  await git(dir, "clean", "-fd");
}

async function initRepo(dir: string): Promise<void> {
  // Cek keberadaan .git SECARA LANGSUNG, jangan pakai `rev-parse --git-dir`:
  // rev-parse BERHASIL kalau direktori induk mana pun kebetulan sebuah repo,
  // sehingga kita akan melewati init lalu `git add -A` dan `commit` beroperasi
  // pada repo induk itu — meng-commit isi upload ke repo yang sama sekali salah.
  if (existsSync(join(dir, ".git"))) return;

  // -b main memastikan HEAD -> refs/heads/main, yang jadi origin/HEAD setelah
  // deploy.sh meng-clone-nya — itulah yang dibaca deploy.sh:109.
  await exec("git", ["init", "-b", "main", dir]);
}
