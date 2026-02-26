const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const TOTAL_ROUNDS = 5;
const WRITE_TIME = 40;
const VOTE_TIME = 25;

const questions = [
  { question: "¿Cuál es el nombre real del muñeco del Monopoly?", answer: "Rich Uncle Pennybags" },
  { question: "¿Cuántos corazones tiene un pulpo?", answer: "3" },
  { question: "¿En qué país se inventó el karaoke?", answer: "Japón" },
  { question: "¿Qué animal no puede saltar?", answer: "Elefante" }
];

let rooms = {};

io.on("connection", (socket) => {

  socket.on("createRoom", () => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();

    rooms[roomCode] = {
      players: {},
      scores: {},
      round: 0,
      question: null,
      answer: null,
      lies: {},
      votes: {}
    };

    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players[socket.id] = name;
    room.scores[socket.id] = 0;

    socket.join(roomCode);
    io.to(roomCode).emit("updatePlayers", room.players);
  });

  socket.on("startGame", (roomCode) => {
    startRound(roomCode);
  });

  socket.on("submitLie", ({ roomCode, lie }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.lies[socket.id] = lie;

    if (Object.keys(room.lies).length === Object.keys(room.players).length) {
      startVoting(roomCode);
    }
  });

  socket.on("submitVote", ({ roomCode, vote }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes[socket.id] = vote;

    if (Object.keys(room.votes).length === Object.keys(room.players).length) {
      calculateScores(roomCode);
    }
  });

});

function startRound(roomCode) {
  const room = rooms[roomCode];
  room.round++;

  if (room.round > TOTAL_ROUNDS) {
    io.to(roomCode).emit("gameOver", getScoreboard(room));
    return;
  }

  const randomQ = questions[Math.floor(Math.random() * questions.length)];
  room.question = randomQ.question;
  room.answer = randomQ.answer;
  room.lies = {};
  room.votes = {};

  io.to(roomCode).emit("newRound", {
    round: room.round,
    total: TOTAL_ROUNDS,
    question: room.question,
    writeTime: WRITE_TIME
  });

  setTimeout(() => startVoting(roomCode), WRITE_TIME * 1000);
}

function startVoting(roomCode) {
  const room = rooms[roomCode];

  let options = Object.values(room.lies);
  options.push(room.answer);
  options = options.sort(() => Math.random() - 0.5);

  io.to(roomCode).emit("startVoting", {
    options,
    voteTime: VOTE_TIME
  });

  setTimeout(() => calculateScores(roomCode), VOTE_TIME * 1000);
}

function calculateScores(roomCode) {
  const room = rooms[roomCode];

  let tricked = {};
  let voteDetails = [];

  for (let voter in room.votes) {
    const vote = room.votes[voter];

    voteDetails.push({
      voter: room.players[voter],
      vote: vote
    });

    if (vote === room.answer) {
      room.scores[voter] += 1000;
    } else {
      const liar = Object.keys(room.lies).find(id => room.lies[id] === vote);
      if (liar && liar !== voter) {
        room.scores[liar] += 500;
        if (!tricked[liar]) tricked[liar] = [];
        tricked[liar].push(room.players[voter]);
      }
    }
  }

  io.to(roomCode).emit("roundResults", {
    correct: room.answer,
    tricked,
    voteDetails,
    lies: room.lies,
    scoreboard: getScoreboard(room),
    players: room.players
  });

  setTimeout(() => startRound(roomCode), 8000);
}

function getScoreboard(room) {
  return Object.keys(room.players).map(id => ({
    name: room.players[id],
    score: room.scores[id]
  })).sort((a, b) => b.score - a.score);
}

server.listen(3000, () => console.log("Servidor en puerto 3000"));
