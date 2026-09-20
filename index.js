import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  // 연결이 끊긴 걸 더 빨리 감지해서, 불의의 종료(탭 강제 종료 등) 후에도 방이 빨리 비워지게 함
  pingInterval: 5000,
  pingTimeout: 5000,
});

app.get("/", (req, res) => {
  res.send("Tap Together Server가 실행되었습니다.");
});

const kioskOwners = new Map(); // code → 키오스크 socket.id
const remoteInRoom = new Map(); // code → 리모컨 socket.id

const generateUniqueCode = () => {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (kioskOwners.has(code));
  return code;
};

// 리모컨이 특정 코드 방을 실제로 떠나게 정리하는 공통 함수
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

  socket.on("join-room", (code) => {
    if (!/^\d{6}$/.test(code)) {
      socket.emit("join-error", "잘못된 코드 형식이에요");
      return;
    }

    if (!kioskOwners.has(code)) {
      socket.emit("join-error", "존재하지 않는 코드예요");
      return;
    }

    const existingRemote = remoteInRoom.get(code);
    if (existingRemote && existingRemote !== socket.id) {
      socket.emit("join-error", "이미 다른 기기가 연결되어 있어요");
      return;
    }

    // 이 소켓이 이전에 다른 코드 방에 리모컨으로 있었으면 그 방부터 정리
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

  // 리모컨이 명시적으로 연결 해제 버튼을 눌렀을 때
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

  // 키오스크에서 일어난 행동을 연결된 리모컨에게 전달 (음성 안내용)
  socket.on("kiosk-activity", ({ code, message, langId }) => {
    if (kioskOwners.get(code) !== socket.id) return;
    const remoteId = remoteInRoom.get(code);
    if (remoteId) {
      io.to(remoteId).emit("kiosk-activity", { message, langId });
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
