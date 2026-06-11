const CACHE_NAME = "private-video-vault-v16";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=16",
  "./app.js?v=16",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];
const vaultState = {
  vaultOrigin: "",
  videos: new Map(),
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    }),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "VAULT_CONFIG") return;

  const payload = event.data.payload || {};
  vaultState.vaultOrigin = String(payload.vaultOrigin || "").replace(/\/+$/, "");
  vaultState.videos = new Map();

  for (const video of payload.videos || []) {
    if (video?.id && video?.hls) {
      vaultState.videos.set(String(video.id), video.hls);
    }
  }
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  const vaultRoute = parseVaultRoute(requestUrl);

  if (vaultRoute) {
    event.respondWith(handleVaultRoute(vaultRoute));
    return;
  }

  if (requestUrl.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  cache.put(request, response.clone());
  return response;
}

function parseVaultRoute(url) {
  if (url.origin !== self.location.origin) return null;

  const scopePath = new URL(self.registration.scope).pathname;
  const pathname = url.pathname.startsWith(scopePath)
    ? url.pathname.slice(scopePath.length)
    : url.pathname.replace(/^\/+/, "");

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "__vault" || parts[1] !== "hls" || !parts[2]) {
    return null;
  }

  return {
    videoId: decodeURIComponent(parts[2]),
    action: parts[3] || "",
    variantIndex: Number(parts[4]?.replace(/\.m3u8$/, "") || 0),
  };
}

async function handleVaultRoute(route) {
  const hls = vaultState.videos.get(route.videoId);
  if (!hls) {
    return new Response("Vault item is locked or unavailable.", { status: 404 });
  }

  if (route.action === "master.m3u8" || route.action === "") {
    return playlistResponse(createMasterPlaylist(route.videoId, hls));
  }

  if (route.action === "variant") {
    const variant = hls.variants?.[route.variantIndex];
    if (!variant) return new Response("Variant not found.", { status: 404 });
    return playlistResponse(createMediaPlaylist(route.videoId, hls, variant));
  }

  if (route.action === "key.bin") {
    return new Response(base64ToBytes(hls.key), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
      },
    });
  }

  return new Response("Not found.", { status: 404 });
}

function createMasterPlaylist(videoId, hls) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];

  hls.variants.forEach((variant, index) => {
    const attributes = [`BANDWIDTH=${Math.max(1, Number(variant.bandwidth || 1))}`];
    if (variant.resolution) attributes.push(`RESOLUTION=${variant.resolution}`);
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
    lines.push(`variant/${index}.m3u8`);
  });

  return `${lines.join("\n")}\n`;
}

function createMediaPlaylist(videoId, hls, variant) {
  const keyAttributes = [`METHOD=${hls.method || "AES-128"}`, `URI="../key.bin"`];
  if (hls.iv) keyAttributes.push(`IV=${hls.iv}`);
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

    output.push(line.startsWith("#") ? line : resolveVaultUrl(line));
  }

  if (!keyInserted) output.push(keyLine);
  return `${output.join("\n")}\n`;
}

function resolveVaultUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${vaultState.vaultOrigin}${normalizedPath}`;
}

function playlistResponse(body) {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    },
  });
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
