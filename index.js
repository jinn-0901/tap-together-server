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
  res.send("Kiosk Bridge Server가 실행 중입니다.");
});

io.on("connection", (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);

  // 코드(방)에 참가 — 키오스크도, 리모컨도 둘 다 이걸로 같은 방에 들어감
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

  // 리모컨이 기능 켜기/끄기 누르면 → 같은 방의 키오스크에게 전달
  socket.on("toggle-feature", ({ code, featureId, on }) => {
    if (socket.rooms.has(code)) {
      io.to(code).emit("feature-toggled", { featureId, on });
      console.log(`[${code}] ${featureId} → ${on ? "ON" : "OFF"}`);
    }
  });

  // 리모컨이 언어 바꾸면 → 같은 방의 키오스크에게 전달
  socket.on("set-language", ({ code, lang }) => {
    if (socket.rooms.has(code)) {
      io.to(code).emit("language-changed", { lang });
      console.log(`[${code}] 언어 변경 → ${lang}`);
    }
  });

  socket.on("disconnect", () => {
    console.log(`클라이언트 연결 해제됨: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`서버 실행 중 (포트: ${PORT})`);
});
