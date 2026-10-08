"use strict";

// A verified recovery copy and housekeeping are separate outcomes. Cleanup
// errors must stay visible, but must not turn an intact copy into a failure.
async function runBackupRetention(result, { drive, local }) {
  if (result?.status !== "success" || !["localArchive", "driveSize", "driveMd5", "freshDriveRead", "restoreInstructions"].every(key => result.verified?.[key] === true)) {
    throw new Error("Čiščenje zahteva uspešno preverjeno varnostno kopijo.");
  }
  result.cleanupStatus = "success";
  for (const [key, run] of [["driveRetention", drive], ["localRetention", local]]) {
    try {
      result[key] = { ...await run(), status: "success" };
    } catch (error) {
      result[key] = { ...error[key], status: "failed", error: String(error.message || error) };
      result.cleanupStatus = "warning";
      // Preserve local copies if off-site cleanup/verification was interrupted.
      if (key === "driveRetention") result.localRetention = { status: "skipped", reason: "Drive čiščenje ni uspelo; lokalne kopije so ohranjene." };
      break;
    }
  }
  return result;
}

function backupCleanupIssue(result) {
  if (result?.status !== "success" || result.cleanupStatus !== "warning") return null;
  const details = [["Google Drive", result.driveRetention], ["Lokalno", result.localRetention]]
    .filter(([, item]) => item?.status === "failed")
    .map(([label, item]) => `${label}: ${item.error}`).join("; ").slice(0, 600);
  return { code: "backup-cleanup-failed", severity: "warning", title: "Kopija je uspela; čiščenje kopij ni uspelo",
    message: `Nova recovery varnostna kopija je izdelana in preverjena. Čiščenje starih kopij je bilo prekinjeno. ${details}`.trim() };
}

module.exports = { runBackupRetention, backupCleanupIssue };
