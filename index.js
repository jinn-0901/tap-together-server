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

app.get("/translations/:target", (req, res) => {
  const data = TRANSLATIONS[req.params.target];
  if (!data) return res.status(404).json({ error: "not found" });

  if (req.params.target === "web") {
    const merged = {};
    for (const langId of Object.keys(data)) {
      merged[langId] = {
        ...data[langId],
        menu: TRANSLATIONS.app[langId]?.menu || {},
        categories: TRANSLATIONS.app[langId]?.categories || {},
      };
    }
    return res.json(merged);
  }

  res.json(data);
});

const kioskOwners = new Map(); // code → 키오스크 socket.id

// code → { direct: socket.id | null, shared: socket.id | null }
const roomSlots = new Map();

const joinAttempts = new Map(); // socket.id → { count, resetAt } — 코드 무차별 대입 방지

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

// 지금 이 방에 리모컨이 최소 한 명이라도 남아있는지
const hasAnyRemote = (code) => {
  const slots = roomSlots.get(code);
  return !!(slots && (slots.direct || slots.shared));
};

// 음성 안내를 받을 대상을 결정: 직접 연결자 우선, 없으면 공유 참가자, 둘 다 없으면 null(키오스크 자체)
const getVoiceTarget = (code) => {
  const slots = roomSlots.get(code);
  if (!slots) return null;
  return slots.direct || slots.shared || null;
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
      // 아무도 안 남았으면 키오스크에 알림 (기본값 리셋용)
      io.to(code).emit("all-remotes-left");
    } else {
      // 누군가는 남아있음 — 남은 사람에게 상태 갱신 알림 (음성 대상이 바뀔 수 있으니)
      io.to(code).emit("remote-roster-changed", {
        hasDirect: !!slots.direct,
        hasShared: !!slots.shared,
      });
      // 키오스크에게도 알려서 notify 라우팅에 반영
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

  // asShared: true면 공유 링크로 들어온 것, false/생략이면 직접 연결(QR)
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

    // 이 소켓이 이전에 다른 코드 방에 있었으면 정리
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

    // 키오스크에게 현재 참가자 구성 알림 (음성 라우팅 갱신용)
    const kioskSocketId = kioskOwners.get(code);
    if (kioskSocketId) {
      io.to(kioskSocketId).emit("remote-roster-changed-for-kiosk", {
        hasDirect: !!slots.direct,
        hasShared: !!slots.shared,
      });
    }

    console.log(`${socket.id}가 방 [${code}]에 ${slotKey === "shared" ? "공유 참가자" : "직접 연결자"}로 참가함`);
  });

  socket.on("leave-room", (code) => {
    leaveSlot(socket, code);
    socket.data.remoteCode = null;
    socket.data.remoteRole = null;
    console.log(`${socket.id}가 방 [${code}]에서 스스로 나감`);
  });

  // 기능 토글/언어 변경은 직접 연결자든 공유 참가자든 둘 다 허용
  socket.on("toggle-feature", ({ code, featureId, on }) => {
    const slots = roomSlots.get(code);
    if (!slots || (slots.direct !== socket.id && slots.shared !== socket.id)) return;
    io.to(code).emit("feature-toggled", { featureId, on });
    console.log(`[${code}] ${featureId} → ${on ? "ON" : "OFF"}`);
  });

  socket.on("set-language", ({ code, lang }) => {
    const slots = roomSlots.get(code);
    if (!slots || (slots.direct !== socket.id && slots.shared !== socket.id)) return;
    io.to(code).emit("language-changed", { lang });
    console.log(`[${code}] 언어 변경 → ${lang}`);
  });

  // 키오스크의 행동을 알림 — 직접 연결자 우선, 없으면 공유 참가자, 둘 다 없으면 키오스크 자체(클라이언트에서 처리)
  socket.on("kiosk-activity", ({ code, message, langId }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    if (typeof message !== "string" || message.length === 0 || message.length > 200) return;
    if (typeof langId !== "string" || langId.length > 10) return;

    const targetId = getVoiceTarget(code);
    if (targetId) {
      io.to(targetId).emit("kiosk-activity", { message, langId });
    } else {
      // 대상이 없으면 키오스크 자신에게 되돌려보내서 스스로 말하게 함
      socket.emit("kiosk-activity-self", { message, langId });
    }
  });

  // 장바구니 상태를 리모컨들에게도 전달 (직접+공유 둘 다)
  socket.on("cart-updated", ({ code, summaryText }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    if (typeof summaryText !== "string" || summaryText.length > 300) return;
    io.to(code).emit("cart-summary-updated", { summaryText });
  });

  socket.on("remote-voice-order", ({ code, itemId, options, wantsToBuy }) => {
    const slots = roomSlots.get(code);
    if (!slots || (slots.direct !== socket.id && slots.shared !== socket.id)) return;
    if (typeof itemId !== "string" || itemId.length > 50) return;

    io.to(code).emit("voice-order-received", { itemId, options, wantsToBuy });
    console.log(`[${code}] 리모컨 음성 주문: ${itemId}`);
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
