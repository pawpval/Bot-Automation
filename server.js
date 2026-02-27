import express from "express";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ENV
const GROUP_ID = String(process.env.GROUP_ID || "").trim();
const ROBLOX_API_KEY = String(process.env.ROBLOX_API_KEY || "").trim();
const SHARED_SECRET = String(process.env.SHARED_SECRET || "").trim();

if (!GROUP_ID) console.warn("[ENV] Missing GROUP_ID");
if (!ROBLOX_API_KEY) console.warn("[ENV] Missing ROBLOX_API_KEY");
if (!SHARED_SECRET) console.warn("[ENV] Missing SHARED_SECRET");

// XP -> ROLE NAME (THIS is robust)
const XP_TO_ROLE_NAME = [
  { xp: 0,  roleName: "Cadet" },
  { xp: 3,  roleName: "Trooper" },
  { xp: 6,  roleName: "Specialist" },
  { xp: 12, roleName: "Corporal" },
  { xp: 18, roleName: "Sergeant" },
  { xp: 28, roleName: "Staff Sergeant" },
  { xp: 35, roleName: "Master Sergeant" },
  { xp: 50, roleName: "Sergeant Major" },
  { xp: 75, roleName: "Warrant Officer" }
];

// safety cap (won’t touch anything above this role in the list)
const MAX_MANAGED_INDEX = XP_TO_ROLE_NAME.length - 1;

// roleName -> roleId
let roleNameToId = new Map();
let groupOwnerUserId = null;

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { res, text, data };
}

function pickRoleNameForXP(xp) {
  let idx = 0;
  for (let i = 0; i < XP_TO_ROLE_NAME.length; i++) {
    if (xp >= XP_TO_ROLE_NAME[i].xp) idx = i;
  }
  if (idx > MAX_MANAGED_INDEX) idx = MAX_MANAGED_INDEX;
  return XP_TO_ROLE_NAME[idx].roleName;
}

async function loadGroupOwner() {
  const { res, data, text } = await fetchJson(`https://groups.roblox.com/v1/groups/${GROUP_ID}`);
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  if (data?.owner?.userId) groupOwnerUserId = Number(data.owner.userId);
}

async function loadRoles() {
  const { res, data, text } = await fetchJson(`https://groups.roblox.com/v1/groups/${GROUP_ID}/roles`);
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);

  roleNameToId.clear();
  for (const role of data?.roles || []) {
    // normalize names
    roleNameToId.set(String(role.name).trim().toLowerCase(), role.id);
  }

  // quick sanity log
  console.log("[Roles] Loaded role names:", Array.from(roleNameToId.keys()).slice(0, 25));
}

async function getCurrentRoleId(userId) {
  const { res, data, text } = await fetchJson(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);

  const entry = (data?.data || []).find((g) => String(g.group?.id) === String(GROUP_ID));
  return entry?.role?.id ?? null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setUserRoleWithRetry(userId, roleId, tries = 5) {
  const rolePath = `groups/${GROUP_ID}/roles/${roleId}`;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const { res, text } = await fetchJson(
      `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships/${userId}`,
      {
        method: "PATCH",
        headers: {
          "x-api-key": ROBLOX_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: rolePath }),
      }
    );

    if (res.ok) return true;

    const transient =
      (text || "").includes("FailedToAcquireLock") ||
      res.status === 429 ||
      res.status >= 500;

    if (!transient || attempt === tries) {
      throw new Error(text || `Roblox API failed HTTP ${res.status}`);
    }

    await sleep(350 * attempt);
  }

  return false;
}

async function handleUpdate(req, res) {
  const body = req.body || {};
  const { userId, xp, secret, loaded } = body;

  try {
    if (secret !== SHARED_SECRET) {
      return res.status(401).json({ error: "Invalid secret" });
    }

    // ✅ prevents “XP not loaded yet => Cadet”
    if (loaded !== true) {
      return res.json({ success: true, skipped: true, reason: "NotLoaded" });
    }

    const uid = Number(userId);
    const xpNum = Number(xp);

    if (!Number.isFinite(uid) || uid <= 0) return res.status(400).json({ error: "Bad userId" });
    if (!Number.isFinite(xpNum) || xpNum < 0) return res.status(400).json({ error: "Bad xp" });

    // init caches
    if (!roleNameToId.size) await loadRoles();
    if (groupOwnerUserId == null) {
      try { await loadGroupOwner(); } catch {}
    }

    if (groupOwnerUserId && uid === groupOwnerUserId) {
      return res.json({ success: true, skipped: true, reason: "GroupOwner" });
    }

    const targetRoleName = pickRoleNameForXP(xpNum).toLowerCase();
    const targetRoleId = roleNameToId.get(targetRoleName);

    if (!targetRoleId) {
      // This is THE big debugging signal if your group role names don’t match
      console.error("[Promote] Role name not found in group:", targetRoleName);
      return res.status(400).json({
        error: "RoleNameNotFound",
        targetRoleName,
        hint: "Check the group role names exactly match (Cadet, Trooper, ...)."
      });
    }

    const currentRoleId = await getCurrentRoleId(uid);
    if (currentRoleId && String(currentRoleId) === String(targetRoleId)) {
      return res.json({ success: true, skipped: true, reason: "AlreadyCorrect", roleName: targetRoleName });
    }

    await setUserRoleWithRetry(uid, targetRoleId);

    return res.json({ success: true, roleName: targetRoleName });
  } catch (err) {
    console.error("[/update-xp] FAIL:", {
      message: err?.message || String(err),
      body
    });
    return res.status(500).json({
      error: "Promotion failed",
      details: String(err?.message || err)
    });
  }
}

app.post("/update-xp", handleUpdate); // ✅ your endpoint
app.post("/promote", handleUpdate);   // ✅ compatibility

app.get("/", (req, res) => res.send("Bot automation running"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await loadRoles();
    await loadGroupOwner();
    console.log("Preloaded roles + owner OK");
  } catch (e) {
    console.log("Preload failed (will retry on first request):", e?.message || e);
  }
});
