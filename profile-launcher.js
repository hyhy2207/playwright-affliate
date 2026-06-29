"use strict";

const { spawn } = require("child_process");
const path = require("path");

const {
  buildProfileEnv,
  deleteProfile,
  findDefaultProfile,
  findProfileByNameOrId,
  formatProfileLine,
  loadProfiles,
  promptForProfile,
} = require("./profile-manager");

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: "",
    passthrough: [],
    profileName: "",
    deleteProfileName: "",
    profilesOnly: false,
  };

  for (const arg of args) {
    if (arg === "--profiles") {
      result.profilesOnly = true;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      result.profileName = arg.slice("--profile=".length).trim();
      continue;
    }

    if (arg.startsWith("--delete-profile=")) {
      result.deleteProfileName = arg.slice("--delete-profile=".length).trim();
      continue;
    }

    if (!result.command) {
      result.command = arg;
      continue;
    }

    result.passthrough.push(arg);
  }

  return result;
}

async function run() {
  const parsed = parseArgs(process.argv);

  if (parsed.deleteProfileName) {
    const registry = loadProfiles();
    const profile = findProfileByNameOrId(registry, parsed.deleteProfileName);
    if (!profile) {
      throw new Error(`Khong tim thay profile "${parsed.deleteProfileName}"`);
    }

    const { deletedProfile, registry: nextRegistry } = deleteProfile(registry, profile);
    const nextDefaultProfile = findDefaultProfile(nextRegistry);
    console.log(`Da xoa profile: ${deletedProfile.name}`);
    if (nextDefaultProfile) {
      console.log(`Profile mac dinh moi: ${formatProfileLine(nextDefaultProfile, true)}`);
    }
    console.log(`Tong profile: ${nextRegistry.profiles.length}`);
    return;
  }

  const actionLabel = parsed.profilesOnly
    ? "quan ly profile"
    : path.basename(parsed.command || "session");
  const selectedProfile = await promptForProfile(
    actionLabel,
    parsed.profileName || process.env.PROFILE_NAME,
  );

  console.log(`Dang dung profile: ${formatProfileLine(selectedProfile, true)}`);

  if (parsed.profilesOnly) {
    const registry = loadProfiles();
    console.log(`Tong profile: ${registry.profiles.length}`);
    return;
  }

  if (!parsed.command) {
    throw new Error("Thieu command can chay");
  }

  const child = spawn(process.execPath, [parsed.command, ...parsed.passthrough], {
    cwd: __dirname,
    stdio: "inherit",
    env: {
      ...process.env,
      ...buildProfileEnv(selectedProfile),
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code || 0);
  });
}

run().catch((error) => {
  console.error(`Loi profile-launcher: ${error.message}`);
  process.exit(1);
});
