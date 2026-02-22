import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ENV
const GROUP_ID = String(process.env.GROUP_ID || "");
const ROBLOX_API_KEY = String(process.env.ROBLOX_API_KEY || "");
const SHARED_SECRET = String(process.env.SHARED_SECRET || "");

if (!GROUP_ID) console.warn("Missing GROUP_ID");
if (!ROBLOX_API_KEY) console.warn("Missing ROBLOX_API_KEY");
if (!SHARED_SECRET) console.warn("Missing SHARED_SECRET");

// XP -> rank number mapping
const XP_TO_RANK = [
  { xp: 0,  rank: 1  },  // Cadet
  { xp: 3,  rank: 2  },  // Trooper
  { xp: 6,  rank: 3  },  // Specialist
  { xp: 12, rank: 4  },  // Corporal
  { xp: 18, rank: 5  },  // Sergeant
  { xp: 28, rank: 7  },  // Staff Sergeant
  { xp: 35, rank: 8  },  // Master Sergeant
  { xp: 50, rank: 9  },  // Sergeant Major
  { xp: 75, rank: 10 },  // Warrant Officer
];

// Safety: never set above this rank number
const MAX_MANAGED_RANK_NUMBER = 10;

function getTargetRankNumber(xp) {
  let result = 1;
  for (const tier of XP_TO_RANK) {
    if (xp >= tier.xp) result = tier.rank;
  }
  return result;
}

let rankToRoleId = new Map();
let groupOwnerUserId = null;

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { res, text, data };
}

async function loadGroupOwner() {
  const { res, data, text } = await fetchJson(`https://groups.roblox.com/v1/groups/${GROUP_ID}`);
  if (!res.ok) throw new Error(text);
  if (data?.owner?.userId) groupOwnerUserId = Number(data.owner.userId);
}

async function loadRoles() {
  const { res, data, text } = await fetchJson(`https://groups.roblox.com/v1/groups/${GROUP_ID}/roles`);
  if (!res.ok) throw new Error(text);

  rankToRoleId.clear();
  for (const role of data.roles || []) {
    rankToRoleId.set(role.rank, role.id);
  }
}

async function getCurrentRoleId(userId) {
  const { res, data, text } = await fetchJson(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
  if (!res.ok) throw new Error(text);

  const entry = (data?.data || []).find((g) => String(g.group?.id) === String(GROUP_ID));
  return entry?.role?.id ?? null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function promoteUserWithRetry(userId, roleId, tries = 4) {
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
      text.includes("FailedToAcquireLock") ||
      text.includes("TooManyRequests") ||
      res.status === 429 ||
      res.status >= 500;

    if (!transient || attempt === tries) {
      throw new Error(text);
    }

    await sleep(250 * attempt);
  }

  return false;
}

async function handlePromote(req, res) {
  try {
    const { userId, xp, secret, loaded } = req.body || {};

    if (secret !== SHARED_SECRET) {
      return res.status(401).json({ error: "Invalid secret" });
    }

    // ✅ CRITICAL: prevent “XP not loaded yet -> Cadet”
    if (loaded !== true) {
      return res.json({ success: true, skipped: true, reason: "NotLoaded" });
    }

    const uid = Number(userId);
    const xpNum = Number(xp);

    if (!Number.isFinite(uid) || uid <= 0) {
      return res.status(400).json({ error: "Bad userId" });
    }
    if (!Number.isFinite(xpNum) || xpNum < 0) {
      return res.status(400).json({ error: "Bad xp" });
    }

    if (!groupOwnerUserId) {
      try { await loadGroupOwner(); } catch {}
    }
    if (!rankToRoleId.size) {
      await loadRoles();
    }

    if (groupOwnerUserId && uid === groupOwnerUserId) {
      return res.json({ success: true, skipped: true, reason: "GroupOwner" });
    }

    let targetRankNumber = getTargetRankNumber(xpNum);
    if (targetRankNumber > MAX_MANAGED_RANK_NUMBER) targetRankNumber = MAX_MANAGED_RANK_NUMBER;

    const targetRoleId = rankToRoleId.get(targetRankNumber);
    if (!targetRoleId) {
      return res.status(400).json({ error: "Role not found for target rank" });
    }

    const currentRoleId = await getCurrentRoleId(uid);
    if (currentRoleId && String(currentRoleId) === String(targetRoleId)) {
      return res.json({ success: true, skipped: true, reason: "AlreadyCorrect", rank: targetRankNumber });
    }

    await promoteUserWithRetry(uid, targetRoleId);
    return res.json({ success: true, rank: targetRankNumber });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Promotion failed" });
  }
}

// ✅ Support both routes
app.post("/promote", handlePromote);
app.post("/update-xp", handlePromote);

app.get("/", (req, res) => res.send("Rank bot running"));

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await loadGroupOwner();
    await loadRoles();
  } catch {
    console.log("Preload failed (will still work on first request).");
  }
});
