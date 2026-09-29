import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { TRANSLATIONS } from "./translations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 어떤 사이트에서 이 서버에 접속할 수 있는지 제한. 배포된 프론트 주소를 Render 환경변수
// CORS_ALLOWED_ORIGINS에 콤마로 구분해서 넣으면 그 주소들만 허용됨 (예: "https://tap-together-app.vercel.app,https://tap-together-web.vercel.app").
// 설정 안 하면 지금처럼 전체 허용("*")으로 동작해서 기존 배포가 깨지지 않음.
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOriginCheck =
  ALLOWED_ORIGINS.length > 0
    ? (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error("CORS로 차단된 요청"));
      }
    : "*";

const app = express();
app.use(cors({ origin: corsOriginCheck }));

// 쉬운 화면 모드에서 보여줄 실제 메뉴 사진 (public/menu-images/<메뉴id>.jpg)
app.use(
  "/menu-images",
  express.static(path.join(__dirname, "public/menu-images"), { maxAge: "1d" })
);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOriginCheck },
});

// 핸들러 하나에서 예외가 터져도 서버 전체(=다른 모든 키오스크·리모컨)가
// 같이 죽지 않도록 모든 소켓 이벤트 핸들러를 이걸로 감쌈
const safeOn = (socket, eventName, handler) => {
  socket.on(eventName, (...args) => {
    try {
      handler(...args);
    } catch (err) {
      console.error(`[${eventName}] 핸들러 오류:`, err);
    }
  });
};

