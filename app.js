const state = {
  vaultOrigin: localStorage.getItem("vaultOrigin") || "",
  manifestPath: localStorage.getItem("manifestPath") || "/library.enc.json",
  videos: [],
  currentVideoId: "",
};

const sampleLibrary = {
  videos: [
    {
      id: "sample-001",
      title: "本地样片",
      path: "示例/本地样片",
      duration: "00:00",
      source: "",
      hls: {
        key: "",
        iv: "",
        variants: [{ label: "HLS", bandwidth: 0, playlist: "" }],
      },
    },
    {
      id: "sample-002",
      title: "文件夹样片",
      path: "示例/子文件夹/文件夹样片",
      duration: "00:00",
      source: "",
      hls: {
        key: "",
        iv: "",
        variants: [{ label: "HLS", bandwidth: 0, playlist: "" }],
      },
    },
  ],
};

const collator = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

let serviceWorkerReady = registerServiceWorker();

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
    await configureServiceWorker();
    renderLibrary(state.videos);
    setStatus("已解锁");
  } catch (error) {
    console.error(error);
    state.videos = [];
    state.currentVideoId = "";
    setStatus("解锁失败");
    renderLibrary([]);
  }
});

document.querySelector("#loadSampleButton").addEventListener("click", () => {
  state.videos = normalizeLibrary(sampleLibrary);
  configureServiceWorker().catch((error) => console.warn("Sample worker sync failed", error));
  renderLibrary(state.videos);
  setStatus("示例已载入");
});

