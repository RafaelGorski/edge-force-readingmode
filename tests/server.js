// Minimal static file server for Playwright fixtures.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.FRM_PORT ? Number(process.env.FRM_PORT) : 5178;
const ROOT = path.join(__dirname, "fixtures");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.join(ROOT, urlPath);
    if (urlPath === "/" || urlPath === "") filePath = path.join(ROOT, "blocked-article.html");
    // Prevent path traversal outside ROOT.
    if (!path.resolve(filePath).startsWith(path.resolve(ROOT))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500);
    res.end("Server error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Fixture server running at http://127.0.0.1:${PORT}/`);
});
