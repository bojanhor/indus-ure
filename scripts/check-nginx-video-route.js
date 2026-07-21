"use strict";

const fs = require("fs");
const path = require("path");

for (const name of ["nginx-indus-ure.conf", "nginx-indus-ure-bootstrap.conf"]) {
  const file = path.join(__dirname, "..", "deploy", name);
  const config = fs.readFileSync(file, "utf8");
  if (!/location\s*=\s*\/api\/todos\/video\s*\{/.test(config)) {
    throw new Error(`${name} nima posebnega Nginx pravila za /api/todos/video.`);
  }
  if (/location\s*=\s*\/api\/todos\/drive-video\s*\{/.test(config)) {
    throw new Error(`${name} še vsebuje zastareli video naslov /api/todos/drive-video.`);
  }
  const videoLocation = /location\s*=\s*\/api\/todos\/video\s*\{([\s\S]*?)\n\s*\}/.exec(config)?.[1] || "";
  if (!/root[\s\S]*?client_max_body_size\s+210m;/.test(config)) {
    throw new Error(`${name} na ravni strežnika ne dovoljuje video nalaganja do 200 MB.`);
  }
  if (!/client_max_body_size\s+210m;/.test(videoLocation) || !/proxy_request_buffering\s+off;/.test(videoLocation)) {
    throw new Error(`${name} za video ne omogoča 200 MB pretočnega nalaganja.`);
  }
}

console.log("Nginx video route: OK");