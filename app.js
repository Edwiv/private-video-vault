const state = {
  vaultOrigin: localStorage.getItem("vaultOrigin") || "",
  manifestPath: localStorage.getItem("manifestPath") || "/library.enc.json",
  videos: [],
};

const sampleLibrary = {
  videos: [
    {
      id: "sample-001",
      title: "本地样片",
      duration: "00:00",
      source: "",
      variants: [{ label: "HLS", src: "" }],
    },
  ],
};

const form = document.querySelector("#vaultForm");
const statusEl = document.querySelector("#appStatus");
const vaultOriginInput = document.querySelector("#vaultOrigin");
const manifestPathInput = document.querySelector("#manifestPath");
const passphraseInput = document.querySelector("#passphrase");
const libraryList = document.querySelector("#libraryList");
const libraryCount = document.querySelector("#libraryCount");
const videoPlayer = document.querySelector("#videoPlayer");
const nowPlayingTitle = document.querySelector("#nowPlayingTitle");
const nowPlayingMeta = document.querySelector("#nowPlayingMeta");
const template = document.querySelector("#videoItemTemplate");

vaultOriginInput.value = state.vaultOrigin;
manifestPathInput.value = state.manifestPath;

renderLibrary([]);
registerServiceWorker();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("正在解锁");

  const vaultOrigin = normalizeOrigin(vaultOriginInput.value);
  const manifestPath = normalizePath(manifestPathInput.value);
  const passphrase = passphraseInput.value;

  try {
    const encryptedManifest = await fetchEncryptedManifest(vaultOrigin, manifestPath);
    const library = await decryptManifest(encryptedManifest, passphrase);
    state.vaultOrigin = vaultOrigin;
    state.manifestPath = manifestPath;
    state.videos = normalizeLibrary(library);
    localStorage.setItem("vaultOrigin", vaultOrigin);
    localStorage.setItem("manifestPath", manifestPath);
    renderLibrary(state.videos);
    setStatus("已解锁");
  } catch (error) {
    console.error(error);
    setStatus("解锁失败");
    renderLibrary([]);
  }
});

document.querySelector("#loadSampleButton").addEventListener("click", () => {
  state.videos = normalizeLibrary(sampleLibrary);
  renderLibrary(state.videos);
  setStatus("示例已载入");
});

document.querySelector("#clearConfigButton").addEventListener("click", () => {
  localStorage.removeItem("vaultOrigin");
  localStorage.removeItem("manifestPath");
  vaultOriginInput.value = "";
  manifestPathInput.value = "/library.enc.json";
  passphraseInput.value = "";
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  nowPlayingTitle.textContent = "未选择视频";
  nowPlayingMeta.textContent = "等待解锁片库";
  renderLibrary([]);
  setStatus("配置已清除");
});

async function fetchEncryptedManifest(vaultOrigin, manifestPath) {
  const response = await fetch(`${vaultOrigin}${manifestPath}`, {
    cache: "no-store",
    mode: "cors",
  });

  if (!response.ok) {
    throw new Error(`Manifest request failed: ${response.status}`);
  }

  return response.json();
}

async function decryptManifest(envelope, passphrase) {
  if (!envelope || envelope.version !== 1) {
    throw new Error("Unsupported manifest envelope");
  }

  if (envelope.cipher !== "AES-GCM" || envelope.kdf?.name !== "PBKDF2") {
    throw new Error("Unsupported crypto settings");
  }

  const salt = fromBase64(envelope.kdf.salt);
  const iv = fromBase64(envelope.iv);
  const data = fromBase64(envelope.data);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: envelope.kdf.hash || "SHA-256",
      salt,
      iterations: envelope.kdf.iterations || 310000,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function normalizeLibrary(library) {
  const videos = Array.isArray(library?.videos) ? library.videos : [];
  return videos.map((video) => ({
    id: String(video.id || crypto.randomUUID()),
    title: String(video.title || "未命名视频"),
    duration: String(video.duration || "未知时长"),
    source: String(video.source || video.variants?.[0]?.src || ""),
    variants: Array.isArray(video.variants) ? video.variants : [],
  }));
}

function renderLibrary(videos) {
  libraryList.textContent = "";
  libraryCount.textContent = String(videos.length);

  if (!videos.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "片库为空";
    libraryList.append(empty);
    return;
  }

  for (const video of videos) {
    const item = template.content.firstElementChild.cloneNode(true);
    item.querySelector("strong").textContent = video.title;
    item.querySelector("small").textContent = video.duration;
    item.addEventListener("click", () => playVideo(video));
    libraryList.append(item);
  }
}

function playVideo(video) {
  const src = resolveVideoSource(video);
  nowPlayingTitle.textContent = video.title;
  nowPlayingMeta.textContent = video.duration;

  if (!src) {
    setStatus("未配置片源");
    return;
  }

  videoPlayer.src = src;
  videoPlayer.play().catch(() => {
    setStatus("等待手动播放");
  });
}

function resolveVideoSource(video) {
  const source = video.source || video.variants?.[0]?.src || "";
  if (!source) return "";
  if (/^https?:\/\//i.test(source)) return source;
  return `${state.vaultOrigin}${normalizePath(source)}`;
}

function normalizeOrigin(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Vault origin must be an HTTP(S) URL");
  }
  return trimmed;
}

function normalizePath(value) {
  const trimmed = value.trim() || "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function setStatus(message) {
  statusEl.textContent = message;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    setStatus("浏览器未支持");
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}
