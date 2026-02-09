import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { z } from "zod";

const PORT = process.env.PORT || 8080;
const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!rawServiceAccount) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");
}

const serviceAccount = JSON.parse(rawServiceAccount);
initializeApp({ credential: cert(serviceAccount) });

const auth = getAuth();
const db = getFirestore();

const app = express();

const adminEmails = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS_NOT_ALLOWED"), false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

const plans = [
  {
    id: "basic",
    name: "Basico",
    price: 50,
    commission: 50,
    description: "Ideal para comenzar con tus herramientas y generar tus primeras comisiones.",
    features: [
      "Acceso a 3 Apps (ContApp, Fast Page, Lead Widget)",
      "Comision Nivel 1: 50%",
      "Soporte por email",
      "Panel de afiliados basico",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: 75,
    commission: 70,
    description: "Desbloquea el siguiente nivel de comisiones y maximiza tu red.",
    features: [
      "Todo en Basico",
      "Comision Nivel 2: 20% (Total: 70%)",
      "Reportes avanzados",
      "Soporte prioritario",
      "Badge exclusivo de Pro",
    ],
  },
  {
    id: "elite",
    name: "Elite",
    price: 99,
    commission: 85,
    description: "Acceso VIP. Desbloquea los 4 niveles y maximiza tus ingresos pasivos.",
    features: [
      "Todo en Pro",
      "Comision Nivel 3: 10%",
      "Comision Nivel 4: 5% (Total: 85%)",
      "Acceso VIP a nuevas herramientas",
      "Soporte 1:1 personalizado",
      "Webinars exclusivos",
    ],
  },
];

const planOrder = ["basic", "pro", "elite"];

const defaultTools = [
  {
    id: "contapp",
    name: "ContApp",
    description: "Sistema de contabilidad inteligente para freelancers y PYMEs.",
    color: "emerald",
    minPlan: "basic",
  },
  {
    id: "fastpage",
    name: "Fast Page",
    description: "Crea landing pages profesionales en minutos, sin codigo.",
    color: "blue",
    minPlan: "basic",
  },
  {
    id: "leadwidget",
    name: "Lead Widget",
    description: "Captura leads automaticamente desde tu web o redes sociales.",
    color: "purple",
    minPlan: "pro",
  },
];

const planRank = (plan) => {
  const index = planOrder.indexOf(plan);
  return index === -1 ? 0 : index;
};

const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const token = header.replace("Bearer ", "");
    const decoded = await auth.verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

const requireAdmin = (req, res, next) => {
  if (!adminEmails.length) {
    return res.status(403).json({ error: "Admin access not configured" });
  }
  const email = (req.user?.email || "").toLowerCase();
  if (!adminEmails.includes(email)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
};

const generateReferralCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `AF-${code}`;
};

const findUserByReferral = async (referralCode) => {
  const snap = await db.collection("users").where("referralCode", "==", referralCode).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
};

const isValidReferralCode = (code) => /^AF-[A-Z0-9]{4,}$/.test(code);

const ensureStats = async (uid, planId) => {
  const statsRef = db.collection("stats").doc(uid);
  const statsSnap = await statsRef.get();
  if (!statsSnap.exists) {
    await statsRef.set({
      totalEarnings: 0,
      availableBalance: 0,
      plan: planId,
      networkTotal: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
};

const serializeUser = (doc) => {
  if (!doc) return null;
  return {
    uid: doc.uid,
    email: doc.email || "",
    fullName: doc.fullName || "",
    plan: doc.plan || "basic",
    referralCode: doc.referralCode || "",
    referredBy: doc.referredBy || null,
    disabled: !!doc.disabled,
    createdAt: doc.createdAt || null,
  };
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/referrals/validate", async (req, res) => {
  const rawCode = String(req.query.code || "").trim().toUpperCase();
  if (!rawCode || !isValidReferralCode(rawCode)) {
    return res.json({ valid: false });
  }

  const refUser = await findUserByReferral(rawCode);
  if (!refUser) {
    return res.json({ valid: false });
  }

  return res.json({
    valid: true,
    referrerId: refUser.id,
    referrerName: refUser.fullName || refUser.email || "",
  });
});

app.post("/users/bootstrap", requireAuth, async (req, res) => {
  const schema = z
    .object({
      fullName: z.string().min(2).optional(),
      referrerCode: z.string().min(3).optional(),
    })
    .safeParse(req.body || {});

  if (!schema.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { fullName, referrerCode } = schema.data;
  const uid = req.user.uid;
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    const referralCode = generateReferralCode();
    let referredBy = null;

    if (referrerCode) {
      const refUser = await findUserByReferral(referrerCode);
      if (refUser) {
        referredBy = refUser.id;
      }
    }

    const userData = {
      uid,
      email: req.user.email || "",
      fullName: fullName || req.user.name || "",
      plan: "basic",
      referralCode,
      referredBy,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await userRef.set(userData);

    if (referredBy) {
      await db
        .collection("users")
        .doc(referredBy)
        .collection("network")
        .doc(uid)
        .set({
          uid,
          name: userData.fullName || userData.email,
          plan: "basic",
          level: 1,
          earnings: "S/ 0.00",
          createdAt: FieldValue.serverTimestamp(),
        });
    }
  }

  const freshSnap = await userRef.get();
  const userData = freshSnap.data();
  await ensureStats(uid, userData?.plan || "basic");

  return res.json({ user: serializeUser(userData) });
});

app.get("/me", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    return res.status(404).json({ error: "User not found" });
  }
  return res.json({ user: serializeUser(userSnap.data()) });
});

app.get("/dashboard", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const [userSnap, statsSnap, activitySnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("stats").doc(uid).get(),
    db.collection("users").doc(uid).collection("activity").orderBy("createdAt", "desc").limit(8).get(),
  ]);

  const user = userSnap.data();
  const stats = statsSnap.data();

  const activity = activitySnap.empty
    ? []
    : activitySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const networkSnap = await db.collection("users").doc(uid).collection("network").get();
  const networkTotal = networkSnap.size;

  const responseStats = [
    {
      title: "Ganancias Totales",
      value: `S/ ${(stats?.totalEarnings ?? 0).toFixed(2)}`,
      change: stats?.totalEarnings ? "+0%" : "Sin cambios",
      variant: "emerald",
    },
    {
      title: "Saldo Disponible",
      value: `S/ ${(stats?.availableBalance ?? 0).toFixed(2)}`,
      change: (stats?.availableBalance ?? 0) > 0 ? "Retirable" : "Sin saldo",
      variant: "gold",
    },
    {
      title: "Plan Actual",
      value: plans.find((p) => p.id === (user?.plan || "basic"))?.name || "Basico",
      change: "Activo",
      variant: "default",
    },
    {
      title: "Red Total",
      value: `${networkTotal}`,
      change: networkTotal ? "En crecimiento" : "Sin actividad",
      variant: "default",
    },
  ];

  return res.json({
    stats: responseStats,
    recentActivity: activity,
  });
});

