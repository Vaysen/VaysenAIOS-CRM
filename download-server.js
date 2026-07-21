const http = require("http");
const fs = require("fs");
const path = require("path");
const dir = "/opt/vaysen-ai-crm/uploads";
http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(req.url));
  if (fs.existsSync(file)) {
    res.setHeader("Content-Disposition", "attachment");
    fs.createReadStream(file).pipe(res);
  } else {
    res.writeHead(200, {"Content-Type": "text/html"});
    res.end("<h1>Downloads</h1><ul>" + fs.readdirSync(dir).map(f => `<li><a href=\"/${encodeURIComponent(f)}\">${f}</a></li>`).join("") + "</ul>");
  }
}).listen(4004, () => console.log("Download server on :4004"));
