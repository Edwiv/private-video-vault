const state = {
  vaultOrigin: localStorage.getItem("vaultOrigin") || "",
  manifestPath: localStorage.getItem("manifestPath") || "/library.enc.json",
  videos: [],
  currentVideoId: "",
};

const CACHE_DB_NAME = "private-video-vault";
const CACHE_DB_VERSION = 1;
const CACHE_RECORD_STORE = "records";
const CACHE_KEY_STORE = "keys";
const LIBRARY_CACHE_KEY = "active-library";
const LIBRARY_DEVICE_KEY = "library-device-key";
const LIBRARY_CACHE_FLAG = "libraryCacheSaved";
const LIBRARY_CACHE_COOKIE = "videoVaultRemembered";
const THUMBNAIL_CACHE_PREFIX = "thumbnail:v1:";
const THUMBNAIL_WIDTH = 160;
const THUMBNAIL_HEIGHT = 90;
const VAULT_PRIVATE_KEY = "vault-rsa-private-key";
const VAULT_KEY_BACKUP = "vault-rsa-private-key-backup";
const VAULT_PUBLIC_KEY_STORAGE = "vaultPublicKeyPem";
const VAULT_PUBLIC_KEY_FINGERPRINT = "vaultPublicKeyFingerprint";

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
const backupPassphraseInput = document.querySelector("#backupPassphrase");
const publicKeyOutput = document.querySelector("#publicKey");
const keyBackupInput = document.querySelector("#keyBackup");
const generateKeyButton = document.querySelector("#generateKeyButton");
const copyPublicKeyButton = document.querySelector("#copyPublicKeyButton");
const copyKeyBackupButton = document.querySelector("#copyKeyBackupButton");
const importKeyBackupButton = document.querySelector("#importKeyBackupButton");
const keyStatus = document.querySelector("#keyStatus");
const libraryList = document.querySelector("#libraryList");
const libraryCount = document.querySelector("#libraryCount");
const videoPlayer = document.querySelector("#videoPlayer");
const nowPlayingTitle = document.querySelector("#nowPlayingTitle");
const nowPlayingMeta = document.querySelector("#nowPlayingMeta");
const template = document.querySelector("#videoItemTemplate");
const thumbnailTargetVideos = new WeakMap();
const thumbnailQueue = [];
const thumbnailQueuedIds = new Set();
let thumbnailObserver = null;
let thumbnailQueueActive = false;

vaultOriginInput.value = state.vaultOrigin;
manifestPathInput.value = state.manifestPath;
publicKeyOutput.value = localStorage.getItem(VAULT_PUBLIC_KEY_STORAGE) || "";