// 그래도 혹시 핸들러 밖(비동기 콜백 등)에서 뭔가 새면 로그만 남기고 프로세스는 살려둠
process.on("uncaughtException", (err) => {
  console.error("처리 안 된 예외:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("처리 안 된 프로미스 거부:", err);
});

app.get("/", (req, res) => {
  res.send("Tap Together Server가 실행되었습니다.");
});

const ORDER_UI_KEYS = [
  "menu", "categories",
  "sizeLabel", "sizeRegular", "sizeLarge",
  "toppingLabel", "toppingNone", "toppingPearl",
  "whipLabel", "whipNone", "whipAdd",
  "hotIceLabel", "hotOption", "iceOption",
  "addToCartBtn", "closeBtn",
  "cartTitle", "clearBtn", "cartEmpty", "totalCountLabel", "checkoutBtn",
  "dineTypeTitle", "dineIn", "takeout", "orderSectionTitle",
  "qtyDecreaseLabel", "qtyIncreaseLabel", "removeItemLabel",
];

app.get("/translations/:target", (req, res) => {
  const data = TRANSLATIONS[req.params.target];
  if (!data) return res.status(404).json({ error: "not found" });

  if (req.params.target === "web") {
    const merged = {};
    for (const langId of Object.keys(data)) {
      const extra = {};
      for (const key of ORDER_UI_KEYS) {
        if (TRANSLATIONS.app[langId]?.[key] !== undefined) {
          extra[key] = TRANSLATIONS.app[langId][key];
        }
      }
      merged[langId] = { ...data[langId], ...extra };
    }
    return res.json(merged);
  }

  res.json(data);
});

const kioskOwners = new Map();
const roomSlots = new Map();
const joinAttempts = new Map();
const ipJoinAttempts = new Map();
const rateLimitBuckets = new Map();

// join-room 제한(joinAttempts)은 소켓 하나당이라 재연결/여러 탭으로 우회하면
// 6자리 코드를 무한정 시도해볼 수 있음 — 같은 IP 기준으로도 한 번 더 막아서
// 소켓을 계속 새로 만들어도 전체 시도 횟수 자체를 제한함
const getClientIp = (socket) => {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return socket.handshake.address || "unknown";
};

const isIpJoinLimited = (ip) => {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const record = ipJoinAttempts.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count += 1;
  ipJoinAttempts.set(ip, record);
  return record.count > 60;
};

// 오래된 IP 기록이 쌓이기만 하는 걸 막기 위해 주기적으로 청소
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipJoinAttempts.entries()) {
    if (now > record.resetAt) ipJoinAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref?.();

// 이벤트별로 한 소켓이 너무 자주 보내면 막음 (도배/스팸 방지). true면 이번 요청은 거부.
const isRateLimited = (socket, eventName, max, windowMs) => {
  const key = `${socket.id}:${eventName}`;
  const now = Date.now();
  const record = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count += 1;
  rateLimitBuckets.set(key, record);
  return record.count > max;
};

const clearRateLimitBucketsFor = (socketId) => {
  for (const key of rateLimitBuckets.keys()) {
    if (key.startsWith(`${socketId}:`)) rateLimitBuckets.delete(key);
  }
};

const SUPPORTED_LANGS = new Set(Object.keys(TRANSLATIONS.app));
const KNOWN_FEATURE_IDS = new Set(["easy-mode", "voice", "large-text", "high-contrast", "voice-guide"]);

const generateUniqueCode = () => {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (kioskOwners.has(code));
  return code;
};

const getSlots = (code) => {
  if (!roomSlots.has(code)) {
    roomSlots.set(code, { direct: null, shared: null });
  }
  return roomSlots.get(code);
};

// 음성 안내는 직접 연결자에게만 보냄 — 공유 참가자만 있으면 대상 없음(null)으로 반환해서 키오스크가 직접 말하게 함
const getVoiceTarget = (code) => {
  const slots = roomSlots.get(code);
  if (!slots) return null;
  return slots.direct || null;
};

const isRemoteOfRoom = (code, socketId) => {
  const slots = roomSlots.get(code);
  return !!(slots && (slots.direct === socketId || slots.shared === socketId));
};

const leaveSlot = (socket, code) => {
  if (!code) return;
  const slots = roomSlots.get(code);
  if (!slots) return;

  let changed = false;
  if (slots.direct === socket.id) {
    slots.direct = null;
    changed = true;
  }
  if (slots.shared === socket.id) {
    slots.shared = null;
    changed = true;
  }

  if (changed) {
    socket.leave(code);
    if (!slots.direct && !slots.shared) {
      io.to(code).emit("all-remotes-left");
    } else {
      io.to(code).emit("remote-roster-changed", {
        hasDirect: !!slots.direct,
        hasShared: !!slots.shared,
      });
      const kioskSocketId = kioskOwners.get(code);
      if (kioskSocketId) {
        io.to(kioskSocketId).emit("remote-roster-changed-for-kiosk", {
          hasDirect: !!slots.direct,
          hasShared: !!slots.shared,
        });
      }
    }
  }
};

const disconnectAllRemotesFromKiosk = (code) => {
  const slots = roomSlots.get(code);
  if (!slots) return;

  [slots.direct, slots.shared].forEach((sid) => {
    if (!sid) return;
    io.to(sid).emit("kiosk-left");
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.leave(code);
      s.data.remoteCode = null;
      s.data.remoteRole = null;
    }
  });

  roomSlots.delete(code);
};

