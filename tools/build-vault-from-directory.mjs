import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { readdir, readFile, rm, stat, statfs, writeFile, mkdir } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { stdin as input, stdout as output } from "node:process";

const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".ts"]);
const options = parseArgs(process.argv.slice(2));

if (!options.sourceRoot) {
  console.error(
    "Usage: node tools/build-vault-from-directory.mjs <source-dir> [target-dir] [--mode copy|transcode] [--force] [--verify] [--jobs n] [--max-load n] [--min-free-mem-gb n] [--min-free-disk-gb n] [--redact-paths] [--passphrase-stdin] [--recipient-public-key public.pem]",
  );
  process.exit(1);
}

const sourceRoot = resolve(options.sourceRoot);
const targetRoot = resolve(options.targetRoot);
const libraryPath = join(targetRoot, "library.enc.json");
const recipientPublicKey = await readRecipientPublicKey();
const passphrase = recipientPublicKey ? "" : await readPassphrase();

if (!recipientPublicKey && !passphrase) {
  console.error("Master key is required.");
  process.exit(1);
}

if (options.force) {
  await rm(targetRoot, { recursive: true, force: true });
}

await mkdir(targetRoot, { recursive: true });

const sourceFiles = await findVideoFiles(sourceRoot);
const library = await readExistingLibrary();
const importedPaths = new Set((library.videos || []).map((video) => video.path).filter(Boolean));
const failures = [];
const skippedEmpty = [];

console.log(`Source root: ${displayPath(sourceRoot)}`);
console.log(`Target root: ${displayPath(targetRoot)}`);
console.log(`Video files: ${sourceFiles.length}`);
console.log(`Already imported: ${importedPaths.size}`);
console.log(`Mode: ${options.mode === "copy" ? "copy original streams, no compression" : "transcode"}`);
console.log(`Manifest crypto: ${recipientPublicKey ? "recipient public key" : "legacy passphrase"}`);
console.log(`Jobs: ${options.jobs}`);
console.log(
  `Resource guard: max load ${options.maxLoad.toFixed(1)}, min memory ${formatBytes(options.minFreeMemBytes)}, min disk ${formatBytes(options.minFreeDiskBytes)}`,
);

await writeEncryptedLibrary(library, libraryPath);

await importVideosConcurrently(sourceFiles);

if (options.verify) {
  console.log("Verifying encrypted library and HLS entries...");
  const verifiedLibrary = recipientPublicKey ? library : await readEncryptedLibrary(libraryPath);
  const verifyFailures = await verifyLibrary(verifiedLibrary);
  failures.push(...verifyFailures);
}

console.log(`Imported videos: ${library.videos.length}`);
console.log(`Skipped empty files: ${skippedEmpty.length}`);
console.log(`Failures: ${failures.length}`);

if (failures.length) {
  for (const failure of failures) {
    console.error(`FAIL ${displayPath(failure.path)}: ${failure.error}`);
  }
  process.exit(2);
}

async function findVideoFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true }));

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && videoExtensions.has(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}

async function readExistingLibrary() {
  if (options.force) {
    return createEmptyLibrary();
  }

  if (recipientPublicKey) {
    try {
      await stat(libraryPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return createEmptyLibrary();
      }
      throw error;
    }

    throw new Error("Recipient public key mode cannot resume an existing encrypted library. Use --force.");
  }

  try {
    return await readEncryptedLibrary(libraryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createEmptyLibrary();
    }
    throw error;
  }
}

function createEmptyLibrary() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    videos: [],
  };
}

async function importVideosConcurrently(files) {
  let nextIndex = 0;
  let writeQueue = Promise.resolve();

  async function writeLibraryQueued() {
    writeQueue = writeQueue.then(() => writeEncryptedLibrary(library, libraryPath));
    return writeQueue;
  }

  async function worker(workerId) {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) return;
      await importOne(files[index], index, workerId, writeLibraryQueued);
    }
  }

  const workerCount = Math.max(1, Math.min(options.jobs, files.length || 1));
  await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));
  await writeQueue;
}