renderLibrary([]);
refreshKeyUi().catch((error) => {
  console.warn("Key status refresh failed", error);
});
restoreCachedLibrary().catch((error) => {
  console.warn("Cached library restore failed", error);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("正在解锁");

  const vaultOrigin = normalizeOrigin(vaultOriginInput.value);
  const manifestPath = normalizePath(manifestPathInput.value);
  const passphrase = passphraseInput.value;

  try {
    const encryptedManifest = await fetchEncryptedManifest(vaultOrigin, manifestPath);
    const baseLibrary = await decryptManifest(encryptedManifest, passphrase);
    const appendLibrary = await fetchAppendLibrary(vaultOrigin, manifestPath);
    const library = mergeLibraries(baseLibrary, appendLibrary);
    state.vaultOrigin = vaultOrigin;
    state.manifestPath = manifestPath;
    state.videos = normalizeLibrary(library);
    localStorage.setItem("vaultOrigin", vaultOrigin);
    localStorage.setItem("manifestPath", manifestPath);
    const cacheSaved = await saveCachedLibrary({ vaultOrigin, manifestPath, library });
    await configureServiceWorker();
    renderLibrary(state.videos);
    setStatus(cacheSaved ? "已解锁并记住" : "已解锁");
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

generateKeyButton.addEventListener("click", async () => {
  setStatus("正在生成密钥");
  const backupPassphrase = backupPassphraseInput.value;

  if (!backupPassphrase) {
    setStatus("填写备份口令");
    backupPassphraseInput.focus();
    return;
  }

  try {
    const { privateKey, publicKeyPem, fingerprint, backup } = await generateVaultKeyPair(backupPassphrase);
    await idbSet(CACHE_KEY_STORE, VAULT_PRIVATE_KEY, privateKey);
    await idbSet(CACHE_RECORD_STORE, VAULT_KEY_BACKUP, backup);
    localStorage.setItem(VAULT_PUBLIC_KEY_STORAGE, publicKeyPem);
    localStorage.setItem(VAULT_PUBLIC_KEY_FINGERPRINT, fingerprint);
    publicKeyOutput.value = publicKeyPem;
    keyBackupInput.value = formatKeyBackup(backup);
    await refreshKeyUi();
    setStatus("密钥已生成并备份");
  } catch (error) {
    console.error(error);
    setStatus("密钥生成失败");
  }
});

copyPublicKeyButton.addEventListener("click", async () => {
  const value = publicKeyOutput.value.trim();
  if (!value) {
    setStatus("没有公钥");
    return;
  }

  try {
    await copyText(value);
    setStatus("公钥已复制");
  } catch (error) {
    console.error(error);
    setStatus("复制失败");
  }
});

copyKeyBackupButton.addEventListener("click", async () => {
  const value = keyBackupInput.value.trim();
  if (!value) {
    setStatus("没有备份");
    return;
  }

  try {
    await copyText(value, keyBackupInput);
    setStatus("备份已复制");
  } catch (error) {
    console.error(error);
    setStatus("复制失败");
  }
});

importKeyBackupButton.addEventListener("click", async () => {
  setStatus("正在导入备份");
  const backupPassphrase = backupPassphraseInput.value;
  const backupText = keyBackupInput.value.trim();

  if (!backupPassphrase || !backupText) {
    setStatus("填写备份和口令");
    return;
  }

  try {
    const { privateKey, publicKeyPem, fingerprint, backup } = await importVaultKeyBackup(backupText, backupPassphrase);
    await idbSet(CACHE_KEY_STORE, VAULT_PRIVATE_KEY, privateKey);
    await idbSet(CACHE_RECORD_STORE, VAULT_KEY_BACKUP, backup);
    localStorage.setItem(VAULT_PUBLIC_KEY_STORAGE, publicKeyPem);
    localStorage.setItem(VAULT_PUBLIC_KEY_FINGERPRINT, fingerprint);
    publicKeyOutput.value = publicKeyPem;
    keyBackupInput.value = formatKeyBackup(backup);
    await refreshKeyUi();
    setStatus("备份已导入");
  } catch (error) {
    console.error(error);
    setStatus("导入失败");
  }
});

document.querySelector("#clearConfigButton").addEventListener("click", async () => {
  setStatus("正在清除");
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
  await clearCachedLibrary();
  await configureServiceWorker().catch((error) => console.warn("Worker clear failed", error));
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

async function fetchAppendLibrary(vaultOrigin, manifestPath) {
  const response = await fetch(`${vaultOrigin}${appendIndexPath(manifestPath)}`, {
    cache: "no-store",
    mode: "cors",
  });

  if (response.status === 404) {
    return { videos: [] };
  }

  if (!response.ok) {
    throw new Error(`Append manifest request failed: ${response.status}`);
  }

  const index = await response.json();
  if (!index || index.version !== 1 || !Array.isArray(index.items)) {
    throw new Error("Unsupported append manifest");
  }

  const videos = [];
  for (const itemPath of index.items) {
    try {
      const envelope = await fetchAppendItem(vaultOrigin, itemPath);
      const item = await decryptRecipientEnvelope(envelope);
      const video = item?.video || item;
      if (video && typeof video === "object") {
        videos.push(video);
      }
    } catch (error) {
      console.warn("Append item skipped", error);
    }
  }

  return { videos };
}

async function fetchAppendItem(vaultOrigin, itemPath) {
  const response = await fetch(`${vaultOrigin}${normalizePath(itemPath)}`, {
    cache: "no-store",
    mode: "cors",
  });

  if (!response.ok) {
    throw new Error(`Append item request failed: ${response.status}`);
  }

  return response.json();
}

function appendIndexPath(manifestPath) {
  const normalized = normalizePath(manifestPath);
  return normalized.replace(/\/[^/]*$/, "/library.append.json");
}

function mergeLibraries(...libraries) {
  return {
    videos: libraries.flatMap((library) => (Array.isArray(library?.videos) ? library.videos : [])),
    folders: libraries.flatMap((library) => (Array.isArray(library?.folders) ? library.folders : [])),
    directories: libraries.flatMap((library) => (Array.isArray(library?.directories) ? library.directories : [])),
  };
}

async function decryptManifest(envelope, passphrase) {
  if (!envelope || envelope.version !== 1) {
    if (envelope?.version === 2) {
      return decryptRecipientManifest(envelope);
    }
    throw new Error("Unsupported manifest envelope");
  }

  if (envelope.cipher !== "AES-GCM" || envelope.kdf?.name !== "PBKDF2") {
    throw new Error("Unsupported crypto settings");
  }

  if (!passphrase) {
    throw new Error("Passphrase is required for legacy vaults");
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

async function decryptRecipientManifest(envelope) {
  return decryptRecipientEnvelope(envelope);
}

async function decryptRecipientEnvelope(envelope) {
  if (envelope.cipher !== "AES-GCM" || envelope.keyWrap?.name !== "RSA-OAEP") {
    throw new Error("Unsupported recipient envelope");
  }

  const privateKey = await getVaultPrivateKey();
  if (!privateKey) {
    throw new Error("Device private key is missing");
  }

  const rawKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    fromBase64(envelope.keyWrap.wrappedKey),
  );
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = fromBase64(envelope.iv);
  const data = fromBase64(envelope.data);
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
  resetThumbnailObserver();
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
  const poster = item.querySelector(".poster");

  item.dataset.videoId = video.id;
  item.title = video.path || video.title;
  poster.dataset.thumbnailStatus = "pending";
  item.querySelector("strong").textContent = video.title;
  item.querySelector("small").textContent = videoMeta(video);
  item.addEventListener("click", () => playVideo(video));
  observeThumbnail(poster, video);

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

function resetThumbnailObserver() {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }

  thumbnailQueue.length = 0;
  thumbnailQueuedIds.clear();

  if (!("IntersectionObserver" in window)) {
    thumbnailObserver = null;
    return;
  }

  thumbnailObserver = new IntersectionObserver(handleThumbnailIntersections, {
    root: libraryList,
    rootMargin: "96px",
  });
}

function observeThumbnail(poster, video) {
  thumbnailTargetVideos.set(poster, video);

  if (thumbnailObserver) {
    thumbnailObserver.observe(poster);
  }
}

function handleThumbnailIntersections(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;

    thumbnailObserver?.unobserve(entry.target);
    const video = thumbnailTargetVideos.get(entry.target);
    if (video) {
      queueThumbnail(entry.target, video);
    }
  }
}

function queueThumbnail(poster, video) {
  const key = thumbnailCacheKey(video);
  if (thumbnailQueuedIds.has(key) || poster.dataset.thumbnailStatus === "ready") return;

  thumbnailQueuedIds.add(key);
  poster.dataset.thumbnailStatus = "loading";
  thumbnailQueue.push({ key, poster, video });
  runThumbnailQueue().catch((error) => {
    console.warn("Thumbnail queue failed", error);
  });
}

async function runThumbnailQueue() {
  if (thumbnailQueueActive) return;
  thumbnailQueueActive = true;

  try {
    while (thumbnailQueue.length) {
      const item = thumbnailQueue.shift();
      thumbnailQueuedIds.delete(item.key);

      if (!item.poster.isConnected || item.poster.dataset.thumbnailStatus === "ready") {
        continue;
      }

      try {
        const cached = await loadCachedThumbnail(item.video);
        const thumbnail = cached || (await captureVideoThumbnail(item.video));

        if (thumbnail) {
          setPosterImage(item.poster, thumbnail);
          if (!cached) {
            await saveCachedThumbnail(item.video, thumbnail);
          }
        } else {
          item.poster.dataset.thumbnailStatus = "unavailable";
        }
      } catch (error) {
        item.poster.dataset.thumbnailStatus = "unavailable";
        console.warn("Thumbnail generation failed", error);
      }
    }
  } finally {
    thumbnailQueueActive = false;
  }
}

function setPosterImage(poster, dataUrl) {
  poster.style.backgroundImage = `url("${dataUrl}")`;
  poster.dataset.thumbnailStatus = "ready";
}

async function loadCachedThumbnail(video) {
  const record = await idbGet(CACHE_RECORD_STORE, thumbnailCacheKey(video));
  if (!record) return "";

  try {
    const payload = await decryptCacheRecord(record);
    return payload?.videoId === video.id ? String(payload.dataUrl || "") : "";
  } catch (error) {
    console.warn("Cached thumbnail restore failed", error);
    return "";
  }
}

async function saveCachedThumbnail(video, dataUrl) {
  const record = await encryptCacheRecord({
    version: 1,
    videoId: video.id,
    savedAt: new Date().toISOString(),
    dataUrl,
  });

  await idbSet(CACHE_RECORD_STORE, thumbnailCacheKey(video), record);
}

function thumbnailCacheKey(video) {
  return `${THUMBNAIL_CACHE_PREFIX}${video.id}`;
}

function captureVideoThumbnail(video) {
  const src = resolveVideoSource(video);
  if (!src) return Promise.resolve("");

  return new Promise((resolve) => {
    const probe = document.createElement("video");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    let settled = false;
    let seekStarted = false;

    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    probe.crossOrigin = "anonymous";
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = "metadata";
    probe.className = "thumbnail-probe";

    const timeout = window.setTimeout(() => finish(""), 14000);

    function finish(value) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      probe.removeAttribute("src");
      probe.load();
      probe.remove();
      resolve(value);
    }

    function drawFrame() {
      if (!context || probe.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      try {
        const sourceWidth = probe.videoWidth || THUMBNAIL_WIDTH;
        const sourceHeight = probe.videoHeight || THUMBNAIL_HEIGHT;
        const scale = Math.max(THUMBNAIL_WIDTH / sourceWidth, THUMBNAIL_HEIGHT / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        const x = (THUMBNAIL_WIDTH - width) / 2;
        const y = (THUMBNAIL_HEIGHT - height) / 2;

        context.drawImage(probe, x, y, width, height);
        finish(canvas.toDataURL("image/jpeg", 0.72));
      } catch (error) {
        console.warn("Thumbnail draw failed", error);
        finish("");
      }
    }

    probe.addEventListener(
      "loadedmetadata",
      () => {
        const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
        const targetTime = duration > 8 ? Math.min(4, duration * 0.08) : 0.1;
        seekStarted = true;

        try {
          probe.currentTime = targetTime;
        } catch {
          drawFrame();
        }

        probe.play?.().then(() => probe.pause()).catch(() => {});
      },
      { once: true },
    );

    probe.addEventListener("seeked", drawFrame, { once: true });
    probe.addEventListener(
      "loadeddata",
      () => {
        if (!seekStarted) drawFrame();
      },
      { once: true },
    );
    probe.addEventListener("error", () => finish(""), { once: true });

    document.body.append(probe);
    probe.src = src;
    probe.load();
  });
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

function toBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function generateVaultKeyPair(backupPassphrase) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 4096,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const publicSpki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const fingerprint = await fingerprintBytes(publicSpki);
  const publicKeyPem = pemFromBytes("PUBLIC KEY", publicSpki);
  const backup = await encryptPrivateKeyBackup({
    backupPassphrase,
    fingerprint,
    privatePkcs8,
    publicKeyPem,
  });
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privatePkcs8,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  privatePkcs8.fill(0);

  return {
    backup,
    privateKey,
    publicKeyPem,
    fingerprint,
  };
}

async function getVaultPrivateKey() {
  return idbGet(CACHE_KEY_STORE, VAULT_PRIVATE_KEY);
}

async function refreshKeyUi() {
  const privateKey = await getVaultPrivateKey();
  const backup = await idbGet(CACHE_RECORD_STORE, VAULT_KEY_BACKUP);
  const fingerprint = localStorage.getItem(VAULT_PUBLIC_KEY_FINGERPRINT) || "";
  publicKeyOutput.value = localStorage.getItem(VAULT_PUBLIC_KEY_STORAGE) || publicKeyOutput.value;
  if (backup && !keyBackupInput.value.trim()) {
    keyBackupInput.value = formatKeyBackup(backup);
  }
  keyStatus.textContent = privateKey ? fingerprint || "已生成" : "未生成";
  copyPublicKeyButton.disabled = !publicKeyOutput.value.trim();
  copyKeyBackupButton.disabled = !keyBackupInput.value.trim();
}

function pemFromBytes(label, bytes) {
  const base64 = toBase64(bytes);
  const lines = base64.match(/.{1,64}/g) || [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join("\n");
}

async function fingerprintBytes(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function encryptPrivateKeyBackup({ backupPassphrase, fingerprint, privatePkcs8, publicKeyPem }) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(backupPassphrase, salt, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, privatePkcs8));

  return {
    version: 1,
    type: "private-video-vault-rsa-backup",
    createdAt: new Date().toISOString(),
    algorithm: "RSA-OAEP-4096-SHA-256",
    publicKeyFingerprint: fingerprint,
    publicKeyPem,
    cipher: "AES-GCM",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: 310000,
      salt: toBase64(salt),
    },
    iv: toBase64(iv),
    data: toBase64(encrypted),
  };
}

async function importVaultKeyBackup(backupText, backupPassphrase) {
  const backup = parseKeyBackup(backupText);
  const salt = fromBase64(backup.kdf.salt);
  const iv = fromBase64(backup.iv);
  const encrypted = fromBase64(backup.data);
  const key = await deriveBackupKey(backupPassphrase, salt, ["decrypt"]);
  const privatePkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted));

  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privatePkcs8,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    const publicKeyBytes = bytesFromPem("PUBLIC KEY", backup.publicKeyPem);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      publicKeyBytes,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    await verifyKeyPair(publicKey, privateKey);
    const fingerprint = await fingerprintBytes(publicKeyBytes);

    if (backup.publicKeyFingerprint && backup.publicKeyFingerprint !== fingerprint) {
      throw new Error("Backup fingerprint does not match public key");
    }

    return {
      backup,
      privateKey,
      publicKeyPem: backup.publicKeyPem,
      fingerprint,
    };
  } finally {
    privatePkcs8.fill(0);
  }
}

function parseKeyBackup(value) {
  const backup = JSON.parse(value);

  if (
    !backup ||
    backup.version !== 1 ||
    backup.type !== "private-video-vault-rsa-backup" ||
    backup.cipher !== "AES-GCM" ||
    backup.kdf?.name !== "PBKDF2" ||
    !backup.publicKeyPem ||
    !backup.iv ||
    !backup.data
  ) {
    throw new Error("Unsupported key backup");
  }

  return backup;
}

async function deriveBackupKey(passphrase, salt, usages) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: 310000,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

async function verifyKeyPair(publicKey, privateKey) {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, challenge);
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encrypted));

  if (!equalBytes(challenge, decrypted)) {
    throw new Error("Key pair verification failed");
  }
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function bytesFromPem(label, value) {
  const normalized = String(value || "")
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  return fromBase64(normalized);
}

