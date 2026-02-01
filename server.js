import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === ENV VARIABLES (we add these in Railway later) ===
const GROUP_ID = process.env.GROUP_ID;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const SHARED_SECRET = process.env.SHARED_SECRET;

// === XP → RANK MAPPING (your system) ===
const XP_TO_RANK = [
  { xp: 0, rank: 1 },   // Cadet
  { xp: 3, rank: 2 },   // Trooper
  { xp: 6, rank: 3 },   // Specialist
  { xp: 12, rank: 4 },  // Corporal
  { xp: 18, rank: 5 },  // Sergeant
  { xp: 28, rank: 7 },  // Staff Sergeant
  { xp: 35, rank: 8 },  // Master Sergeant
  { xp: 50, rank: 9 },  // Sergeant Major
  { xp: 75, rank: 10 }, // Warrant Officer
];

function getTargetRank(xp) {
  let result = 1;
  for (const tier of XP_TO_RANK) {
    if (xp >= tier.xp) result = tier.rank;
  }
  return result;
}

// Load role mapping
let rankToRoleId = new Map();

async function loadRoles() {
  const response = await fetch(`https://groups.roblox.com/v1/groups/${GROUP_ID}/roles`);
  const data = await response.json();

  rankToRoleId.clear();
  for (const role of data.roles) {
    rankToRoleId.set(role.rank, role.id);
  }

  console.log("Roles loaded:", Object.fromEntries(rankToRoleId));
}

async function promoteUser(userId, roleId) {
  const rolePath = `groups/${GROUP_ID}/roles/${roleId}`;

  const response = await fetch(
    `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/memberships/${userId}`,
    {
      method: "PATCH",
      headers: {
        "x-api-key": ROBLOX_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ role: rolePath })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text);
  }

  return true;
}

app.post("/promote", async (req, res) => {
  try {
    const { userId, xp, secret } = req.body;

    if (secret !== SHARED_SECRET) {
      return res.status(401).json({ error: "Invalid secret" });
    }

    if (!rankToRoleId.size) {
      await loadRoles();
    }

    const targetRank = getTargetRank(Number(xp));
    const roleId = rankToRoleId.get(targetRank);

    if (!roleId) {
      return res.status(400).json({ error: "Role not found" });
    }

    await promoteUser(userId, roleId);

    res.json({ success: true, rank: targetRank });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Promotion failed" });
  }
});

app.get("/", (req, res) => {
  res.send("Rank bot running");
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await loadRoles();
  } catch (err) {
    console.log("Role preload failed, will retry later.");
  }
});