document.querySelector("#clearConfigButton").addEventListener("click", () => {
  localStorage.removeItem("vaultOrigin");
  localStorage.removeItem("manifestPath");
  vaultOriginInput.value = "";
  manifestPathInput.value = "/library.enc.json";
  passphraseInput.value = "";
  state.videos = [];
  state.currentVideoId = "";
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  nowPlayingTitle.textContent = "未选择视频";
  nowPlayingMeta.textContent = "等待解锁片库";
  configureServiceWorker().catch((error) => console.warn("Worker clear failed", error));
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
  return collectLibraryVideos(library).map(({ video, parentSegments }) => normalizeVideo(video, parentSegments));
}

function collectLibraryVideos(library) {
  const collected = [];

  appendVideos(library?.videos, []);
  appendFolders(library?.folders, []);
  appendFolders(library?.directories, []);

  return collected;

  function appendVideos(videos, parentSegments) {
    if (!Array.isArray(videos)) return;

    for (const video of videos) {
      if (video && typeof video === "object") {
        collected.push({ video, parentSegments });
      }
    }
  }

  function appendFolders(folders, parentSegments) {
    if (!Array.isArray(folders)) return;

    for (const folder of folders) {
      if (!folder || typeof folder !== "object") continue;

      const folderSegments = pathSegments(folder.path || folder.name || folder.title || "");
      const currentSegments = [...parentSegments, ...folderSegments];
      appendVideos(folder.videos, currentSegments);
      appendVideos(folder.files, currentSegments);

      const childFolders = [];
      const childVideos = [];
      for (const child of Array.isArray(folder.children) ? folder.children : []) {
        if (!child || typeof child !== "object") continue;
        if (looksLikeVideo(child)) childVideos.push(child);
        else childFolders.push(child);
      }

      appendVideos(childVideos, currentSegments);
      appendFolders(folder.folders, currentSegments);
      appendFolders(folder.directories, currentSegments);
      appendFolders(childFolders, currentSegments);
    }
  }
}

function normalizeVideo(video, parentSegments) {
  const path = videoPathSegments(video, parentSegments);
  const titleFromPath = path.at(-1) || "";
  const title = String(video.title || titleFromPath || "未命名视频");
  const folderSegments = path.length > 1 ? path.slice(0, -1) : parentSegments;

  return {
    id: String(video.id || crypto.randomUUID()),
    title,
    path: [...folderSegments, title].join("/"),
    folderSegments,
    duration: String(video.duration || "未知时长"),
    source: String(video.source || video.variants?.[0]?.src || ""),
    variants: Array.isArray(video.variants) ? video.variants : [],
    hls: normalizeHls(video.hls),
  };
}

function videoPathSegments(video, parentSegments) {
  const explicitPath = pathSegments(video.path || "");
  if (explicitPath.length) return [...parentSegments, ...explicitPath];

  const folderSegments = pathSegments(video.folder || video.directory || video.folders || []);
  const title = String(video.title || "");
  return [...parentSegments, ...folderSegments, title].filter(Boolean);
}

function pathSegments(value) {
  const rawSegments = Array.isArray(value) ? value : String(value || "").split(/[\\/]+/);
  return rawSegments
    .flatMap((segment) => (Array.isArray(segment) ? pathSegments(segment) : [segment]))
    .map((segment) => String(segment).trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
}

function looksLikeVideo(node) {
  return Boolean(node.hls || node.source || node.variants || node.duration);
}

function normalizeHls(hls) {
  if (!hls || typeof hls !== "object") return null;

  const variants = Array.isArray(hls.variants)
    ? hls.variants.map((variant, index) => ({
        id: String(variant.id || index),
        label: String(variant.label || `Variant ${index + 1}`),
        bandwidth: Number(variant.bandwidth || 0),
        resolution: String(variant.resolution || ""),
        playlist: String(variant.playlist || ""),
      }))
    : [];

  return {
    key: String(hls.key || ""),
    iv: String(hls.iv || ""),
    method: String(hls.method || "AES-128"),
    variants,
  };
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

  const tree = buildLibraryTree(videos);
  const fragment = document.createDocumentFragment();

  for (const folder of sortedFolders(tree)) {
    fragment.append(renderFolderNode(folder));
  }

  for (const video of sortedVideos(tree.videos)) {
    fragment.append(renderVideoItem(video));
  }

  libraryList.append(fragment);
}

function buildLibraryTree(videos) {
  const root = createFolder("", "");

  for (const video of videos) {
    root.count += 1;
    let folder = root;

    for (const segment of video.folderSegments) {
      const key = segment.toLocaleLowerCase();
      if (!folder.folders.has(key)) {
        folder.folders.set(key, createFolder(segment, [...folder.pathSegments, segment].join("/")));
      }
      folder = folder.folders.get(key);
      folder.count += 1;
    }

    folder.videos.push(video);
  }

  return root;
}

function createFolder(name, path) {
  return {
    name,
    path,
    pathSegments: path ? path.split("/") : [],
    folders: new Map(),
    videos: [],
    count: 0,
  };
}

function renderFolderNode(folder) {
  const details = document.createElement("details");
  details.className = "folder-node";
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "folder-summary";

  const arrow = document.createElement("span");
  arrow.className = "folder-arrow";
  arrow.setAttribute("aria-hidden", "true");

  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = folder.name;

  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = String(folder.count);

  summary.append(arrow, icon, name, count);

  const children = document.createElement("div");
  children.className = "folder-children";

  for (const childFolder of sortedFolders(folder)) {
    children.append(renderFolderNode(childFolder));
  }

  for (const video of sortedVideos(folder.videos)) {
    children.append(renderVideoItem(video));
  }

  details.append(summary, children);
  return details;
}

function renderVideoItem(video) {
  const item = template.content.firstElementChild.cloneNode(true);
  item.dataset.videoId = video.id;
  item.title = video.path || video.title;
  item.querySelector("strong").textContent = video.title;
  item.querySelector("small").textContent = videoMeta(video);
  item.addEventListener("click", () => playVideo(video));

  if (video.id === state.currentVideoId) {
    item.setAttribute("aria-current", "true");
  }

  return item;
}

function sortedFolders(folder) {
  return [...folder.folders.values()].sort((left, right) => collator.compare(left.name, right.name));
}

function sortedVideos(videos) {
  return [...videos].sort((left, right) => collator.compare(left.title, right.title));
}

function videoMeta(video) {
  const variant = video.hls?.variants?.[0];
  return [video.duration, variant?.label, variant?.resolution].filter(Boolean).join(" / ");
}

function playVideo(video) {
  const src = resolveVideoSource(video);
  state.currentVideoId = video.id;
  nowPlayingTitle.textContent = video.title;
  nowPlayingMeta.textContent = [video.duration, video.path].filter(Boolean).join(" / ");
  markActiveVideo(video.id);

  if (!src) {
    setStatus("未配置片源");
    return;
  }

  videoPlayer.src = src;
  videoPlayer.play().catch(() => {
    setStatus("等待手动播放");
  });
}

function markActiveVideo(videoId) {
  for (const item of libraryList.querySelectorAll(".video-item")) {
    if (item.dataset.videoId === videoId) {
      item.setAttribute("aria-current", "true");
    } else {
      item.removeAttribute("aria-current");
    }
  }
}

function resolveVideoSource(video) {
  if (isLocalHls(video)) {
    const url = new URL(`./__vault/hls/${encodeURIComponent(video.id)}/master.m3u8`, window.location.href);
    url.searchParams.set("v", String(Date.now()));
    return url.href;
  }

  const source = video.source || video.variants?.[0]?.src || "";
  if (!source) return "";
  if (/^https?:\/\//i.test(source)) return source;
  return `${state.vaultOrigin}${normalizePath(source)}`;
}

function isLocalHls(video) {
  return Boolean(video.hls?.key && video.hls?.variants?.some((variant) => variant.playlist));
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
    await navigator.serviceWorker.ready;

    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
        }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

async function configureServiceWorker() {
  await serviceWorkerReady;

  if (!navigator.serviceWorker?.controller) {
    return;
  }

  navigator.serviceWorker.controller.postMessage({
    type: "VAULT_CONFIG",
    payload: {
      vaultOrigin: state.vaultOrigin,
      videos: state.videos.filter(isLocalHls).map((video) => ({
        id: video.id,
        hls: video.hls,
      })),
    },
  });
}