async function importOne(sourcePath, index, workerId, writeLibraryQueued) {
  const relativePath = toVaultPath(relative(sourceRoot, sourcePath));
  const libraryItemPath = stripExtensionPath(relativePath);

  if (importedPaths.has(libraryItemPath)) {
    logProgress(index, "skip", relativePath, workerId);
    return;
  }

  try {
    const sourceStat = await stat(sourcePath);
    if (sourceStat.size === 0) {
      skippedEmpty.push(relativePath);
      logProgress(index, "skip empty", relativePath, workerId, "warn");
      return;
    }

    await waitForResources(workerId);
    logProgress(index, "import", relativePath, workerId);
    const video = await importVideo(sourcePath, relativePath, libraryItemPath);
    Object.defineProperty(video, "__order", {
      value: index,
      enumerable: false,
    });
    library.videos.push(video);
    library.videos.sort((left, right) => (left.__order ?? 0) - (right.__order ?? 0));
    importedPaths.add(libraryItemPath);
    await writeLibraryQueued();
  } catch (error) {
    const errorMessage = redactMessage(error.message || String(error));
    failures.push({ path: relativePath, error: errorMessage });
    logProgress(index, "failed", relativePath, workerId, "error");
    console.error(errorMessage);
  }
}

function logProgress(index, action, relativePath, workerId, level = "log") {
  const message = `[${index + 1}/${sourceFiles.length} w${workerId}] ${action} ${displayPath(relativePath)}`;
  console[level](message);
}

async function waitForResources(workerId) {
  while (true) {
    const usage = await readResourceUsage();
    const loadOk = usage.load1 <= options.maxLoad;
    const memOk = usage.freeMemBytes >= options.minFreeMemBytes;
    const diskOk = usage.freeDiskBytes >= options.minFreeDiskBytes;

    if (loadOk && memOk && diskOk) {
      return;
    }

    console.warn(
      `[resource w${workerId}] waiting load=${usage.load1.toFixed(2)} freeMem=${formatBytes(usage.freeMemBytes)} freeDisk=${formatBytes(usage.freeDiskBytes)}`,
    );
    await sleep(5000);
  }
}

async function readResourceUsage() {
  const fsStats = await statfs(targetRoot);
  return {
    load1: loadavg()[0] || 0,
    freeMemBytes: await readAvailableMemoryBytes(),
    freeDiskBytes: Number(fsStats.bavail) * Number(fsStats.bsize),
  };
}

async function readAvailableMemoryBytes() {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // Fall back below on non-Linux hosts.
  }

  return Number.MAX_SAFE_INTEGER;
}

