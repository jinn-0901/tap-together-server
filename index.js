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
  res.send("Tag Together Server가 실행 중입니다.");
});

// 지금 사용 중인 키오스크 코드들을 서버가 기억해둠
const activeKioskCodes = new Set();

const generateUniqueCode = () => {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (activeKioskCodes.has(code)); // 이미 쓰이고 있으면 다시 뽑음
  return code;
};

io.on("connection", (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);

  // 키오스크가 코드를 요청함 (처음 켤 때, 새로고침 버튼, 만료돼서 갱신할 때 등)
  socket.on("request-kiosk-code", (previousCode) => {
    // 이전에 쓰던 코드가 있으면 반납(다른 키오스크가 쓸 수 있게)
    if (previousCode) {
      activeKioskCodes.delete(previousCode);
      socket.leave(previousCode);
    }

    const code = generateUniqueCode();
    activeKioskCodes.add(code);
    socket.data.kioskCode = code; // 이 소켓이 어떤 코드를 쓰고 있는지 기억
    socket.join(code);

    socket.emit("kiosk-code-assigned", { code });
    console.log(`새 코드 발급: ${code}`);
  });

  // 리모컨이 코드로 방에 참가
  socket.on("join-room", (code) => {
    if (!/^\d{6}$/.test(code)) {
      socket.emit("join-error", "잘못된 코드 형식이에요");
      return;
    }

    const room = io.sockets.adapter.rooms.get(code);
    const currentSize = room ? room.size : 0;
    if (currentSize >= 2) {
      socket.emit("join-error", "이미 다른 기기가 연결되어 있어요");
      return;
    }

    socket.join(code);
    socket.emit("joined", code);
    socket.to(code).emit("remote-joined");
    console.log(`${socket.id}가 방 [${code}]에 참가함`);
  });

  socket.on("toggle-feature", ({ code, featureId, on }) => {
    if (socket.rooms.has(code)) {
      io.to(code).emit("feature-toggled", { featureId, on });
      console.log(`[${code}] ${featureId} → ${on ? "ON" : "OFF"}`);
    }
  });

  socket.on("set-language", ({ code, lang }) => {
    if (socket.rooms.has(code)) {
      io.to(code).emit("language-changed", { lang });
      console.log(`[${code}] 언어 변경 → ${lang}`);
    }
  });

  // 키오스크 연결이 끊기면 그 코드도 반납 (다른 키오스크가 쓸 수 있게)
  socket.on("disconnect", () => {
    if (socket.data.kioskCode) {
      activeKioskCodes.delete(socket.data.kioskCode);
      console.log(`코드 반납됨: ${socket.data.kioskCode}`);
    }
    console.log(`클라이언트 연결 해제됨: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`서버 실행 중 (포트: ${PORT})`);
});
