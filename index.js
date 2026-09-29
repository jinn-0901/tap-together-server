import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { TRANSLATIONS } from "./translations.js";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
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

  socket.on("request-kiosk-code", (previousCode) => {
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

  socket.on("join-room", (code, asShared) => {
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

  socket.on("leave-room", (code) => {
    leaveSlot(socket, code);
    socket.data.remoteCode = null;
    socket.data.remoteRole = null;
    console.log(`${socket.id}가 방 [${code}]에서 스스로 나감`);
  });

  socket.on("toggle-feature", ({ code, featureId, on }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    io.to(code).emit("feature-toggled", { featureId, on });
    console.log(`[${code}] ${featureId} → ${on ? "ON" : "OFF"}`);
  });

  socket.on("set-language", ({ code, lang }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    io.to(code).emit("language-changed", { lang });
    console.log(`[${code}] 언어 변경 → ${lang}`);
  });

  socket.on("kiosk-activity", ({ code, message, langId }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    if (typeof message !== "string" || message.length === 0 || message.length > 200) return;
    if (typeof langId !== "string" || langId.length > 10) return;

    const targetId = getVoiceTarget(code);
    if (targetId) {
      io.to(targetId).emit("kiosk-activity", { message, langId });
    } else {
      socket.emit("kiosk-activity-self", { message, langId });
    }
  });

  socket.on("cart-state-updated", ({ code, cart }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    if (!Array.isArray(cart) || cart.length > 50) return;
    io.to(code).emit("cart-state-updated", { cart });
  });

  socket.on("remote-voice-order", ({ code, itemId, options, wantsToBuy }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (typeof itemId !== "string" || itemId.length > 50) return;

    io.to(code).emit("voice-order-received", { itemId, options, wantsToBuy });
    console.log(`[${code}] 리모컨 음성 주문: ${itemId}`);
  });

  socket.on("remote-menu-order", ({ code, itemId, options }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (typeof itemId !== "string" || itemId.length > 50) return;
    if (typeof options !== "object" || options === null) return;

    io.to(code).emit("voice-order-received", { itemId, options, wantsToBuy: true });
    console.log(`[${code}] 리모컨 화면 주문: ${itemId}`);
  });

  socket.on("remote-change-qty", ({ code, cartId, delta }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (typeof cartId !== "string" || cartId.length > 100) return;
    if (delta !== 1 && delta !== -1) return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("cart-change-qty-requested", { cartId, delta });
    }
  });

  socket.on("remote-remove-item", ({ code, cartId }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (typeof cartId !== "string" || cartId.length > 100) return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("cart-remove-item-requested", { cartId });
    }
  });

  socket.on("remote-clear-cart", (code) => {
    if (!isRemoteOfRoom(code, socket.id)) return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("cart-clear-requested");
    }
  });

  socket.on("remote-checkout-request", ({ code, dineType }) => {
    if (!isRemoteOfRoom(code, socket.id)) return;
    if (dineType !== "dine-in" && dineType !== "takeout") return;

    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("checkout-requested-by-remote", { dineType });
    }
    console.log(`[${code}] 리모컨이 결제 요청 (${dineType})`);
  });

  socket.on("kiosk-reset", (code) => {
    if (kioskOwners.get(code) !== socket.id) return;
    disconnectAllRemotesFromKiosk(code);
    console.log(`[${code}] 결제 완료로 모든 리모컨 연결 강제 해제`);
  });

  socket.on("kiosk-manual-refresh", (code) => {
    if (kioskOwners.get(code) !== socket.id) return;
    disconnectAllRemotesFromKiosk(code);
    console.log(`[${code}] 수동 새로고침으로 모든 리모컨 연결 강제 해제`);
  });

  socket.on("disconnect", () => {
    joinAttempts.delete(socket.id);

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
