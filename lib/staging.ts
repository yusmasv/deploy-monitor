import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip, type ExtractResult, type ZipLimits } from "./intake";

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
  const dir = join(opts.uploadsDir, opts.project);

  // Extract ke temp DULU. Zip yang ditolak tidak boleh menyentuh staging repo
  // yang sudah berisi upload sebelumnya yang baik-baik saja.
  const staged = await mkdtemp(join(tmpdir(), "dm-extract-"));
  let extract: ExtractResult;
  try {
    extract = await extractZip(opts.zip, staged, opts.limits);

    await mkdir(dir, { recursive: true });
    await initRepo(dir);

    // Kosongkan isi kerja, sisakan .git — git yang mencatat penghapusannya.
    for (const name of await readdir(dir)) {
      if (name === ".git") continue;
      await rm(join(dir, name), { recursive: true, force: true });
    }
    await cp(staged, dir, { recursive: true });
  } finally {
    await rm(staged, { recursive: true, force: true });
  }

  await git(dir, "add", "-A");
  // --allow-empty WAJIB: tanpa ini, mengunggah zip yang sama persis membuat
  // `git commit` exit 1 dan deploy gagal sebelum sempat mulai.
  await git(dir, "commit", "--allow-empty", "-m", `upload ${new Date().toISOString()}`);

  return { dir, extract };
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
