import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { z } from "zod";
import { getPaypalBaseUrl, getPaypalToken, verifyPaypalWebhook } from "./paypal.js";
import { createCulqiOrder } from "./culqi.js";

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
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const cleanOrigin = origin.replace(/\/$/, "");
      if (allowedOrigins.includes("*") || allowedOrigins.includes(cleanOrigin)) {
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
const commissionByLevel = {
  1: 50,
  2: 20,
  3: 10,
  4: 5,
};

const SALES_API_KEY = process.env.SALES_API_KEY || "";
const FX_PEN_TO_USD = Number.parseFloat(process.env.FX_PEN_TO_USD || "0.27");
const REFUND_HOLD_DAYS = Number.parseInt(process.env.REFUND_HOLD_DAYS || "14", 10);
const PAYOUT_MIN_USD = Number.parseFloat(process.env.PAYOUT_MIN_USD || "100");
const PAYPAL_PLAN_ID_BASIC = process.env.PAYPAL_PLAN_ID_BASIC || "";
const PAYPAL_PLAN_ID_PRO = process.env.PAYPAL_PLAN_ID_PRO || "";
const PAYPAL_PLAN_ID_ELITE = process.env.PAYPAL_PLAN_ID_ELITE || "";
const CULQI_PUBLIC_KEY = process.env.CULQI_PUBLIC_KEY || "";
const CULQI_SECRET_KEY = process.env.CULQI_SECRET_KEY || "";
const CULQI_ORDER_EXP_MINUTES = Number.parseInt(process.env.CULQI_ORDER_EXP_MINUTES || "30", 10);

const planPricesPen = {
  basic: 50,
  pro: 75,
  elite: 99,
};

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
    minPlan: "basic",
  },
];

const planRank = (plan) => {
  const index = planOrder.indexOf(plan);
  return index === -1 ? 0 : index;
};

const planLevelCap = (plan) => {
  if (plan === "elite") return 4;
  if (plan === "pro") return 2;
  return 1;
};

const planFromId = (planId) => {
  if (!planId) return null;
  if (planId === PAYPAL_PLAN_ID_BASIC) return "basic";
  if (planId === PAYPAL_PLAN_ID_PRO) return "pro";
  if (planId === PAYPAL_PLAN_ID_ELITE) return "elite";
  return null;
};

const getPlanId = (planCode) => {
  if (planCode === "basic") return PAYPAL_PLAN_ID_BASIC;
  if (planCode === "pro") return PAYPAL_PLAN_ID_PRO;
  if (planCode === "elite") return PAYPAL_PLAN_ID_ELITE;
  return null;
};

const getBaseUrl = (req) => {
  return process.env.APP_BASE_URL || req.headers.origin || `https://${req.headers.host}`;
};

const formatUsd = (value) => `$ ${Number(value || 0).toFixed(2)}`;
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const penToUsd = (penValue) => round2(Number(penValue || 0) * FX_PEN_TO_USD);
const holdUntilDate = () =>
  Timestamp.fromDate(new Date(Date.now() + REFUND_HOLD_DAYS * 24 * 60 * 60 * 1000));