async function importVideo(sourcePath, relativePath, libraryItemPath) {
  const videoId = randomBytes(16).toString("hex");
  const objectPrefix = `/objects/${videoId}`;
  const objectDir = join(targetRoot, "objects", videoId);
  const rawPlaylistPath = join(objectDir, "playlist.raw.m3u8");
  const keyPath = join(objectDir, ".content-key.bin");
  const keyInfoPath = join(objectDir, ".hls-key-info");
  const contentKey = randomBytes(16);
  const iv = randomBytes(16).toString("hex");
  const sourceInfo = await probeSource(sourcePath);

  await mkdir(objectDir, { recursive: true });
  await writeFile(keyPath, contentKey, { mode: 0o600 });
  await writeFile(keyInfoPath, ["key.bin", keyPath, iv].join("\n"), { mode: 0o600 });

  try {
    warnIfCopyMayBeUnsupported(sourceInfo, relativePath);
    await run("ffmpeg", createFfmpegArgs(sourcePath, objectDir, keyInfoPath, rawPlaylistPath));
    const rawPlaylist = await readFile(rawPlaylistPath, "utf8");

    return {
      id: videoId,
      title: basename(libraryItemPath),
      path: libraryItemPath,
      duration: formatDuration(sourceInfo.duration),
      hls: {
        method: "AES-128",
        key: contentKey.toString("base64"),
        iv: `0x${iv}`,
        variants: [
          {
            label: options.mode === "copy" ? "Original" : "720p",
            bandwidth: estimateBandwidth(sourceInfo),
            resolution: formatResolution(sourceInfo),
            playlist: normalizeMediaPlaylist(rawPlaylist, objectPrefix),
          },
        ],
      },
    };
  } catch (error) {
    await rm(objectDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(keyPath, { force: true });
    await rm(keyInfoPath, { force: true });
    await rm(rawPlaylistPath, { force: true });
  }
}

function createFfmpegArgs(sourcePath, objectDir, keyInfoPath, rawPlaylistPath) {
  const common = [
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
  ];

  const hls = [
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    join(objectDir, "segment_%05d.ts"),
    "-hls_key_info_file",
    keyInfoPath,
    rawPlaylistPath,
  ];

  if (options.mode === "copy") {
    return [...common, "-c", "copy", ...hls];
  }

  return [
    ...common,
    "-vf",
    "scale='min(1280,iw)':-2",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    "2600k",
    "-bufsize",
    "5200k",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    ...hls,
  ];
}

async function probeSource(path) {
  const outputText = await capture("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,bit_rate",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,bit_rate",
    "-of",
    "json",
    path,
  ]);
  const outputJson = JSON.parse(outputText);
  const streams = Array.isArray(outputJson.streams) ? outputJson.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") || {};
  const audio = streams.find((stream) => stream.codec_type === "audio") || {};

  return {
    duration: Number(outputJson.format?.duration || 0),
    formatBitrate: Number(outputJson.format?.bit_rate || 0),
    videoCodec: String(video.codec_name || ""),
    audioCodec: String(audio.codec_name || ""),
    videoBitrate: Number(video.bit_rate || 0),
    audioBitrate: Number(audio.bit_rate || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
  };
}

function warnIfCopyMayBeUnsupported(info, relativePath) {
  if (options.mode !== "copy") return;
  const supportedVideo = ["h264", "hevc"].includes(info.videoCodec);
  const supportedAudio = ["aac", "mp3", "alac"].includes(info.audioCodec) || !info.audioCodec;

  if (!supportedVideo || !supportedAudio) {
    console.warn(
      `Warning: ${displayPath(relativePath)} keeps codecs as-is. iPhone HLS playback is most reliable with H.264 or HEVC video and AAC audio; found ${info.videoCodec || "unknown"}/${info.audioCodec || "none"}.`,
    );
  }
}

function normalizeMediaPlaylist(playlist, objectPrefix) {
  return playlist
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#EXT-X-KEY"))
    .map((line) => {
      if (line.startsWith("#")) return line;
      return `${objectPrefix}/${basename(line)}`;
    })
    .join("\n");
}

async function verifyLibrary(library) {
  const failures = [];
  const verifyRoot = join(targetRoot, `.verify-${randomBytes(8).toString("hex")}`);
  await mkdir(verifyRoot, { recursive: true });

  try {
    for (let index = 0; index < library.videos.length; index += 1) {
      const video = library.videos[index];
      const variant = video.hls?.variants?.[0];

      if (!video.hls?.key || !variant?.playlist) {
        failures.push({ path: video.path || video.title || video.id, error: "missing HLS key or playlist" });
        continue;
      }

      try {
        await verifyVideo(video, variant, verifyRoot);
        console.log(`[verify ${index + 1}/${library.videos.length}] ok ${displayPath(video.path || video.title)}`);
      } catch (error) {
        failures.push({ path: video.path || video.title || video.id, error: error.message || String(error) });
      }
    }
  } finally {
    await rm(verifyRoot, { recursive: true, force: true });
  }

  return failures;
}

async function verifyVideo(video, variant, verifyRoot) {
  const videoRoot = join(verifyRoot, video.id);
  await mkdir(videoRoot, { recursive: true });

  const keyPath = join(videoRoot, "key.bin");
  const playlistPath = join(videoRoot, "playlist.m3u8");
  await writeFile(keyPath, Buffer.from(video.hls.key, "base64"), { mode: 0o600 });
  await writeFile(playlistPath, createVerificationPlaylist(video, variant, keyPath), { mode: 0o600 });

  const outputText = await capture("ffprobe", [
    "-v",
    "error",
    "-allowed_extensions",
    "ALL",
    "-protocol_whitelist",
    "file,crypto,data",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    playlistPath,
  ]);
  const outputJson = JSON.parse(outputText || "{}");
  const duration = Number(outputJson.format?.duration || 0);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe returned an invalid duration");
  }
}