function formatKeyBackup(backup) {
  return JSON.stringify(backup, null, 2);
}

async function copyText(value, sourceElement = publicKeyOutput) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  sourceElement.focus();
  sourceElement.select();
  if (!document.execCommand("copy")) {
    throw new Error("Clipboard copy failed");
  }
  sourceElement.setSelectionRange(0, 0);
}

function setStatus(message) {
  statusEl.textContent = message;
}

async function restoreCachedLibrary() {
  if (!hasCachedLibraryFlag()) return false;

  const record = await idbGet(CACHE_RECORD_STORE, LIBRARY_CACHE_KEY);
  if (!record) {
    clearCachedLibraryFlags();
    return false;
  }

  setStatus("正在恢复");
  const cached = await decryptCacheRecord(record);

  if (!cached?.vaultOrigin || !cached?.manifestPath || !cached?.library) {
    throw new Error("Invalid cached library");
  }

  state.vaultOrigin = cached.vaultOrigin;
  state.manifestPath = cached.manifestPath;
  state.videos = normalizeLibrary(cached.library);
  state.currentVideoId = "";
  vaultOriginInput.value = cached.vaultOrigin;
  manifestPathInput.value = cached.manifestPath;
  passphraseInput.value = "";
  localStorage.setItem("vaultOrigin", cached.vaultOrigin);
  localStorage.setItem("manifestPath", cached.manifestPath);
  await configureServiceWorker();
  renderLibrary(state.videos);
  setStatus("已自动恢复");
  return true;
}