const getPlanPricePen = (plan) => planPricesPen[plan] ?? null;
const toCulqiAmount = (penValue) => Math.round(Number(penValue || 0) * 100);
const buildOrderNumber = () =>
  `AP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

const splitName = (fullName) => {
  const cleaned = (fullName || "").trim();
  if (!cleaned) return { firstName: "Afiliados", lastName: "PRO" };
  const parts = cleaned.split(/\s+/);
  return {
    firstName: parts[0] || "Afiliados",
    lastName: parts.slice(1).join(" ") || "PRO",
  };
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
      totalEarningsUsd: 0,
      availableBalanceUsd: 0,
      pendingBalanceUsd: 0,
      plan: planId,
      networkTotal: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
};

const resolvePlanLabel = (plan) => {
  if (plan === "elite") return "Elite";
  if (plan === "pro") return "Pro";
  return "Basico";
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

const updateUserPlan = async ({ uid, plan, status, source, payload }) => {
  const updates = {
    ...(plan ? { plan } : {}),
    ...(status ? { status } : {}),
    ...(source ? { planSource: source } : {}),
    ...(payload ? { paymentMeta: payload } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await db.collection("users").doc(uid).set(updates, { merge: true });
  if (plan) {
    await db.collection("stats").doc(uid).set(
      {
        plan,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
};

const fetchUsersByReferrers = async (referrerIds = []) => {
  if (!referrerIds.length) return [];
  const chunks = [];
  for (let i = 0; i < referrerIds.length; i += 10) {
    chunks.push(referrerIds.slice(i, i + 10));
  }
  const results = [];
  for (const chunk of chunks) {
    const snap = await db.collection("users").where("referredBy", "in", chunk).get();
    if (!snap.empty) {
      snap.docs.forEach((doc) => results.push({ id: doc.id, ...doc.data() }));
    }
  }
  return results;
};

const buildDownline = async (rootUid, maxLevels = 4) => {
  const members = [];
  const counts = {};
  let currentLevel = 1;
  let currentIds = [rootUid];

  while (currentLevel <= maxLevels && currentIds.length) {
    const levelUsers = await fetchUsersByReferrers(currentIds);
    counts[currentLevel] = levelUsers.length;

    levelUsers.forEach((user) => {
      members.push({
        id: user.uid || user.id,
        name: user.fullName || user.email || "Sin nombre",
        plan: resolvePlanLabel(user.plan),
        level: currentLevel,
        earnings: formatUsd(0),
      });
    });

    currentIds = levelUsers.map((user) => user.uid || user.id);
    currentLevel += 1;
  }

  return { members, counts };
};

const getUpline = async (uid) => {
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) return null;
  const user = userSnap.data();
  if (!user?.referredBy) return null;
  const refSnap = await db.collection("users").doc(user.referredBy).get();
  if (!refSnap.exists) return null;
  const refData = refSnap.data();
  return {
    uid: refSnap.id,
    name: refData.fullName || refData.email || "",
    plan: resolvePlanLabel(refData.plan),
    referralCode: refData.referralCode || "",
  };
};

const refreshPendingCommissions = async (uid) => {
  const pendingSnap = await db
    .collection("commissions")
    .where("beneficiaryId", "==", uid)
    .where("status", "==", "pending")
    .where("holdUntil", "<=", Timestamp.now())
    .get();

  if (pendingSnap.empty) return;

  let releasedTotal = 0;
  const batch = db.batch();
  pendingSnap.docs.forEach((doc) => {
    const data = doc.data();
    releasedTotal += Number(data.amountUsd || 0);
    batch.update(doc.ref, {
      status: "approved",
      releasedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const statsRef = db.collection("stats").doc(uid);
  batch.set(
    statsRef,
    {
      pendingBalanceUsd: FieldValue.increment(-releasedTotal),
      availableBalanceUsd: FieldValue.increment(releasedTotal),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();
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
      await db.collection("users").doc(referredBy).collection("network").doc(uid).set({
        uid,
        name: userData.fullName || userData.email,
        plan: "basic",
        level: 1,
        earnings: formatUsd(0),
        createdAt: FieldValue.serverTimestamp(),
      });

      await db.collection("users").doc(referredBy).collection("activity").add({
        name: userData.fullName || userData.email,
        action: "se unio a tu red",
        level: "Nivel 1",
        time: "Ahora",
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
  await refreshPendingCommissions(uid);
  const [userSnap, statsSnap, activitySnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("stats").doc(uid).get(),
    db.collection("users").doc(uid).collection("activity").orderBy("createdAt", "desc").limit(8).get(),
  ]);

  const user = userSnap.data();
  const stats = statsSnap.data() || {};

  const activity = activitySnap.empty
    ? []
    : activitySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const downline = await buildDownline(uid, 4);
  const networkTotal = downline.members.length;

  const responseStats = [
    {
      title: "Ganancias Totales",
      value: formatUsd(stats.totalEarningsUsd ?? 0),
      change: stats.totalEarningsUsd ? "+0%" : "Sin cambios",
      variant: "emerald",
    },
    {
      title: "Saldo Disponible",
      value: formatUsd(stats.availableBalanceUsd ?? 0),
      change:
        (stats.availableBalanceUsd ?? 0) >= PAYOUT_MIN_USD
          ? "Listo para pago"
          : `Min. ${formatUsd(PAYOUT_MIN_USD)}`,
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

  const { members, counts } = await buildDownline(uid, 4);

  const levels = baseLevels.map((lvl) => ({
    ...lvl,
    members: counts[lvl.level] || 0,
  }));

  const totalPotential = 85;
  const currentPotential = planId === "elite" ? 85 : planId === "pro" ? 70 : 50;
  const upline = await getUpline(uid);

  res.json({
    levels,
    members,
    totalPotential,
    currentPotential,
    upline,
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

app.post("/paypal/create-subscription", requireAuth, async (req, res) => {
  try {
    const { planCode } = req.body || {};
    const planId = getPlanId(planCode);
    if (!planCode || !planId) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const baseUrl = getBaseUrl(req);
    const returnUrl = `${baseUrl}/subscription?paypal=success`;
    const cancelUrl = `${baseUrl}/subscription?paypal=cancel`;

    const accessToken = await getPaypalToken();
    const response = await fetch(`${getPaypalBaseUrl()}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_id: planId,
        custom_id: `${req.user.uid}:${planCode}`,
        application_context: {
          brand_name: "Afiliados PRO",
          locale: "es-PE",
          user_action: "SUBSCRIBE_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.message || "PayPal error" });
    }

    const approval = data?.links?.find((link) => link.rel === "approve");
    if (!approval?.href) {
      return res.status(500).json({ error: "No approval link" });
    }

    await db.collection("users").doc(req.user.uid).set(
      {
        paypalSubscriptionId: data.id,
        paypalPlanId: planId,
        pendingPlan: planCode,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({ approvalUrl: approval.href, subscriptionId: data.id });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Server error" });
  }
});

