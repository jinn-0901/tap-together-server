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
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.get("/", (req, res) => {
  res.send("Tap Together Server가 실행되었습니다.");
});

// 번역 데이터 API — web 또는 app을 넘기면 해당 앱의 5개 언어 데이터를 전부 내려줌
app.get("/translations/:target", (req, res) => {
  const data = TRANSLATIONS[req.params.target];
  if (!data) return res.status(404).json({ error: "not found" });
  res.json(data);
});

const kioskOwners = new Map();
const remoteInRoom = new Map();
const joinAttempts = new Map();

const generateUniqueCode = () => {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (kioskOwners.has(code));
  return code;
};

const leaveRemoteRoom = (socket, code) => {
  if (!code) return;
  if (remoteInRoom.get(code) === socket.id) {
    remoteInRoom.delete(code);
    socket.leave(code);
    io.to(code).emit("remote-left");
  }
};

io.on("connection", (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);

  socket.on("request-kiosk-code", (previousCode) => {
    let carriedRemoteId = null;

    if (previousCode && kioskOwners.get(previousCode) === socket.id) {
      kioskOwners.delete(previousCode);
      carriedRemoteId = remoteInRoom.get(previousCode) || null;
      remoteInRoom.delete(previousCode);
      socket.leave(previousCode);
    }

    const code = generateUniqueCode();
    kioskOwners.set(code, socket.id);
    socket.data.role = "kiosk";
    socket.data.kioskCode = code;
    socket.join(code);

    if (carriedRemoteId) {
      const remoteSocket = io.sockets.sockets.get(carriedRemoteId);
      if (remoteSocket) {
        remoteSocket.leave(previousCode);
        remoteSocket.join(code);
        remoteSocket.data.remoteCode = code;
        remoteInRoom.set(code, carriedRemoteId);
        remoteSocket.emit("kiosk-code-changed", { code });
      }
    }

    socket.emit("kiosk-code-assigned", { code });
    console.log(`새 코드 발급: ${code} (키오스크: ${socket.id})`);
  });

  socket.on("join-room", (code) => {
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

    const existingRemote = remoteInRoom.get(code);
    if (existingRemote && existingRemote !== socket.id) {
      socket.emit("join-error", "ALREADY_CONNECTED");
      return;
    }

    if (socket.data.remoteCode && socket.data.remoteCode !== code) {
      leaveRemoteRoom(socket, socket.data.remoteCode);
    }

    remoteInRoom.set(code, socket.id);
    socket.data.role = "remote";
    socket.data.remoteCode = code;
    socket.join(code);

    socket.emit("joined", code);
    socket.to(code).emit("remote-joined");
    console.log(`${socket.id}가 방 [${code}]에 리모컨으로 참가함`);
  });

  socket.on("leave-room", (code) => {
    leaveRemoteRoom(socket, code);
    socket.data.remoteCode = null;
    console.log(`${socket.id}가 방 [${code}]에서 스스로 나감`);
  });

  socket.on("toggle-feature", ({ code, featureId, on }) => {
    if (remoteInRoom.get(code) === socket.id) {
      io.to(code).emit("feature-toggled", { featureId, on });
      console.log(`[${code}] ${featureId} → ${on ? "ON" : "OFF"}`);
    }
  });

  socket.on("set-language", ({ code, lang }) => {
    if (remoteInRoom.get(code) === socket.id) {
      io.to(code).emit("language-changed", { lang });
      console.log(`[${code}] 언어 변경 → ${lang}`);
    }
  });

  socket.on("kiosk-activity", ({ code, message, langId }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    if (typeof message !== "string" || message.length === 0 || message.length > 200) return;
    if (typeof langId !== "string" || langId.length > 10) return;

    const remoteId = remoteInRoom.get(code);
    if (remoteId) {
      io.to(remoteId).emit("kiosk-activity", { message, langId });
    }
  });

  socket.on("kiosk-reset", (code) => {
    if (kioskOwners.get(code) !== socket.id) return;
    const remoteId = remoteInRoom.get(code);
    if (remoteId) {
      io.to(remoteId).emit("kiosk-left");
      const remoteSocket = io.sockets.sockets.get(remoteId);
      if (remoteSocket) {
        remoteSocket.leave(code);
        remoteSocket.data.remoteCode = null;
      }
      remoteInRoom.delete(code);
    }
    console.log(`[${code}] 결제 완료로 리모컨 연결 강제 해제`);
  });

  socket.on("disconnect", () => {
    joinAttempts.delete(socket.id);

    if (socket.data.role === "kiosk" && socket.data.kioskCode) {
      const code = socket.data.kioskCode;
      kioskOwners.delete(code);
      const remoteId = remoteInRoom.get(code);
      if (remoteId) {
        io.to(remoteId).emit("kiosk-left");
      }
      remoteInRoom.delete(code);
      console.log(`키오스크 연결 해제됨, 코드 반납: ${code}`);
    }

    if (socket.data.role === "remote" && socket.data.remoteCode) {
      leaveRemoteRoom(socket, socket.data.remoteCode);
      console.log(`리모컨 연결 해제됨(비정상 종료 포함)`);
    }

    console.log(`클라이언트 연결 해제됨: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`서버 실행 중 (포트: ${PORT})`);
});