function createVerificationPlaylist(video, variant, keyPath) {
  const keyAttributes = [`METHOD=${video.hls.method || "AES-128"}`, `URI="${keyPath}"`];
  if (video.hls.iv) keyAttributes.push(`IV=${video.hls.iv}`);
  const keyLine = `#EXT-X-KEY:${keyAttributes.join(",")}`;
  const lines = String(variant.playlist || "").split(/\r?\n/);
  const output = [];
  let keyInserted = false;

  for (const line of lines) {
    if (!line || line.startsWith("#EXT-X-KEY")) continue;

    if (!keyInserted && (line.startsWith("#EXTINF") || (!line.startsWith("#") && line.trim()))) {
      output.push(keyLine);
      keyInserted = true;
    }

    output.push(line.startsWith("#") ? line : resolveVaultFile(line));
  }

  if (!keyInserted) output.push(keyLine);
  return `${output.join("\n")}\n`;
}

function resolveVaultFile(path) {
  if (path.startsWith("/")) return join(targetRoot, path);
  return join(targetRoot, path);
}

async function readEncryptedLibrary(path) {
  const envelope = JSON.parse(await readFile(path, "utf8"));
  const data = Buffer.from(envelope.data, "base64");
  const salt = Buffer.from(envelope.kdf.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const key = pbkdf2Sync(passphrase, salt, envelope.kdf.iterations || 310000, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(data.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function writeEncryptedLibrary(library, path) {
  if (recipientPublicKey) {
    return writeRecipientEncryptedLibrary(library, path);
  }

  return writePassphraseEncryptedLibrary(library, path);
}

async function writePassphraseEncryptedLibrary(library, path) {
  const plaintext = Buffer.from(`${JSON.stringify(library, null, 2)}\n`, "utf8");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const iterations = 310000;
  const key = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    version: 1,
    cipher: "AES-GCM",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: salt.toString("base64"),
    },
    iv: iv.toString("base64"),
    data: Buffer.concat([encrypted, tag]).toString("base64"),
  };

  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

async function writeRecipientEncryptedLibrary(library, path) {
  const plaintext = Buffer.from(`${JSON.stringify(library, null, 2)}\n`, "utf8");
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt(
    {
      key: recipientPublicKey,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    contentKey,
  );
  const envelope = {
    version: 2,
    cipher: "AES-GCM",
    keyWrap: {
      name: "RSA-OAEP",
      hash: "SHA-256",
      publicKeyFingerprint: publicKeyFingerprint(recipientPublicKey),
      wrappedKey: wrappedKey.toString("base64"),
    },
    iv: iv.toString("base64"),
    data: Buffer.concat([encrypted, tag]).toString("base64"),
  };

  contentKey.fill(0);
  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

function publicKeyFingerprint(publicKeyPem) {
  const der = Buffer.from(
    String(publicKeyPem)
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, ""),
    "base64",
  );
  return `sha256:${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

function formatResolution(info) {
  if (!info.width || !info.height) return "";
  if (options.mode === "copy") return `${info.width}x${info.height}`;
  const width = Math.min(1280, info.width);
  const height = Math.max(2, Math.round((info.height * width) / info.width / 2) * 2);
  return `${width}x${height}`;
}

function estimateBandwidth(info) {
  if (options.mode === "transcode") return 2800000;
  return Math.max(1, info.formatBitrate || info.videoBitrate + info.audioBitrate || 1);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":");
}

function stripExtensionPath(path) {
  const parent = dirname(path);
  const name = basename(path, extname(path));
  return parent === "." ? name : `${parent}/${name}`;
}

function toVaultPath(path) {
  return path.split(sep).filter(Boolean).join("/");
}

function displayPath(path) {
  return options.redactPaths ? "[redacted]" : path;
}

function redactMessage(message) {
  const text = String(message || "");
  if (!options.redactPaths) return text;

  const videoExtPattern = Array.from(videoExtensions)
    .map((extension) => escapeRegExp(extension))
    .join("|");

  return text
    .replace(new RegExp(`${escapeRegExp(sourceRoot)}[^\\r\\n]*?(?:${videoExtPattern})`, "giu"), "[redacted]")
    .replace(new RegExp(`${escapeRegExp(targetRoot)}[^\\r\\n\\s]*`, "g"), "[redacted]");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Number(bytes || 0);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
}

function parseArgs(args) {
  const gib = 1024 ** 3;
  const parsed = {
    force: false,
    jobs: 1,
    maxLoad: Math.max(1, cpus().length * 0.75),
    minFreeDiskBytes: 100 * gib,
    minFreeMemBytes: 4 * gib,
    mode: "copy",
    passphraseStdin: false,
    recipientPublicKeyPath: "",
    redactPaths: false,
    sourceRoot: "",
    targetRoot: "vault-next",
    verify: false,
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--verify") {
      parsed.verify = true;
    } else if (arg === "--redact-paths") {
      parsed.redactPaths = true;
    } else if (arg === "--passphrase-stdin") {
      parsed.passphraseStdin = true;
    } else if (arg === "--jobs") {
      parsed.jobs = parsePositiveInteger("--jobs", args[++index]);
    } else if (arg.startsWith("--jobs=")) {
      parsed.jobs = parsePositiveInteger("--jobs", arg.slice("--jobs=".length));
    } else if (arg === "--max-load") {
      parsed.maxLoad = parsePositiveNumber("--max-load", args[++index]);
    } else if (arg.startsWith("--max-load=")) {
      parsed.maxLoad = parsePositiveNumber("--max-load", arg.slice("--max-load=".length));
    } else if (arg === "--min-free-mem-gb") {
      parsed.minFreeMemBytes = parsePositiveNumber("--min-free-mem-gb", args[++index]) * gib;
    } else if (arg.startsWith("--min-free-mem-gb=")) {
      parsed.minFreeMemBytes = parsePositiveNumber("--min-free-mem-gb", arg.slice("--min-free-mem-gb=".length)) * gib;
    } else if (arg === "--min-free-disk-gb") {
      parsed.minFreeDiskBytes = parsePositiveNumber("--min-free-disk-gb", args[++index]) * gib;
    } else if (arg.startsWith("--min-free-disk-gb=")) {
      parsed.minFreeDiskBytes =
        parsePositiveNumber("--min-free-disk-gb", arg.slice("--min-free-disk-gb=".length)) * gib;
    } else if (arg === "--recipient-public-key") {
      parsed.recipientPublicKeyPath = String(args[++index] || "");
    } else if (arg.startsWith("--recipient-public-key=")) {
      parsed.recipientPublicKeyPath = arg.slice("--recipient-public-key=".length);
    } else if (arg === "--mode") {
      parsed.mode = String(args[++index] || "");
    } else if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
    } else {
      positional.push(arg);
    }
  }

  if (!["copy", "transcode"].includes(parsed.mode)) {
    throw new Error("--mode must be copy or transcode");
  }

  parsed.sourceRoot = positional[0] || "";
  parsed.targetRoot = positional[1] || "vault-next";
  return parsed;
}

function parsePositiveInteger(name, value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(name, value) {
  const parsed = Number(String(value || ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

async function readPassphrase() {
  if (process.env.VIDEO_VAULT_PASSPHRASE) {
    return process.env.VIDEO_VAULT_PASSPHRASE;
  }

  if (options.passphraseStdin) {
    const chunks = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }

  return askHidden("Master key: ");
}

async function readRecipientPublicKey() {
  const inlineKey = process.env.VIDEO_VAULT_RECIPIENT_PUBLIC_KEY || "";
  if (inlineKey.trim()) {
    return inlineKey.trim();
  }

  if (!options.recipientPublicKeyPath) {
    return "";
  }

  return readFile(resolve(options.recipientPublicKeyPath), "utf8");
}

function run(command, args) {
  return capture(command, args).then(() => undefined);
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(redactMessage(stderr) || `${command} exited with ${code}`));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function askHidden(query) {
  if (!input.isTTY) {
    return "";
  }

  const rl = createInterface({ input, output });
  const originalWrite = output.write;
  output.write = function writeHidden(text, encoding, callback) {
    if (text.includes(query)) {
      return originalWrite.call(output, text, encoding, callback);
    }
    return true;
  };

  try {
    const answer = await rl.question(query);
    originalWrite.call(output, "\n");
    return answer;
  } finally {
    output.write = originalWrite;
    rl.close();
  }
}