app.post("/paypal/webhook", async (req, res) => {
  try {
    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const ok = await verifyPaypalWebhook(req.headers, event);
    if (!ok) {
      return res.status(400).json({ error: "Webhook not verified" });
    }

    const type = event?.event_type || "";
    const resource = event?.resource || {};
    const subscriptionId = resource?.id;
    const planId = resource?.plan_id;
    const planCode = planFromId(planId);
    const customId = resource?.custom_id || "";
    const [customUid, customPlan] = customId.split(":");
    const uid = customUid || customId || null;

    let userRef = null;
    if (uid) {
      userRef = db.collection("users").doc(uid);
    } else if (subscriptionId) {
      const snap = await db
        .collection("users")
        .where("paypalSubscriptionId", "==", subscriptionId)
        .limit(1)
        .get();
      if (!snap.empty) {
        userRef = snap.docs[0].ref;
      }
    }

    if (!userRef) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const updates = {
      paypalSubscriptionId: subscriptionId || null,
      paypalPlanId: planId || null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    const finalPlan = planCode || customPlan || "basic";

    if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
      updates.status = "ACTIVE";
      updates.plan = finalPlan;
      updates.pendingPlan = FieldValue.delete();
    }

    if (
      type === "BILLING.SUBSCRIPTION.CANCELLED" ||
      type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
      type === "BILLING.SUBSCRIPTION.EXPIRED" ||
      type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
    ) {
      updates.status = "SUSPENDED";
      updates.pendingPlan = FieldValue.delete();
    }

    if (type === "BILLING.SUBSCRIPTION.UPDATED") {
      if (resource?.status === "ACTIVE") {
        updates.status = "ACTIVE";
        updates.plan = finalPlan;
        updates.pendingPlan = FieldValue.delete();
      }
    }

    await userRef.set(updates, { merge: true });
    if (updates.plan) {
      await db.collection("stats").doc(userRef.id).set(
        {
          plan: updates.plan,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Webhook error" });
  }
});

app.post("/culqi/orders", requireAuth, async (req, res) => {
  if (!CULQI_SECRET_KEY || !CULQI_PUBLIC_KEY) {
    return res.status(500).json({ error: "Culqi not configured" });
  }

  const schema = z
    .object({
      plan: z.enum(["basic", "pro", "elite"]),
      phone: z.string().min(9).max(15),
      paymentMethod: z.enum(["yape", "plin"]).optional(),
    })
    .safeParse(req.body || {});

  if (!schema.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { plan, phone, paymentMethod } = schema.data;
  const amountPen = getPlanPricePen(plan);
  if (!amountPen) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  const { firstName, lastName } = splitName(req.user?.name || req.user?.email || "");
  const amount = toCulqiAmount(amountPen);
  const orderNumber = buildOrderNumber();
  const expirationDate = Math.floor(Date.now() / 1000) + CULQI_ORDER_EXP_MINUTES * 60;

  try {
    const order = await createCulqiOrder({
      amount,
      currency_code: "PEN",
      description: `Afiliados PRO - Plan ${plan.toUpperCase()}`,
      order_number: orderNumber,
      client_details: {
        first_name: firstName,
        last_name: lastName,
        email: req.user?.email || "cliente@afiliadospro.com",
        phone_number: phone,
      },
      expiration_date: expirationDate,
    });

    await db.collection("culqiOrders").doc(order.id).set({
      uid: req.user.uid,
      plan,
      paymentMethod: paymentMethod || "yape",
      amountPen,
      amount,
      status: order.state || order.status || "pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.json({
      orderId: order.id,
      publicKey: CULQI_PUBLIC_KEY,
      amount,
      currencyCode: "PEN",
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Culqi error" });
  }
});

app.post("/culqi/webhook", async (req, res) => {
  try {
    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const eventType = event?.type || event?.event_type || "";
    if (!eventType) {
      return res.status(400).json({ error: "Missing event type" });
    }

    const payload = event?.data?.object || event?.data || {};
    const orderId = payload?.id || payload?.order_id;
    if (!orderId) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const status = String(payload?.state || payload?.status || "").toLowerCase();

    await db.collection("culqiOrders").doc(orderId).set(
      {
        status: status || "unknown",
        rawEventType: eventType,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (eventType === "order.status.changed" && status === "paid") {
      const orderSnap = await db.collection("culqiOrders").doc(orderId).get();
      if (orderSnap.exists) {
        const orderData = orderSnap.data();
        if (orderData?.uid && orderData?.plan) {
          await updateUserPlan({
            uid: orderData.uid,
            plan: orderData.plan,
            status: "ACTIVE",
            source: "culqi",
            payload: {
              culqiOrderId: orderId,
              method: orderData.paymentMethod || "yape",
            },
          });
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Webhook error" });
  }
});

app.post("/bundle/sales", async (req, res) => {
  if (!SALES_API_KEY) {
    return res.status(500).json({ error: "Sales key not configured" });
  }

  const headerKey = req.headers["x-sales-key"];
  if (headerKey !== SALES_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const schema = z
    .object({
      externalId: z.string().min(3).optional(),
      buyerEmail: z.string().email(),
      amountPen: z.number().positive(),
      referralCode: z.string().min(3).optional(),
      source: z.string().optional(),
    })
    .safeParse(req.body || {});

  if (!schema.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { externalId, buyerEmail, amountPen, referralCode, source } = schema.data;
  const saleId = externalId || db.collection("bundleSales").doc().id;
  const saleRef = db.collection("bundleSales").doc(saleId);
  const saleSnap = await saleRef.get();
  if (saleSnap.exists) {
    return res.json({ ok: true, saleId, status: "exists" });
  }

  const amountUsd = penToUsd(amountPen);
  let referrer = null;
  if (referralCode && isValidReferralCode(referralCode)) {
    referrer = await findUserByReferral(referralCode.toUpperCase());
  }

  const holdUntil = holdUntilDate();

  await saleRef.set({
    buyerEmail,
    amountPen,
    amountUsd,
    referralCode: referralCode || null,
    referrerId: referrer?.id || null,
    status: "paid",
    source: source || "manual",
    createdAt: FieldValue.serverTimestamp(),
    holdUntil,
  });

  if (!referrer) {
    return res.json({ ok: true, saleId, status: "no-referrer" });
  }

  const uplineChain = [];
  let currentRef = referrer;
  for (let level = 1; level <= 4 && currentRef; level += 1) {
    uplineChain.push({ level, ...currentRef });
    if (!currentRef.referredBy) break;
    const nextSnap = await db.collection("users").doc(currentRef.referredBy).get();
    if (!nextSnap.exists) break;
    currentRef = { id: nextSnap.id, ...nextSnap.data() };
  }

  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  uplineChain.forEach((upline) => {
    const allowedLevels = planLevelCap(upline.plan || "basic");
    if (upline.level > allowedLevels) return;

    const percent = commissionByLevel[upline.level] || 0;
    if (!percent) return;

    const commissionAmount = round2((amountUsd * percent) / 100);
    const commissionRef = db.collection("commissions").doc();

    batch.set(commissionRef, {
      transactionId: saleId,
      beneficiaryId: upline.id,
      level: upline.level,
      percent,
      amountUsd: commissionAmount,
      status: "pending",
      holdUntil,
      createdAt: now,
      updatedAt: now,
    });

    const statsRef = db.collection("stats").doc(upline.id);
    batch.set(
      statsRef,
      {
        totalEarningsUsd: FieldValue.increment(commissionAmount),
        pendingBalanceUsd: FieldValue.increment(commissionAmount),
        updatedAt: now,
      },
      { merge: true }
    );
  });

  batch.set(
    db.collection("users").doc(referrer.id).collection("activity").doc(),
    {
      name: buyerEmail,
      action: "compro el bundle",
      level: "Venta",
      time: "Reciente",
      createdAt: now,
    }
  );

  await batch.commit();

  return res.json({ ok: true, saleId, status: "recorded" });
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
