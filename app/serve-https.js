const https = require("https");
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

const PORT = 8444;
const API_TARGET = "http://localhost:3000"; // backend
const DIST = path.join(__dirname, "dist");

const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const options = {
  key: fs.readFileSync(path.join(__dirname, "cert.key")),
  cert: fs.readFileSync(path.join(__dirname, "cert.crt")),
};

https.createServer(options, (req, res) => {
  const urlPath = req.url?.split("?")[0] || "/";

  // Proxy /api/* → backend
  if (urlPath.startsWith("/api/")) {
    const parsed = new URL(urlPath + (req.url?.includes("?") ? "?" + req.url.split("?")[1] : ""), API_TARGET);
    const proxyReq = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => k !== "host")
      ),
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => { res.writeHead(502); res.end("Backend unreachable"); });
    req.pipe(proxyReq);
    return;
  }

  // Static files + SPA fallback
  let filePath = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST, "index.html");
  }
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`✓ HTTPS server running at https://localhost:${PORT}  (API → ${API_TARGET})`);
});
