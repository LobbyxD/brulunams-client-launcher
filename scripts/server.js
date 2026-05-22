const fs = require("fs");
const http = require("http");
const path = require("path");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const publicDir = path.resolve(argValue("--public", path.join(process.cwd(), "public")));
const host = argValue("--host", "127.0.0.1");
const port = Number(argValue("--port", "1717"));

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".yml" || ext === ".yaml") return "text/yaml; charset=utf-8";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".exe" || ext === ".blockmap") return "application/octet-stream";
  return "application/octet-stream";
}

function cacheControl(urlPath) {
  if (urlPath.endsWith("/latest.json") || urlPath.endsWith("/latest.yml") || urlPath.endsWith("/launcher/latest.yml")) {
    return "no-cache";
  }
  if (urlPath.includes("/files/sha256/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=60";
}

const server = http.createServer((request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*"
      });
      response.end(JSON.stringify({ ok: true, service: "patch-server" }));
      return;
    }
    if (pathname === "/") pathname = "/latest.json";

    const requested = path.resolve(publicDir, `.${pathname}`);
    if (requested !== publicDir && !requested.startsWith(`${publicDir}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.stat(requested, (statError, stat) => {
      if (statError || !stat.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, {
        "Content-Type": contentType(requested),
        "Content-Length": stat.size,
        "Cache-Control": cacheControl(pathname),
        "Access-Control-Allow-Origin": "*"
      });
      fs.createReadStream(requested).pipe(response);
    });
  } catch {
    response.writeHead(400);
    response.end("Bad request");
  }
});

server.listen(port, host, () => {
  console.log(`Serving ${publicDir}`);
  console.log(`Patch server listening on http://${host}:${port}`);
});
