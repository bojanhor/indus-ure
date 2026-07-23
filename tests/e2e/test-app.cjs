const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const TEST_PASSWORD = "playwright-local-test-password-2026";

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, logs) {
  let lastError = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Testni strežnik se je ustavil: ${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Testni strežnik se ni zagnal (${lastError}): ${logs()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startIsolatedTestApp() {
  const port = await reserveLoopbackPort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "indus-ure-playwright-"));
  const mediaDir = path.join(dataDir, "media");
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk}`.slice(-8_000);
  };
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      INDUS_URE_TEST_MODE: "true",
      TEST_LOCAL_LOGIN_PASSWORD: TEST_PASSWORD,
      DATA_DIR: dataDir,
      MEDIA_DIR: mediaDir,
      // Never inherit a database URL or third-party credentials into E2E.
      DATABASE_URL: "",
      PUBLIC_BASE_URL: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REDIRECT_URI: "",
      GOOGLE_DRIVE_TASKS_FOLDER_ID: "",
      GOOGLE_DRIVE_ATTACHMENTS_FOLDER_ID: "",
      ALERT_SMTP_URL: "",
      DISABLE_OPERATIONAL_MONITOR: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  try {
    await waitForHealth(baseUrl, child, () => output);
  } catch (error) {
    await stopChild(child);
    await fs.rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    async stop() {
      await stopChild(child);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}

module.exports = { TEST_PASSWORD, startIsolatedTestApp };