app.get("/tools", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  const planId = userSnap.data()?.plan || "basic";
  const rank = planRank(planId);

  const tools = defaultTools.map((tool) => ({
    ...tool,
    status: planRank(tool.minPlan) <= rank ? "active" : "inactive",
  }));

  res.json({ tools });
});

app.get("/network", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  const planId = userSnap.data()?.plan || "basic";

  const unlockedLevels = planId === "elite" ? 4 : planId === "pro" ? 2 : 1;

  const baseLevels = [
    { level: 1, commission: 50, unlockPlan: "Basico", unlocked: unlockedLevels >= 1 },
    { level: 2, commission: 20, unlockPlan: "Pro", unlocked: unlockedLevels >= 2 },
    { level: 3, commission: 10, unlockPlan: "Elite", unlocked: unlockedLevels >= 3 },
    { level: 4, commission: 5, unlockPlan: "Elite", unlocked: unlockedLevels >= 4 },
  ];

  const membersSnap = await db.collection("users").doc(uid).collection("network").orderBy("createdAt", "desc").limit(50).get();
  const members = membersSnap.empty ? [] : membersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const counts = members.reduce((acc, member) => {
    const level = member.level || 1;
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});

  const levels = baseLevels.map((lvl) => ({
    ...lvl,
    members: counts[lvl.level] || 0,
  }));

  const totalPotential = 85;
  const currentPotential = planId === "elite" ? 85 : planId === "pro" ? 70 : 50;

  res.json({
    levels,
    members,
    totalPotential,
    currentPotential,
  });
});

