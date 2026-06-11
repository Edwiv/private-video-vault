import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const [, , rootArg = "demo-vault", portArg = "8787", hostArg = "127.0.0.1"] = process.argv;
const root = resolve(rootArg);
const port = Number(portArg);
const host = hostArg;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: node tools/serve-vault.mjs [root] [port] [host]");
  process.exit(1);
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405);
    response.end("Method not allowed");
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    const target = resolve(join(root, pathname));

    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const fileStat = await stat(target);
    if (!fileStat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const range = parseRange(request.headers.range, fileStat.size);
    if (range) {
      response.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl(pathname),
        "Content-Length": range.end - range.start + 1,
        "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
        "Content-Type": contentType(target),
      });

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      createReadStream(target, range).pipe(response);
      return;
    }

    response.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl(pathname),
      "Content-Length": fileStat.size,
      "Content-Type": contentType(target),
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(target).pipe(response);
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500);
    response.end(error?.code === "ENOENT" ? "Not found" : "Server error");
  }
});

server.listen(port, host, () => {
  console.log(`Vault server: http://${host}:${port}`);
  console.log(`Root: ${root}`);
});

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function cacheControl(pathname) {
  return pathname === "/library.enc.json" || pathname === "/library.append.json"
    ? "no-store"
    : "public, max-age=31536000, immutable";
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;

  if (!match[1] && match[2]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function contentType(path) {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".ts":
      return "video/mp2t";
    case ".m3u8":
      return "application/vnd.apple.mpegurl; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
