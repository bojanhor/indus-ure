const fs = require("fs");
const path = require("path");
const vm = require("vm");

const htmlPath = path.join(__dirname, "..", "outputs", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

if (scripts.length === 0) {
  throw new Error("V outputs/index.html ni bilo najdenega inline JavaScripta.");
}

scripts.forEach((match, index) => {
  new vm.Script(match[1], { filename: `outputs/index.html#script-${index + 1}` });
});

console.log(`Inline JavaScript: ${scripts.length} skript brez sintakticnih napak.`);
