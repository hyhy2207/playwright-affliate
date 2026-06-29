"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { config } = require("./config");
const { parseCdpUrl } = require("./chrome-launcher");

const profilesRoot = path.resolve(__dirname, ".profiles");
const registryPath = path.join(profilesRoot, "profiles.json");
const managedDefaultProfileDir = path.join(profilesRoot, "default");

function slugifyProfileName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function ensureProfilesRoot() {
  fs.mkdirSync(profilesRoot, { recursive: true });
}

function getBaseCdpPort() {
  if (!config.browserCdpUrl) return 0;
  return parseCdpUrl(config.browserCdpUrl).port || 9222;
}

function readRegistry() {
  ensureProfilesRoot();
  if (!fs.existsSync(registryPath)) {
    return {
      defaultProfileId: null,
      profiles: [],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    return {
      defaultProfileId: parsed?.defaultProfileId || null,
      profiles: Array.isArray(parsed?.profiles) ? parsed.profiles : [],
    };
  } catch {
    return {
      defaultProfileId: null,
      profiles: [],
    };
  }
}

function writeRegistry(registry) {
  ensureProfilesRoot();
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");
}

function getLegacyProfileDir() {
  const value = path.resolve(__dirname, ".browser-profile");
  return value;
}

function migrateLegacyProfileDir() {
  const legacyProfileDir = getLegacyProfileDir();
  if (!fs.existsSync(legacyProfileDir)) {
    return false;
  }

  ensureProfilesRoot();
  if (!fs.existsSync(managedDefaultProfileDir)) {
    fs.renameSync(legacyProfileDir, managedDefaultProfileDir);
    return true;
  }

  return false;
}

function ensureManagedProfileStorage(registry) {
  const didMoveLegacyDir = migrateLegacyProfileDir();
  const legacyProfileDir = getLegacyProfileDir();
  const hasManagedDefaultDir = fs.existsSync(managedDefaultProfileDir);
  const hasLegacyDir = fs.existsSync(legacyProfileDir);
  const basePort = getBaseCdpPort();
  const now = new Date().toISOString();

  const nextProfiles = registry.profiles.map((profile) => {
    const resolvedDir = path.resolve(profile.profileDir || "");
    if (resolvedDir !== legacyProfileDir) {
      return profile;
    }

    return {
      ...profile,
      profileDir: hasManagedDefaultDir ? managedDefaultProfileDir : legacyProfileDir,
      updatedAt: now,
      legacy: false,
    };
  });

  if (
    nextProfiles.length === 0 &&
    (hasManagedDefaultDir || hasLegacyDir || didMoveLegacyDir)
  ) {
    nextProfiles.push({
      id: "default",
      name: "default",
      profileDir: hasManagedDefaultDir ? managedDefaultProfileDir : legacyProfileDir,
      cdpPort: basePort || null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      legacy: false,
    });
  }

  const nextRegistry = {
    ...registry,
    defaultProfileId: registry.defaultProfileId || nextProfiles[0]?.id || null,
    profiles: nextProfiles,
  };

  if (JSON.stringify(nextRegistry) !== JSON.stringify(registry)) {
    writeRegistry(nextRegistry);
  }

  return nextRegistry;
}

function loadProfiles() {
  const registry = ensureManagedProfileStorage(readRegistry());
  return hydrateRegistry(registry);
}

function hydrateRegistry(registry) {
  return {
    ...registry,
    profiles: Array.isArray(registry?.profiles)
      ? registry.profiles.map((profile) => ({
          status: "ready",
          failureCount: 0,
          successCount: 0,
          switchCount: 0,
          blockedUntil: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastFailedAt: null,
          lastRecoveredAt: null,
          lastSwitchedAt: null,
          lastTaskAt: null,
          ...profile,
        }))
      : [],
  };
}

function findDefaultProfile(registry) {
  return (
    registry.profiles.find(
      (profile) => profile.id === registry.defaultProfileId,
    ) ||
    registry.profiles[0] ||
    null
  );
}

function findProfileByNameOrId(registry, value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  return (
    registry.profiles.find(
      (profile) => profile.id.toLowerCase() === normalized,
    ) ||
    registry.profiles.find(
      (profile) => profile.name.toLowerCase() === normalized,
    ) ||
    null
  );
}

function getNextCdpPort(registry) {
  const basePort = getBaseCdpPort();
  if (!basePort) return null;

  let nextPort = basePort;
  const usedPorts = new Set(
    registry.profiles
      .map((profile) => Number(profile.cdpPort || 0))
      .filter((value) => Number.isFinite(value) && value > 0),
  );

  while (usedPorts.has(nextPort)) {
    nextPort += 1;
  }

  return nextPort;
}

function createProfile(registry, profileName) {
  registry = hydrateRegistry(registry);
  const cleanName = String(profileName || "").trim();
  if (!cleanName) {
    throw new Error("Ten profile khong duoc de trong");
  }

  const existing = findProfileByNameOrId(registry, cleanName);
  if (existing) {
    return existing;
  }

  const slugBase = slugifyProfileName(cleanName) || "profile";
  let slug = slugBase;
  let suffix = 2;

  while (registry.profiles.some((profile) => profile.id === slug)) {
    slug = `${slugBase}-${suffix}`;
    suffix += 1;
  }

  const profileDir = path.join(profilesRoot, slug);
  fs.mkdirSync(profileDir, { recursive: true });

  const now = new Date().toISOString();
  const profile = {
    id: slug,
    name: cleanName,
    profileDir,
    cdpPort: getNextCdpPort(registry),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    legacy: false,
    status: "ready",
    failureCount: 0,
    successCount: 0,
    switchCount: 0,
    blockedUntil: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastFailedAt: null,
    lastRecoveredAt: null,
    lastSwitchedAt: null,
    lastTaskAt: null,
  };

  registry.profiles.push(profile);
  if (!registry.defaultProfileId) {
    registry.defaultProfileId = profile.id;
  }
  writeRegistry(registry);
  return profile;
}

function deleteProfile(registry, profile) {
  registry = hydrateRegistry(registry);
  if (!profile) {
    throw new Error("Khong tim thay profile can xoa");
  }

  if (registry.profiles.length <= 1) {
    throw new Error("Khong the xoa profile cuoi cung");
  }

  const nextProfiles = registry.profiles.filter(
    (entry) => entry.id !== profile.id,
  );
  const nextDefault =
    registry.defaultProfileId === profile.id
      ? nextProfiles[0]?.id || null
      : registry.defaultProfileId;

  if (profile.profileDir && fs.existsSync(profile.profileDir)) {
    fs.rmSync(profile.profileDir, { recursive: true, force: true });
  }

  const nextRegistry = {
    ...registry,
    defaultProfileId: nextDefault,
    profiles: nextProfiles,
  };
  writeRegistry(nextRegistry);
  return {
    deletedProfile: profile,
    registry: nextRegistry,
  };
}

function markProfileSelected(registry, profile) {
  registry = hydrateRegistry(registry);
  const now = new Date().toISOString();
  const nextProfiles = registry.profiles.map((entry) =>
    entry.id === profile.id
      ? {
          ...entry,
          updatedAt: now,
          lastUsedAt: now,
          lastSwitchedAt: now,
          switchCount: Number(entry.switchCount || 0) + 1,
        }
      : entry,
  );

  const nextRegistry = {
    ...registry,
    defaultProfileId: profile.id,
    profiles: nextProfiles,
  };
  writeRegistry(nextRegistry);
  return nextProfiles.find((entry) => entry.id === profile.id) || profile;
}

function getNextProfile(registry, currentProfileRef, excludedProfileRefs = []) {
  registry = hydrateRegistry(registry);
  const profiles = Array.isArray(registry?.profiles) ? registry.profiles : [];
  if (profiles.length === 0) return null;

  const excluded = new Set(
    excludedProfileRefs
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const current = findProfileByNameOrId(registry, currentProfileRef) || findDefaultProfile(registry);
  if (!current) return null;

  const currentIndex = profiles.findIndex((profile) => profile.id === current.id);
  for (let offset = 1; offset <= profiles.length; offset += 1) {
    const candidate = profiles[(currentIndex + offset) % profiles.length];
    if (!candidate || candidate.id === current.id) continue;

    const candidateRefs = [candidate.id, candidate.name].map((value) =>
      String(value || "").trim().toLowerCase(),
    );
    if (candidateRefs.some((value) => excluded.has(value))) {
      continue;
    }
    if (candidate.status === "disabled") {
      continue;
    }
    if (
      candidate.blockedUntil &&
      new Date(candidate.blockedUntil).getTime() > Date.now()
    ) {
      continue;
    }

    return candidate;
  }

  return null;
}

function updateProfileState(registry, profileRef, patch) {
  registry = hydrateRegistry(registry);
  const target = findProfileByNameOrId(registry, profileRef);
  if (!target) return { registry, profile: null };

  const nextProfiles = registry.profiles.map((profile) =>
    profile.id === target.id
      ? {
          ...profile,
          ...patch,
          updatedAt: new Date().toISOString(),
        }
      : profile,
  );
  const nextRegistry = {
    ...registry,
    profiles: nextProfiles,
  };
  writeRegistry(nextRegistry);
  return {
    registry: nextRegistry,
    profile: nextProfiles.find((profile) => profile.id === target.id) || null,
  };
}

function markProfileFailure(registry, profileRef, errorCode, errorMessage) {
  registry = hydrateRegistry(registry);
  const target = findProfileByNameOrId(registry, profileRef);
  if (!target) return { registry, profile: null };

  const now = Date.now();
  const failureCount = Number(target.failureCount || 0) + 1;
  const cooldownMs = Math.min(
    config.profileCooldownMaxMs,
    config.profileCooldownMs * Math.max(1, 2 ** (failureCount - 1)),
  );
  return updateProfileState(registry, target.id, {
    status: "cooldown",
    failureCount,
    blockedUntil: new Date(now + cooldownMs).toISOString(),
    lastErrorCode: errorCode || null,
    lastErrorMessage: errorMessage || null,
    lastFailedAt: new Date(now).toISOString(),
  });
}

function markProfileHealthy(registry, profileRef) {
  registry = hydrateRegistry(registry);
  const target = findProfileByNameOrId(registry, profileRef);
  if (!target) return { registry, profile: null };

  return updateProfileState(registry, profileRef, {
    status: "ready",
    blockedUntil: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastRecoveredAt: new Date().toISOString(),
    failureCount: 0,
    successCount: Number(target.successCount || 0) + 1,
  });
}

function touchProfileTask(registry, profileRef) {
  return updateProfileState(registry, profileRef, {
    lastTaskAt: new Date().toISOString(),
  });
}

function setDefaultProfile(registry, profileRef) {
  registry = hydrateRegistry(registry);
  const target = findProfileByNameOrId(registry, profileRef);
  if (!target) return { registry, profile: null };

  const nextRegistry = {
    ...registry,
    defaultProfileId: target.id,
  };
  writeRegistry(nextRegistry);
  return { registry: nextRegistry, profile: target };
}

function disableProfile(registry, profileRef) {
  return updateProfileState(registry, profileRef, {
    status: "disabled",
  });
}

function recoverProfile(registry, profileRef) {
  return updateProfileState(registry, profileRef, {
    status: "ready",
    blockedUntil: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastRecoveredAt: new Date().toISOString(),
    failureCount: 0,
  });
}

function summarizeProfiles(registry) {
  registry = hydrateRegistry(registry);
  const now = Date.now();
  const profiles = registry.profiles.map((profile) => ({
    ...profile,
    isDefault: profile.id === registry.defaultProfileId,
    cooldownRemainingMs:
      profile.blockedUntil && new Date(profile.blockedUntil).getTime() > now
        ? new Date(profile.blockedUntil).getTime() - now
        : 0,
  }));

  return {
    defaultProfileId: registry.defaultProfileId,
    total: profiles.length,
    ready: profiles.filter((profile) => profile.status === "ready" && !profile.cooldownRemainingMs).length,
    cooldown: profiles.filter((profile) => profile.cooldownRemainingMs > 0).length,
    disabled: profiles.filter((profile) => profile.status === "disabled").length,
    profiles,
  };
}

function buildProfileEnv(profile) {
  const env = {
    PROFILE_NAME: profile.name,
    BROWSER_PROFILE_DIR: profile.profileDir,
  };

  if (config.browserCdpUrl) {
    const cdp = new URL(config.browserCdpUrl);
    if (profile.cdpPort) {
      cdp.port = String(profile.cdpPort);
    }
    env.BROWSER_CDP_URL = cdp.toString();
  }

  return env;
}

function formatProfileLine(profile, isDefault) {
  const parts = [
    profile.name,
    isDefault ? "(mac dinh)" : null,
    profile.cdpPort ? `CDP:${profile.cdpPort}` : "persistent",
    profile.profileDir,
  ].filter(Boolean);

  return parts.join(" | ");
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function promptForProfile(actionLabel, explicitProfileName) {
  const registry = loadProfiles();

  if (explicitProfileName) {
    const existing = findProfileByNameOrId(registry, explicitProfileName);
    if (existing) {
      return markProfileSelected(registry, existing);
    }

    return markProfileSelected(
      registry,
      createProfile(registry, explicitProfileName),
    );
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const fallback =
      findDefaultProfile(registry) ||
      markProfileSelected(registry, createProfile(registry, "default"));
    return markProfileSelected(registry, fallback);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const profiles = loadProfiles();
    const defaultProfile = findDefaultProfile(profiles);

    console.log(`Chon profile cho ${actionLabel}:`);
    if (profiles.profiles.length === 0) {
      console.log("- Chua co profile nao.");
    } else {
      profiles.profiles.forEach((profile, index) => {
        console.log(
          `${index + 1}. ${formatProfileLine(profile, profile.id === profiles.defaultProfileId)}`,
        );
      });
    }
    console.log("N. Tao profile moi");
    if (profiles.profiles.length > 1) {
      console.log("D. Xoa profile");
    }

    const answer = String(
      await askQuestion(
        rl,
        defaultProfile
          ? `Nhap so, ten profile, hoac Enter de dung "${defaultProfile.name}": `
          : "Nhap ten profile moi: ",
      ),
    ).trim();

    if (!answer) {
      if (defaultProfile) {
        return markProfileSelected(profiles, defaultProfile);
      }

      return markProfileSelected(profiles, createProfile(profiles, "default"));
    }

    if (answer.toLowerCase() === "n") {
      const newName = String(await askQuestion(rl, "Ten profile moi: ")).trim();
      if (!newName) {
        throw new Error("Ten profile moi khong duoc de trong");
      }
      return markProfileSelected(profiles, createProfile(profiles, newName));
    }

    if (answer.toLowerCase() === "d") {
      if (profiles.profiles.length <= 1) {
        throw new Error("Khong the xoa profile cuoi cung");
      }

      const target = String(
        await askQuestion(rl, "Nhap so hoac ten profile can xoa: "),
      ).trim();
      if (!target) {
        throw new Error("Ban chua nhap profile can xoa");
      }

      const profileToDelete =
        Number.isInteger(Number(target)) &&
        Number(target) >= 1 &&
        Number(target) <= profiles.profiles.length
          ? profiles.profiles[Number(target) - 1]
          : findProfileByNameOrId(profiles, target);

      if (!profileToDelete) {
        throw new Error(`Khong tim thay profile "${target}" de xoa`);
      }

      const confirmation = String(
        await askQuestion(
          rl,
          `Xac nhan xoa profile "${profileToDelete.name}" va thu muc du lieu cua no? (yes/no): `,
        ),
      )
        .trim()
        .toLowerCase();

      if (confirmation !== "yes") {
        throw new Error("Da huy thao tac xoa profile");
      }

      const { registry: nextRegistry } = deleteProfile(
        profiles,
        profileToDelete,
      );
      const nextDefaultProfile = findDefaultProfile(nextRegistry);
      if (!nextDefaultProfile) {
        throw new Error("Khong con profile nao sau khi xoa");
      }
      console.log(`Da xoa profile: ${profileToDelete.name}`);
      return markProfileSelected(nextRegistry, nextDefaultProfile);
    }

    const numericIndex = Number(answer);
    if (
      Number.isInteger(numericIndex) &&
      numericIndex >= 1 &&
      numericIndex <= profiles.profiles.length
    ) {
      return markProfileSelected(profiles, profiles.profiles[numericIndex - 1]);
    }

    const existing = findProfileByNameOrId(profiles, answer);
    if (existing) {
      return markProfileSelected(profiles, existing);
    }

    return markProfileSelected(profiles, createProfile(profiles, answer));
  } finally {
    rl.close();
  }
}

module.exports = {
  buildProfileEnv,
  deleteProfile,
  disableProfile,
  findDefaultProfile,
  findProfileByNameOrId,
  formatProfileLine,
  getNextProfile,
  loadProfiles,
  markProfileFailure,
  markProfileHealthy,
  markProfileSelected,
  promptForProfile,
  profilesRoot,
  recoverProfile,
  setDefaultProfile,
  summarizeProfiles,
  touchProfileTask,
  updateProfileState,
};
