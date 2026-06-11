import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const options = parseArgs(process.argv.slice(2));
const { sourcePath, targetRoot } = options;

if (!sourcePath) {
  console.error("Usage: node tools/build-demo-vault.mjs <source.mp4> [target-dir] [--mode copy|transcode] [--title name]");
  process.exit(1);
}

const passphrase = process.env.VIDEO_VAULT_PASSPHRASE || (await askHidden("Master key: "));

if (!passphrase) {
  console.error("Master key is required.");
  process.exit(1);
}

const videoId = randomBytes(16).toString("hex");
const objectPrefix = `/objects/${videoId}`;
const objectDir = join(targetRoot, "objects", videoId);
const rawPlaylistPath = join(objectDir, "playlist.raw.m3u8");
const keyPath = join(objectDir, ".content-key.bin");
const keyInfoPath = join(objectDir, ".hls-key-info");
const contentKey = randomBytes(16);
const iv = randomBytes(16).toString("hex");

await mkdir(objectDir, { recursive: true });
await writeFile(keyPath, contentKey, { mode: 0o600 });
await writeFile(keyInfoPath, [`key.bin`, keyPath, iv].join("\n"), { mode: 0o600 });

const sourceInfo = await probeSource(sourcePath);
const title = options.title || basename(sourcePath, extname(sourcePath));

try {
  console.log(`Import mode: ${options.mode === "copy" ? "copy original streams, no compression" : "transcode"}`);
  warnIfCopyMayBeUnsupported(sourceInfo, options.mode);
  await run("ffmpeg", createFfmpegArgs());

  const rawPlaylist = await readFile(rawPlaylistPath, "utf8");
  const library = {
    version: 1,
    createdAt: new Date().toISOString(),
    videos: [
      {
        id: videoId,
        title,
        duration: formatDuration(sourceInfo.duration),
        hls: {
          method: "AES-128",
          key: contentKey.toString("base64"),
          iv: `0x${iv}`,
          variants: [
            {
              label: options.mode === "copy" ? "Original" : "720p",
              bandwidth: estimateBandwidth(sourceInfo, options.mode),
              resolution: formatResolution(sourceInfo, options.mode),
              playlist: normalizeMediaPlaylist(rawPlaylist, objectPrefix),
            },
          ],
        },
      },
    ],
  };

  await writeEncryptedLibrary(library, passphrase, join(targetRoot, "library.enc.json"));
  console.log(`Demo vault written to ${targetRoot}`);
  console.log(`Video id: ${videoId}`);
} finally {
  await rm(keyPath, { force: true });
  await rm(keyInfoPath, { force: true });
  await rm(rawPlaylistPath, { force: true });
}

function parseArgs(args) {
  const parsed = {
    mode: "copy",
    sourcePath: "",
    targetRoot: "demo-vault",
    title: "",
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--mode") {
      parsed.mode = String(args[++index] || "");
    } else if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
    } else if (arg === "--title") {
      parsed.title = String(args[++index] || "");
    } else if (arg.startsWith("--title=")) {
      parsed.title = arg.slice("--title=".length);
    } else {
      positional.push(arg);
    }
  }

  if (!["copy", "transcode"].includes(parsed.mode)) {
    throw new Error("--mode must be copy or transcode");
  }

  parsed.sourcePath = positional[0] || "";
  parsed.targetRoot = positional[1] || "demo-vault";
  return parsed;
}

function createFfmpegArgs() {
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

function warnIfCopyMayBeUnsupported(info, mode) {
  if (mode !== "copy") return;
  const supportedVideo = ["h264"].includes(info.videoCodec);
  const supportedAudio = ["aac", "mp3"].includes(info.audioCodec) || !info.audioCodec;

  if (!supportedVideo || !supportedAudio) {
    console.warn(
      `Warning: stream-copy mode keeps codecs as-is. iPhone HLS playback is most reliable with H.264/AAC; found ${info.videoCodec || "unknown"}/${info.audioCodec || "none"}.`,
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

async function writeEncryptedLibrary(library, passphrase, targetPath) {
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

  await mkdir(targetRoot, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

function formatResolution(info, mode) {
  if (!info.width || !info.height) return "";
  if (mode === "copy") return `${info.width}x${info.height}`;
  const width = Math.min(1280, info.width);
  const height = Math.max(2, Math.round((info.height * width) / info.width / 2) * 2);
  return `${width}x${height}`;
}

function estimateBandwidth(info, mode) {
  if (mode === "transcode") return 2800000;
  return Math.max(1, info.formatBitrate || info.videoBitrate + info.audioBitrate || 1);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
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
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
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
