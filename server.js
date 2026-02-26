"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

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

const sign = (id) =>
  crypto.createHmac("sha256", SECRET).update(id).digest("hex");

const verify = (id, token) =>
  sign(id) === token;

const shuffle = (arr) =>
  arr.sort(() => Math.random() - 0.5);

/* ================= NAMESPACES ================= */

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
    currentQuestion: null,
    answer: null,
    lies: new Map(),
    votes: new Map(),
    roundStats: [],
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

    if (room.questions.size !== room.players.size) {
      console.log("Faltan preguntas");
      return;
    }

    room.playerOrder =
      shuffle([...room.players.keys()]);

    room.currentRoundIndex = 0;

    startRound(roomCode);
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

    // 🔁 Reconexión segura
    if (playerId && token && verify(playerId, token)) {
      const existing = room.players.get(playerId);
      if (existing) {
        existing.socketId = socket.id;

        socket.join(roomCode);
        socket.data.playerId = playerId;
        socket.data.roomCode = roomCode;

        socket.emit("playerWaiting");

        return;
      }
    }

    // 🆕 Nuevo jugador
    const newId = crypto.randomUUID();
    const newToken = sign(newId);

    room.players.set(newId, {
      name,
      socketId: socket.id
    });

    room.scores.set(newId, 0);

    room.stats.set(newId, {
      truthsGuessed: 0,
      liesFooledOthers: 0,
      gotFooled: 0
    });

    socket.join(roomCode);
    socket.data.playerId = newId;
    socket.data.roomCode = roomCode;

    socket.emit("authAssigned", {
      playerId: newId,
      token: newToken
    });

    socket.emit("playerWaiting");

    hostNS.to(room.hostSocket).emit(
      "updatePlayers",
      [...room.players.values()].map(p => p.name)
    );
  });

  socket.on("submitQuestion", ({ question, answer }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (question.length < 10 || answer.length < 3)
      return;

    room.questions.set(
      socket.data.playerId,
      { question, answer }
    );

    hostNS.to(room.hostSocket).emit(
      "questionsProgress",
      {
        submitted: room.questions.size,
        total: room.players.size
      }
    );
  });

  socket.on("submitLie", (lie) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId === room.currentAsker)
      return;

    room.lies.set(socket.data.playerId, lie);
  });

  socket.on("submitVote", (voteId) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId === room.currentAsker)
      return;

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
  room.currentQuestion = question;
  room.answer = answer;

  room.lies.clear();
  room.votes.clear();
  room.state = "writing";

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

  room.state = "voting";

  const options = [
    ...room.lies.entries(),
    ["truth", room.answer]
  ].map(([id, text]) => ({ id, text }));

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

  let truthVotes = 0;
  const lieVotesCount = new Map();

  for (const [voterId, voteId] of room.votes.entries()) {
    if (voteId === "truth") {
      truthVotes++;
      room.scores.set(
        voterId,
        room.scores.get(voterId) + 2
      );
      room.stats.get(voterId).truthsGuessed++;
    } else if (room.scores.has(voteId)) {
      room.scores.set(
        voteId,
        room.scores.get(voteId) + 1
      );
      room.stats.get(voteId).liesFooledOthers++;
      room.stats.get(voterId).gotFooled++;
      lieVotesCount.set(
        voteId,
        (lieVotesCount.get(voteId) || 0) + 1
      );
    }
  }

  if (truthVotes === 0) {
    room.scores.set(
      room.currentAsker,
      room.scores.get(room.currentAsker) + 2
    );
  }

  room.roundStats.push({
    lieVotesCount
  });

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
      score,
      stats: room.stats.get(id)
    }));

  const mostLies = ranking.reduce((a,b)=>
    b.stats.liesFooledOthers >
    a.stats.liesFooledOthers ? b : a
  );

  const mostTruths = ranking.reduce((a,b)=>
    b.stats.truthsGuessed >
    a.stats.truthsGuessed ? b : a
  );

  const mostFooled = ranking.reduce((a,b)=>
    b.stats.gotFooled >
    a.stats.gotFooled ? b : a
  );

  hostNS.to(room.hostSocket)
    .emit("tvFinal", {
      ranking,
      awards: {
        mostLies,
        mostTruths,
        mostFooled
      }
    });
}

server.listen(PORT, () =>
  console.log(`Servidor corriendo en puerto ${PORT}`)
);
