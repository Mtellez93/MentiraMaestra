"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const WRITE_TIME = 30000;
const VOTE_TIME = 20000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

function createRoom() {
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  rooms.set(code, {
    hostSocket: null,
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
  });
  return code;
}

/* ---------------- HOST ---------------- */

io.on("connection", (socket) => {

  /* TV crea sala */
  socket.on("createRoom", () => {
    const code = createRoom();
    rooms.get(code).hostSocket = socket.id;
    socket.join(code);
    socket.emit("roomCreated", code);
  });

  /* PLAYER se une */
  socket.on("joinRoom", ({ roomCode, name }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const playerId = crypto.randomUUID();

    room.players.set(playerId, { name, socketId: socket.id });
    room.scores.set(playerId, 0);
    room.stats.set(playerId, {
      truthsGuessed: 0,
      liesFooledOthers: 0,
      gotFooled: 0,
    });

    socket.join(roomCode);
    socket.data.playerId = playerId;
    socket.data.roomCode = roomCode;

    io.to(roomCode).emit("updatePlayers",
      [...room.players.values()].map(p => p.name)
    );
  });

  /* PLAYER envía pregunta */
  socket.on("submitQuestion", ({ question, answer }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (question.length < 10 || answer.length < 3) return;

    room.questions.set(socket.data.playerId, { question, answer });

    io.to(room.hostSocket).emit("questionsProgress", {
      submitted: room.questions.size,
      total: room.players.size
    });
  });

  /* HOST inicia */
  socket.on("startGame", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.questions.size !== room.players.size) return;

    room.playerOrder = shuffle([...room.players.keys()]);
    room.currentRoundIndex = 0;

    startRound(roomCode);
  });

  /* Mentiras */
  socket.on("submitLie", (lie) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId === room.currentAsker) return;
    room.lies.set(socket.data.playerId, lie);
  });

  /* Votos */
  socket.on("submitVote", (voteId) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId === room.currentAsker) return;
    room.votes.set(socket.data.playerId, voteId);
  });

});

/* ---------------- GAME FLOW ---------------- */

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

  io.to(roomCode).emit("tvQuestion", question);
  io.to(roomCode).emit("playerWrite", { askerId });

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

  io.to(roomCode).emit("playerVote", {
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

  io.to(roomCode).emit("tvResults", {
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

  io.to(roomCode).emit("tvFinal", ranking);
}

server.listen(PORT, () =>
  console.log(`Servidor corriendo en puerto ${PORT}`)
);