async function saveCachedLibrary({ vaultOrigin, manifestPath, library }) {
  try {
    const record = await encryptCacheRecord({
      version: 1,
      savedAt: new Date().toISOString(),
      vaultOrigin,
      manifestPath,
      library,
    });

    await idbSet(CACHE_RECORD_STORE, LIBRARY_CACHE_KEY, record);
    setCachedLibraryFlags();
    return true;
  } catch (error) {
    clearCachedLibraryFlags();
    console.warn("Library cache save failed", error);
    return false;
  }
}

async function clearCachedLibrary() {
  await Promise.allSettled([
    idbDeleteByPrefix(CACHE_RECORD_STORE, THUMBNAIL_CACHE_PREFIX),
    idbDelete(CACHE_RECORD_STORE, LIBRARY_CACHE_KEY),
    idbDelete(CACHE_KEY_STORE, LIBRARY_DEVICE_KEY),
  ]);
  clearCachedLibraryFlags();
}

async function encryptCacheRecord(payload) {
  const key = await getLibraryDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));

  return {
    version: 1,
    cipher: "AES-GCM",
    iv: toBase64(iv),
    data: toBase64(encrypted),
  };
}

async function decryptCacheRecord(record) {
  if (!record || record.version !== 1 || record.cipher !== "AES-GCM") {
    throw new Error("Unsupported cached library");
  }

  const key = await getLibraryDeviceKey(false);
  if (!key) {
    throw new Error("Missing cached library key");
  }

  const iv = fromBase64(record.iv);
  const encrypted = fromBase64(record.data);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function getLibraryDeviceKey(createIfMissing = true) {
  const existing = await idbGet(CACHE_KEY_STORE, LIBRARY_DEVICE_KEY);
  if (existing) return existing;
  if (!createIfMissing) return null;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idbSet(CACHE_KEY_STORE, LIBRARY_DEVICE_KEY, key);
  return key;
}

function hasCachedLibraryFlag() {
  return localStorage.getItem(LIBRARY_CACHE_FLAG) === "1" || readCookie(LIBRARY_CACHE_COOKIE) === "1";
}

function setCachedLibraryFlags() {
  localStorage.setItem(LIBRARY_CACHE_FLAG, "1");
  writeCookie(LIBRARY_CACHE_COOKIE, "1", 60 * 60 * 24 * 365);
}

function clearCachedLibraryFlags() {
  localStorage.removeItem(LIBRARY_CACHE_FLAG);
  writeCookie(LIBRARY_CACHE_COOKIE, "", 0);
}

function readCookie(name) {
  return document.cookie
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function writeCookie(name, value, maxAge) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${cookiePath()}; SameSite=Lax${secure}`;
}

function cookiePath() {
  return new URL(".", location.href).pathname || "/";
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window) || !crypto?.subtle) {
      reject(new Error("Browser storage is unavailable"));
      return;
    }

    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_RECORD_STORE)) {
        db.createObjectStore(CACHE_RECORD_STORE);
      }
      if (!db.objectStoreNames.contains(CACHE_KEY_STORE)) {
        db.createObjectStore(CACHE_KEY_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function idbGet(storeName, key) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB get failed"));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("IndexedDB transaction failed"));
    };
  });
}

async function idbSet(storeName, key, value) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).put(value, key);

    request.onerror = () => reject(request.error || new Error("IndexedDB set failed"));
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("IndexedDB transaction failed"));
    };
  });
}

async function idbDelete(storeName, key) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).delete(key);

    request.onerror = () => reject(request.error || new Error("IndexedDB delete failed"));
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("IndexedDB transaction failed"));
    };
  });
}

async function idbDeleteByPrefix(storeName, prefix) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;

      if (String(cursor.key).startsWith(prefix)) {
        cursor.delete();
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB cursor failed"));
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("IndexedDB transaction failed"));
    };
  });
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
