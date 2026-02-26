"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const WRITE_TIME = 30000;
const VOTE_TIME = 20000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

/* ================= NAMESPACES ================= */

const hostNamespace = io.of("/host");
const playerNamespace = io.of("/player");

/* ================= ROOM ================= */

function createRoom(hostSocketId) {
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();

  rooms.set(code, {
    hostSocket: hostSocketId,
    players: new Map(),
    scores: new Map(),
    questions: new Map(),
    playerOrder: [],
    currentRoundIndex: 0,
    currentAsker: null,
    answer: null,
    lies: new Map(),
    votes: new Map(),
  });

  return code;
}

/* ================= HOST ================= */

hostNamespace.on("connection", (socket) => {

  socket.on("createRoom", async () => {
    const code = createRoom(socket.id);
    socket.join(code);

    const joinURL = `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/player.html?room=${code}`;
    const qr = await QRCode.toDataURL(joinURL);

    socket.emit("roomCreated", { code, qr });
  });

});

/* ================= PLAYER ================= */

playerNamespace.on("connection", (socket) => {

  socket.on("joinRoom", ({ roomCode, name }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const playerId = crypto.randomUUID();

    room.players.set(playerId, { name, socketId: socket.id });
    room.scores.set(playerId, 0);

    socket.join(roomCode);
    socket.data.playerId = playerId;
    socket.data.roomCode = roomCode;

    hostNamespace.to(room.hostSocket).emit("updatePlayers",
      [...room.players.values()].map(p => p.name)
    );
  });

  socket.on("submitQuestion", ({ question, answer }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (question.length < 10 || answer.length < 3) return;

    room.questions.set(socket.data.playerId, { question, answer });

    hostNamespace.to(room.hostSocket).emit("questionsProgress", {
      submitted: room.questions.size,
      total: room.players.size
    });
  });

  socket.on("submitLie", (lie) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId === room.currentAsker) return;
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

function startGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.playerOrder = shuffle([...room.players.keys()]);
  room.currentRoundIndex = 0;

  startRound(roomCode);
}

function startRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.currentRoundIndex >= room.playerOrder.length) {
    endGame(roomCode);
    return;
  }

  const askerId = room.playerOrder[room.currentRoundIndex];
  const { question, answer } = room.questions.get(askerId);

  room.currentAsker = askerId;
  room.answer = answer;
  room.lies.clear();
  room.votes.clear();

  hostNamespace.to(room.hostSocket).emit("tvQuestion", question);
  playerNamespace.to(roomCode).emit("playerWrite", { askerId });

  setTimeout(() => startVoting(roomCode), WRITE_TIME);
}

function startVoting(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const options = [
    ...room.lies.entries(),
    ["truth", room.answer],
  ].map(([id, text]) => ({ id, text }));

  shuffle(options);

  playerNamespace.to(roomCode).emit("playerVote", {
    options,
    askerId: room.currentAsker
  });

  setTimeout(() => calculateScores(roomCode), VOTE_TIME);
}

function calculateScores(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  let truthVotes = 0;

  for (const [voterId, voteId] of room.votes.entries()) {
    if (voteId === "truth") {
      truthVotes++;
      room.scores.set(voterId, room.scores.get(voterId) + 2);
    } else if (room.scores.has(voteId)) {
      room.scores.set(voteId, room.scores.get(voteId) + 1);
    }
  }

  if (truthVotes === 0) {
    room.scores.set(
      room.currentAsker,
      room.scores.get(room.currentAsker) + 2
    );
  }

  hostNamespace.to(room.hostSocket).emit("tvResults", {
    answer: room.answer,
    scores: Object.fromEntries(room.scores)
  });

  room.currentRoundIndex++;
  setTimeout(() => startRound(roomCode), 5000);
}

function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const ranking = [...room.scores.entries()]
    .sort((a,b) => b[1]-a[1]);

  hostNamespace.to(room.hostSocket).emit("tvFinal", ranking);
}

server.listen(PORT, () =>
  console.log(`Servidor corriendo en puerto ${PORT}`)
);