io.on("connection", (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);

  safeOn(socket, "request-kiosk-code", (previousCode) => {
    if (previousCode && kioskOwners.get(previousCode) === socket.id) {
      kioskOwners.delete(previousCode);
      disconnectAllRemotesFromKiosk(previousCode);
      socket.leave(previousCode);
    }

    const code = generateUniqueCode();
    kioskOwners.set(code, socket.id);
    socket.data.role = "kiosk";
    socket.data.kioskCode = code;
    socket.join(code);

    socket.emit("kiosk-code-assigned", { code });
    console.log(`새 코드 발급: ${code} (키오스크: ${socket.id})`);
  });

  safeOn(socket, "join-room", (code, asShared) => {
    if (isIpJoinLimited(getClientIp(socket))) {
      socket.emit("join-error", "TOO_MANY_ATTEMPTS");
      return;
    }

    const now = Date.now();
    const record = joinAttempts.get(socket.id) || { count: 0, resetAt: now + 60000 };

    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + 60000;
    }

    record.count += 1;
    joinAttempts.set(socket.id, record);

    if (record.count > 10) {
      socket.emit("join-error", "TOO_MANY_ATTEMPTS");
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      socket.emit("join-error", "INVALID_CODE_FORMAT");
      return;
    }

    if (!kioskOwners.has(code)) {
      socket.emit("join-error", "CODE_NOT_FOUND");
      return;
    }

    const slots = getSlots(code);
    const slotKey = asShared ? "shared" : "direct";

    if (slots[slotKey] && slots[slotKey] !== socket.id) {
      socket.emit("join-error", "ALREADY_CONNECTED");
      return;
    }

    if (socket.data.remoteCode && socket.data.remoteCode !== code) {
      leaveSlot(socket, socket.data.remoteCode);
    }

    slots[slotKey] = socket.id;
    socket.data.role = "remote";
    socket.data.remoteCode = code;
    socket.data.remoteRole = slotKey;
    socket.join(code);

    socket.emit("joined", { code, role: slotKey });
    socket.to(code).emit("remote-joined", { role: slotKey });

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("remote-roster-changed-for-kiosk", {
        hasDirect: !!slots.direct,
        hasShared: !!slots.shared,
      });
      io.to(kioskSocketId).emit("request-cart-state-for-new-remote");
    }

    console.log(`${socket.id}가 방 [${code}]에 ${slotKey === "shared" ? "공유 참가자" : "직접 연결자"}로 참가함`);
  });

  safeOn(socket, "leave-room", (code) => {
    leaveSlot(socket, code);
    socket.data.remoteCode = null;
    socket.data.remoteRole = null;
    console.log(`${socket.id}가 방 [${code}]에서 스스로 나감`);
  });

  safeOn(socket, "toggle-feature", ({ code, featureId, on }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "toggle-feature", 20, 5000)) return;
    if (!KNOWN_FEATURE_IDS.has(featureId)) return;
    if (typeof on !== "boolean") return;

    io.to(code).emit("feature-toggled", { featureId, on });
    console.log(`[${code}] ${featureId} → ${on ? "ON" : "OFF"}`);
  });

  safeOn(socket, "set-language", ({ code, lang }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "set-language", 20, 5000)) return;
    if (!SUPPORTED_LANGS.has(lang)) return;

    io.to(code).emit("language-changed", { lang });
    console.log(`[${code}] 언어 변경 → ${lang}`);
  });

  safeOn(socket, "kiosk-activity", ({ code, message, langId }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    if (isRateLimited(socket, "kiosk-activity", 60, 5000)) return;
    if (typeof message !== "string" || message.length === 0 || message.length > 200) return;
    if (typeof langId !== "string" || langId.length > 10) return;

    const slots = roomSlots.get(code);
    const targetId = getVoiceTarget(code);

    if (targetId) {
      io.to(targetId).emit("kiosk-activity", { message, langId });
    }

    // direct가 없으면(아무도 없거나 공유만 있으면) 키오스크가 직접 말하고,
    // direct가 있어도 공유가 같이 연결돼 있으면 키오스크도 함께 말함(공유 참가자가 옆에서 못 듣지 않도록)
    if (!targetId || (slots && slots.shared)) {
      socket.emit("kiosk-activity-self", { message, langId });
    }
  });

  // cart-state-updated로 넘어온 항목 하나하나가 제대로 된 모양인지 확인
  // (키오스크가 보내는 값이라 신뢰하긴 하지만, 방어적으로 한 번 더 걸러냄)
  const isValidCartItem = (item) =>
    item && typeof item === "object" &&
    typeof item.cartId === "string" && item.cartId.length <= 100 &&
    typeof item.id === "string" && item.id.length <= 50 &&
    Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= 99 &&
    typeof item.unitPrice === "number" && Number.isFinite(item.unitPrice) && item.unitPrice >= 0 &&
    typeof item.options === "object" && item.options !== null;

  safeOn(socket, "cart-state-updated", ({ code, cart }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    if (isRateLimited(socket, "cart-state-updated", 30, 5000)) return;
    if (!Array.isArray(cart) || cart.length > 50) return;
    if (!cart.every(isValidCartItem)) return;

    io.to(code).emit("cart-state-updated", { cart });
  });

  safeOn(socket, "remote-voice-order", ({ code, itemId, options, wantsToBuy }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "remote-voice-order", 15, 5000)) return;
    if (typeof itemId !== "string" || itemId.length > 50) return;
    // options가 null/객체가 아니면(예: 위조된 payload) 그대로 흘려보내지 않음 —
    // 키오스크 쪽 computeUnitPrice(item, options)가 options.size 등을 읽다가 죽을 수 있음
    if (typeof options !== "object" || options === null) return;

    io.to(code).emit("voice-order-received", { itemId, options, wantsToBuy });
    console.log(`[${code}] 리모컨 음성 주문: ${itemId}`);
  });

  safeOn(socket, "remote-menu-order", ({ code, itemId, options }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "remote-menu-order", 15, 5000)) return;
    if (typeof itemId !== "string" || itemId.length > 50) return;
    if (typeof options !== "object" || options === null) return;

    io.to(code).emit("voice-order-received", { itemId, options, wantsToBuy: true });
    console.log(`[${code}] 리모컨 화면 주문: ${itemId}`);
  });

  safeOn(socket, "remote-change-qty", ({ code, cartId, delta }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "remote-change-qty", 30, 5000)) return;
    if (typeof cartId !== "string" || cartId.length > 100) return;
    if (delta !== 1 && delta !== -1) return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("cart-change-qty-requested", { cartId, delta });
    }
  });

  safeOn(socket, "remote-remove-item", ({ code, cartId }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "remote-remove-item", 30, 5000)) return;
    if (typeof cartId !== "string" || cartId.length > 100) return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("cart-remove-item-requested", { cartId });
    }
  });

  safeOn(socket, "remote-clear-cart", (code) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "remote-clear-cart", 10, 5000)) return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("cart-clear-requested");
    }
  });

  safeOn(socket, "remote-checkout-request", ({ code, dineType }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (isRateLimited(socket, "remote-checkout-request", 10, 5000)) return;
    if (dineType !== "dine-in" && dineType !== "takeout") return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("checkout-requested-by-remote", { dineType });
    }
    console.log(`[${code}] 리모컨이 결제 요청 (${dineType})`);
  });

  safeOn(socket, "kiosk-reset", (code) => {
    if (kioskOwners.get(code) !== socket.id) return;
    disconnectAllRemotesFromKiosk(code);
    console.log(`[${code}] 결제 완료로 모든 리모컨 연결 강제 해제`);
  });

  safeOn(socket, "kiosk-manual-refresh", (code) => {
    if (kioskOwners.get(code) !== socket.id) return;
    disconnectAllRemotesFromKiosk(code);
    console.log(`[${code}] 수동 새로고침으로 모든 리모컨 연결 강제 해제`);
  });

  safeOn(socket, "disconnect", () => {
    joinAttempts.delete(socket.id);
    clearRateLimitBucketsFor(socket.id);

    if (socket.data.role === "kiosk" && socket.data.kioskCode) {
      const code = socket.data.kioskCode;
      kioskOwners.delete(code);
      disconnectAllRemotesFromKiosk(code);
      console.log(`키오스크 연결 해제됨, 코드 반납: ${code}`);
    }

    if (socket.data.role === "remote" && socket.data.remoteCode) {
      leaveSlot(socket, socket.data.remoteCode);
      console.log(`리모컨 연결 해제됨(비정상 종료 포함)`);
    }

    console.log(`클라이언트 연결 해제됨: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`서버 실행 중 (포트: ${PORT})`);
});
