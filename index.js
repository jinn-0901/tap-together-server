import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

app.get("/", (req, res) => {
  res.send("Tap Together Server가 실행되었습니다.");
});

// code(문자열) → 키오스크 소켓 id
const kioskOwners = new Map();
// code(문자열) → 리모컨 소켓 id (연결된 리모컨이 없으면 없음)
const remoteInRoom = new Map();

const generateUniqueCode = () => {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (kioskOwners.has(code));
  return code;
};

io.on("connection", (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);

  // 키오스크가 코드를 요청함
  socket.on("request-kiosk-code", (previousCode) => {
    // 이전 코드가 있으면 정리(반납)
    if (previousCode && kioskOwners.get(previousCode) === socket.id) {
      kioskOwners.delete(previousCode);
      const remoteId = remoteInRoom.get(previousCode);
      if (remoteId) {
        io.to(remoteId).emit("kiosk-left");
        remoteInRoom.delete(previousCode);
      }
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

  // 리모컨이 코드로 참가 시도
  socket.on("join-room", (code) => {
    if (!/^\d{6}$/.test(code)) {
      socket.emit("join-error", "잘못된 코드 형식이에요");
      return;
    }

    // 이 코드로 실제 등록된 키오스크가 있는지 확인 (없는 코드 차단)
    if (!kioskOwners.has(code)) {
      socket.emit("join-error", "존재하지 않는 코드예요");
      return;
    }

    // 이미 그 방에 리모컨이 연결되어 있으면 차단 (2명 초과 방지)
    const existingRemote = remoteInRoom.get(code);
    if (existingRemote && existingRemote !== socket.id) {
      socket.emit("join-error", "이미 다른 기기가 연결되어 있어요");
      return;
    }

    remoteInRoom.set(code, socket.id);
    socket.data.role = "remote";
    socket.data.remoteCode = code;
    socket.join(code);

    socket.emit("joined", code);
    socket.to(code).emit("remote-joined");
    console.log(`${socket.id}가 방 [${code}]에 리모컨으로 참가함`);
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

  socket.on("disconnect", () => {
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
      const code = socket.data.remoteCode;
      if (remoteInRoom.get(code) === socket.id) {
        remoteInRoom.delete(code);
        io.to(code).emit("remote-left"); // 키오스크에게 "리모컨 끊김" 알림
        console.log(`리모컨 연결 해제됨: [${code}]`);
      }
    }

    console.log(`클라이언트 연결 해제됨: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`서버 실행 중 (포트: ${PORT})`);
});
