"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  "https://mentiramaestra.onrender.com";

const SECRET =
  process.env.GAME_SECRET ||
  "cambia_esto_por_una_clave_larga_segura";

const WRITE_TIME = 30000;
const VOTE_TIME = 20000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function normalizeText(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const sign = (id) =>
  crypto.createHmac("sha256", SECRET).update(id).digest("hex");

const verify = (id, token) =>
  sign(id) === token;

const shuffle = (arr) =>
  arr.sort(() => Math.random() - 0.5);

const hostNS = io.of("/host");
const playerNS = io.of("/player");

/* ================= ROOM ================= */

function createRoom(hostSocket) {
  const code = crypto.randomBytes(3)
    .toString("hex")
    .toUpperCase();

  rooms.set(code, {
    hostSocket,
    players: new Map(),
    scores: new Map(),
    stats: new Map(),
    questions: new Map(),
    playerOrder: [],
    currentRoundIndex: 0,
    currentAsker: null,
    answer: null,
    lies: new Map(),
    votes: new Map(),
    instantTruths: new Set(),
    state: "waiting"
  });

  return code;
}

/* ================= HOST ================= */

hostNS.on("connection", (socket) => {

  socket.on("createRoom", async () => {
    const code = createRoom(socket.id);
    socket.join(code);

    const joinURL =
      `${PUBLIC_URL}/player.html?room=${code}`;

    const qr = await QRCode.toDataURL(joinURL);

    socket.emit("roomCreated", { code, qr });
  });

  socket.on("startGame", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.questions.size !== room.players.size) return;

    room.playerOrder =
      shuffle([...room.players.keys()]);

    room.currentRoundIndex = 0;

    startRound(roomCode);
  });

  socket.on("newGame", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.forEach((_, id) => {
      room.scores.set(id, 0);
    });

    room.questions.clear();
    room.playerOrder = [];
    room.currentRoundIndex = 0;
    room.lies.clear();
    room.votes.clear();
    room.instantTruths = new Set();
    room.state = "waiting";

    playerNS.to(roomCode)
      .emit("playerQuestionPhase");

    hostNS.to(room.hostSocket)
      .emit("resetToLobby", {
        players: [...room.players.values()]
          .map(p => p.name)
      });
  });
});

/* ================= PLAYER ================= */

playerNS.on("connection", (socket) => {

  socket.on("joinRoom", ({ roomCode, name, playerId, token }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit("error", "Sala no existe");
      return;
    }

    if (playerId && token && verify(playerId, token)) {
      const existing = room.players.get(playerId);
      if (existing) {
        existing.socketId = socket.id;
        socket.join(roomCode);
        socket.data.playerId = playerId;
        socket.data.roomCode = roomCode;
        socket.emit("playerQuestionPhase");
        return;
      }
    }

    const newId = crypto.randomUUID();
    const newToken = sign(newId);

    room.players.set(newId, { name, socketId: socket.id });
    room.scores.set(newId, 0);

    socket.join(roomCode);
    socket.data.playerId = newId;
    socket.data.roomCode = roomCode;

    socket.emit("authAssigned", {
      playerId: newId,
      token: newToken
    });

    socket.emit("playerQuestionPhase");

    hostNS.to(room.hostSocket).emit(
      "updatePlayers",
      [...room.players.values()].map(p => p.name)
    );
  });

  socket.on("submitQuestion", ({ question, answer }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (question.length < 10 || answer.length < 3) return;

    room.questions.set(socket.data.playerId, { question, answer });

    const playersStatus = [...room.players.entries()].map(
      ([id, player]) => ({
        name: player.name,
        ready: room.questions.has(id)
      })
    );

    hostNS.to(room.hostSocket)
      .emit("lobbyUpdate", { playersStatus });

    if (room.questions.size === room.players.size) {
      hostNS.to(room.hostSocket)
        .emit("allQuestionsSubmitted");
    }
  });

  socket.on("submitLie", (lie) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId === room.currentAsker) return;

    const normalizedLie = normalizeText(lie);
    const normalizedTruth = normalizeText(room.answer);

    if (normalizedLie === normalizedTruth) {
      room.instantTruths.add(socket.data.playerId);
      return;
    }

    const existing = [...room.lies.values()]
      .map(l => normalizeText(l));

    if (existing.includes(normalizedLie)) return;

    room.lies.set(socket.data.playerId, lie);
  });

  socket.on("submitVote", (voteId) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId === room.currentAsker) return;
    room.votes.set(socket.data.playerId, voteId);
  });
});

/* ================= GAME FLOW ================= */

function startRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.currentRoundIndex >= room.playerOrder.length) {
    endGame(roomCode);
    return;
  }

  const askerId =
    room.playerOrder[room.currentRoundIndex];

  const { question, answer } =
    room.questions.get(askerId);

  room.currentAsker = askerId;
  room.answer = answer;

  room.lies.clear();
  room.votes.clear();
  room.instantTruths = new Set();

  hostNS.to(room.hostSocket)
    .emit("tvQuestion", question);

  playerNS.to(roomCode)
    .emit("playerWrite", { askerId });

  setTimeout(() => startVoting(roomCode),
    WRITE_TIME);
}

function startVoting(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const unique = new Map();

  [...room.lies.entries(),
   ["truth", room.answer]
  ].forEach(([id, text]) => {
    const key = normalizeText(text);
    if (!unique.has(key)) {
      unique.set(key, { id, text });
    }
  });

  const options = [...unique.values()];
  shuffle(options);

  playerNS.to(roomCode)
    .emit("playerVote", {
      options,
      askerId: room.currentAsker
    });

  setTimeout(() => calculateScores(roomCode),
    VOTE_TIME);
}

function calculateScores(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const instantWinners = [];

  room.instantTruths.forEach(id => {
    const autoPoints = room.players.size - 1;
    room.scores.set(
      id,
      room.scores.get(id) + autoPoints
    );
    instantWinners.push(
      room.players.get(id).name
    );
  });

  if (instantWinners.length > 0) {
    hostNS.to(room.hostSocket)
      .emit("instantTruthReveal", {
        players: instantWinners
      });
  }

  let truthVotes = 0;

  for (const [voterId, voteId] of room.votes.entries()) {
    if (voteId === "truth") {
      truthVotes++;
      room.scores.set(
        voterId,
        room.scores.get(voterId) + 2
      );
    } else if (room.scores.has(voteId)) {
      room.scores.set(
        voteId,
        room.scores.get(voteId) + 1
      );
    }
  }

  hostNS.to(room.hostSocket)
    .emit("tvResults", {
      answer: room.answer,
      scores: Object.fromEntries(room.scores)
    });

  room.currentRoundIndex++;

  setTimeout(() => startRound(roomCode),
    5000);
}

function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const ranking =
    [...room.scores.entries()]
    .sort((a,b)=>b[1]-a[1])
    .map(([id,score])=>({
      name: room.players.get(id).name,
      score
    }));

  hostNS.to(room.hostSocket)
    .emit("tvFinal", { ranking });
}

server.listen(PORT, () =>
  console.log(`Servidor corriendo en puerto ${PORT}`)
);