app.get("/subscription", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  const currentPlan = userSnap.data()?.plan || "basic";

  res.json({
    plans,
    currentPlan,
  });
});

app.post("/subscription/upgrade", requireAuth, async (req, res) => {
  const schema = z.object({ plan: z.enum(["basic", "pro", "elite"]) }).safeParse(req.body || {});
  if (!schema.success) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  const uid = req.user.uid;
  const plan = schema.data.plan;

  await db.collection("users").doc(uid).set(
    {
      plan,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db.collection("stats").doc(uid).set(
    {
      plan,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  res.json({ ok: true, plan });
});

app.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
  const cursor = req.query.cursor;

  let query = db.collection("users").orderBy("createdAt", "desc").limit(limit);
  if (cursor) {
    const cursorSnap = await db.collection("users").doc(cursor).get();
    if (cursorSnap.exists) {
      query = query.startAfter(cursorSnap);
    }
  }

  const snap = await query.get();
  const users = snap.docs.map((doc) => ({ id: doc.id, ...serializeUser(doc.data()) }));
  const refIds = Array.from(
    new Set(users.map((user) => user.referredBy).filter(Boolean))
  );
  const refMap = {};
  if (refIds.length) {
    const refSnaps = await Promise.all(
      refIds.map((refId) => db.collection("users").doc(refId).get())
    );
    refSnaps.forEach((refSnap) => {
      if (refSnap.exists) {
        refMap[refSnap.id] = refSnap.data();
      }
    });
  }

  const usersWithRefs = users.map((user) => ({
    ...user,
    referredByName:
      user.referredBy && refMap[user.referredBy]
        ? refMap[user.referredBy].fullName || refMap[user.referredBy].email || user.referredBy
        : null,
  }));
  const nextCursor = snap.docs.length ? snap.docs[snap.docs.length - 1].id : null;

  res.json({ users: usersWithRefs, nextCursor });
});

app.patch("/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  const schema = z
    .object({
      plan: z.enum(["basic", "pro", "elite"]).optional(),
      disabled: z.boolean().optional(),
      fullName: z.string().min(2).optional(),
    })
    .safeParse(req.body || {});

  if (!schema.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { plan, disabled, fullName } = schema.data;
  const uid = req.params.uid;

  if (typeof disabled === "boolean") {
    await auth.updateUser(uid, { disabled });
  }

  const updateData = {
    ...(plan ? { plan } : {}),
    ...(typeof disabled === "boolean" ? { disabled } : {}),
    ...(fullName ? { fullName } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (Object.keys(updateData).length) {
    await db.collection("users").doc(uid).set(updateData, { merge: true });
  }

  if (plan) {
    await db.collection("stats").doc(uid).set(
      {
        plan,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  res.json({ ok: true });
});

app.delete("/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  const uid = req.params.uid;

  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      return res.status(500).json({ error: "Failed to delete auth user" });
    }
  }

  await db.collection("users").doc(uid).delete();
  await db.collection("stats").doc(uid).delete();

  const networkSnap = await db.collection("users").doc(uid).collection("network").get();
  if (!networkSnap.empty) {
    const batch = db.batch();
    networkSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
