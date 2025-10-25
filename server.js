const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']  // ← AGGIUNGI QUESTA
});
// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const gameRooms = new Map();

class CluedoGameServer {
  constructor(roomId, maxPlayers = 6) {
    this.roomId = roomId;
    this.maxPlayers = maxPlayers;
    this.players = [];
    this.solution = null;
    this.currentPlayerIndex = 0;
    this.gameStarted = false;
    this.gameOver = false;
    this.winner = null;
    
    this.SUSPECTS = [
      { id: 'scarlett', name: 'Miss Scarlett', color: '#DC143C' },
      { id: 'mustard', name: 'Col. Mustard', color: '#FFD700' },
      { id: 'white', name: 'Mrs. White', color: '#FFFFFF' },
      { id: 'green', name: 'Rev. Green', color: '#228B22' },
      { id: 'peacock', name: 'Mrs. Peacock', color: '#4169E1' },
      { id: 'plum', name: 'Prof. Plum', color: '#8B008B' }
    ];

    this.WEAPONS = [
      { id: 'candlestick', name: 'Candeliere', icon: '🕯️' },
      { id: 'knife', name: 'Pugnale', icon: '🔪' },
      { id: 'pipe', name: 'Tubo', icon: '🔧' },
      { id: 'revolver', name: 'Revolver', icon: '🔫' },
      { id: 'rope', name: 'Corda', icon: '🪢' },
      { id: 'wrench', name: 'Chiave inglese', icon: '🔨' }
    ];

    this.ROOMS = [
      { id: 'kitchen', name: 'Cucina', position: [-3, 0, 3], color: '#FF6347' },
      { id: 'ballroom', name: 'Sala da ballo', position: [0, 0, 3], color: '#FFD700' },
      { id: 'conservatory', name: 'Serra', position: [3, 0, 3], color: '#32CD32' },
      { id: 'dining', name: 'Sala da pranzo', position: [-3, 0, 0], color: '#DC143C' },
      { id: 'billiard', name: 'Sala biliardo', position: [3, 0, 0], color: '#2E8B57' },
      { id: 'library', name: 'Biblioteca', position: [-3, 0, -3], color: '#8B4513' },
      { id: 'lounge', name: 'Salotto', position: [0, 0, -3], color: '#8B008B' },
      { id: 'hall', name: 'Sala', position: [3, 0, -3], color: '#4169E1' },
      { id: 'study', name: 'Studio', position: [0, 0, 0], color: '#696969' }
    ];
  }

  addPlayer(socketId, playerName) {
    if (this.players.length >= this.maxPlayers) {
      return { success: false, message: 'Stanza piena' };
    }

    if (this.gameStarted) {
      return { success: false, message: 'Partita già iniziata' };
    }

    const player = {
      id: socketId,
      name: playerName,
      character: this.SUSPECTS[this.players.length],
      cards: [],
      position: this.ROOMS[this.players.length % this.ROOMS.length],
      eliminated: false,
      isReady: false
    };

    this.players.push(player);
    return { success: true, player };
  }

  removePlayer(socketId) {
    const index = this.players.findIndex(p => p.id === socketId);
    if (index !== -1) {
      this.players.splice(index, 1);
      
      // Se il gioco era iniziato e rimangono meno di 2 giocatori, termina
      if (this.gameStarted && this.players.length < 2) {
        this.gameOver = true;
        if (this.players.length === 1) {
          this.winner = this.players[0];
        }
      }
    }
  }

  setPlayerReady(socketId, ready) {
    const player = this.players.find(p => p.id === socketId);
    if (player) {
      player.isReady = ready;
    }
  }

  canStartGame() {
    return this.players.length >= 2 && 
           this.players.every(p => p.isReady) && 
           !this.gameStarted;
  }

  startGame() {
    if (!this.canStartGame()) {
      return { success: false, message: 'Non tutti i giocatori sono pronti' };
    }

    // Crea soluzione
    this.solution = {
      suspect: this.SUSPECTS[Math.floor(Math.random() * this.SUSPECTS.length)],
      weapon: this.WEAPONS[Math.floor(Math.random() * this.WEAPONS.length)],
      room: this.ROOMS[Math.floor(Math.random() * this.ROOMS.length)]
    };

    // Crea mazzo
    const deck = [
      ...this.SUSPECTS.filter(s => s.id !== this.solution.suspect.id),
      ...this.WEAPONS.filter(w => w.id !== this.solution.weapon.id),
      ...this.ROOMS.filter(r => r.id !== this.solution.room.id)
    ];

    // Mescola
    this.shuffle(deck);

    // Distribuisci carte
    deck.forEach((card, index) => {
      const playerIndex = index % this.players.length;
      this.players[playerIndex].cards.push(card);
    });

    this.gameStarted = true;
    this.currentPlayerIndex = 0;

    return { success: true };
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  moveToRoom(socketId, roomId) {
    const player = this.players.find(p => p.id === socketId);
    const room = this.ROOMS.find(r => r.id === roomId);
    
    if (player && room && player.id === this.getCurrentPlayer().id) {
      player.position = room;
      return { success: true, room };
    }
    
    return { success: false, message: 'Non è il tuo turno o stanza non valida' };
  }

  makeSuggestion(socketId, suspect, weapon, room) {
    const currentPlayer = this.getCurrentPlayer();
    
    if (socketId !== currentPlayer.id) {
      return { success: false, message: 'Non è il tuo turno' };
    }

    // Controlla confutazioni
    for (let i = 1; i < this.players.length; i++) {
      const playerIndex = (this.currentPlayerIndex + i) % this.players.length;
      const player = this.players[playerIndex];
      
      if (player.eliminated) continue;

      const refutingCards = player.cards.filter(card => 
        card.id === suspect.id || card.id === weapon.id || card.id === room.id
      );

      if (refutingCards.length > 0) {
        const cardToShow = refutingCards[Math.floor(Math.random() * refutingCards.length)];
        return {
          success: true,
          refuted: true,
          player: { id: player.id, name: player.name },
          card: cardToShow
        };
      }
    }

    return { success: true, refuted: false };
  }

  makeAccusation(socketId, suspect, weapon, room) {
    const currentPlayer = this.getCurrentPlayer();
    
    if (socketId !== currentPlayer.id) {
      return { success: false, message: 'Non è il tuo turno' };
    }

    const correct = 
      suspect.id === this.solution.suspect.id &&
      weapon.id === this.solution.weapon.id &&
      room.id === this.solution.room.id;

    if (correct) {
      this.gameOver = true;
      this.winner = currentPlayer;
    } else {
      currentPlayer.eliminated = true;
      
      const activePlayers = this.players.filter(p => !p.eliminated);
      if (activePlayers.length === 1) {
        this.gameOver = true;
        this.winner = activePlayers[0];
      }
    }

    return { success: true, correct, gameOver: this.gameOver, winner: this.winner };
  }

  nextTurn() {
    do {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    } while (this.getCurrentPlayer().eliminated && !this.gameOver);
    
    return this.getCurrentPlayer();
  }

  getGameState() {
    return {
      roomId: this.roomId,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        character: p.character,
        position: p.position,
        eliminated: p.eliminated,
        isReady: p.isReady,
        cardCount: p.cards.length
      })),
      currentPlayerIndex: this.currentPlayerIndex,
      gameStarted: this.gameStarted,
      gameOver: this.gameOver,
      winner: this.winner,
      solution: this.gameOver ? this.solution : null
    };
  }

  getPlayerCards(socketId) {
    const player = this.players.find(p => p.id === socketId);
    return player ? player.cards : [];
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Nuovo giocatore connesso:', socket.id);

  socket.on('createRoom', (data) => {
    const roomId = generateRoomId();
    const game = new CluedoGameServer(roomId, data.maxPlayers || 6);
    gameRooms.set(roomId, game);
    
    const result = game.addPlayer(socket.id, data.playerName);
    
    if (result.success) {
      socket.join(roomId);
      socket.emit('roomCreated', { roomId, player: result.player });
      io.to(roomId).emit('gameStateUpdate', game.getGameState());
    }
  });

  socket.on('joinRoom', (data) => {
    const game = gameRooms.get(data.roomId);
    
    if (!game) {
      socket.emit('error', { message: 'Stanza non trovata' });
      return;
    }

    const result = game.addPlayer(socket.id, data.playerName);
    
    if (result.success) {
      socket.join(data.roomId);
      socket.emit('roomJoined', { 
        roomId: data.roomId, 
        player: result.player,
        cards: game.getPlayerCards(socket.id)
      });
      io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
      io.to(data.roomId).emit('playerJoined', { player: result.player });
    } else {
      socket.emit('error', { message: result.message });
    }
  });

  // NUOVO: Evento per riconnessione
  socket.on('rejoinRoom', (data) => {
    const game = gameRooms.get(data.roomId);
    
    if (!game) {
      socket.emit('error', { message: 'Stanza non trovata' });
      return;
    }

    // Trova giocatore disconnesso con stesso nome
    const player = game.players.find(
      p => p.name === data.playerName && p.disconnected
    );

    if (player) {
      // Riconnetti giocatore
      player.id = socket.id;
      player.disconnected = false;
      delete player.disconnectedAt;
      
      socket.join(data.roomId);
      socket.emit('roomJoined', { 
        roomId: data.roomId, 
        player: player,
        cards: game.getPlayerCards(socket.id)
      });
      
      io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
      io.to(data.roomId).emit('playerRejoined', { 
        player: { id: player.id, name: player.name }
      });
      
      console.log(`✅ Giocatore ${data.playerName} riconnesso a ${data.roomId}`);
    } else {
      // Giocatore non trovato, prova join normale
      const result = game.addPlayer(socket.id, data.playerName);
      
      if (result.success) {
        socket.join(data.roomId);
        socket.emit('roomJoined', { 
          roomId: data.roomId, 
          player: result.player,
          cards: game.getPlayerCards(socket.id)
        });
        io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
        io.to(data.roomId).emit('playerJoined', { player: result.player });
      } else {
        socket.emit('error', { message: 'Non puoi entrare in questa stanza' });
      }
    }
  });

  // NUOVO: Verifica esistenza stanza
  socket.on('checkRoom', (data) => {
    const game = gameRooms.get(data.roomId);
    socket.emit('roomExists', { 
      exists: game ? true : false 
    });
  });

  socket.on('setReady', (data) => {
    const game = gameRooms.get(data.roomId);
    if (game) {
      game.setPlayerReady(socket.id, data.ready);
      io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
      
      if (game.canStartGame()) {
        io.to(data.roomId).emit('canStartGame', true);
      }
    }
  });

  socket.on('startGame', (data) => {
    const game = gameRooms.get(data.roomId);
    if (game) {
      const result = game.startGame();
      
      if (result.success) {
        // Invia a ogni giocatore le sue carte
        game.players.forEach(player => {
          io.to(player.id).emit('gameStarted', {
            cards: game.getPlayerCards(player.id)
          });
        });
        
        io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
        io.to(data.roomId).emit('turnStart', game.getCurrentPlayer());
      } else {
        socket.emit('error', { message: result.message });
      }
    }
  });

  socket.on('moveToRoom', (data) => {
    const game = gameRooms.get(data.roomId);
    if (game) {
      const result = game.moveToRoom(socket.id, data.targetRoomId);
      
      if (result.success) {
        io.to(data.roomId).emit('playerMoved', {
          playerId: socket.id,
          room: result.room
        });
        io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
      } else {
        socket.emit('error', { message: result.message });
      }
    }
  });

  socket.on('makeSuggestion', (data) => {
    const game = gameRooms.get(data.roomId);
    if (game) {
      const result = game.makeSuggestion(
        socket.id,
        data.suspect,
        data.weapon,
        data.room
      );
      
      if (result.success) {
        if (result.refuted) {
          // Solo il giocatore corrente vede la carta
          socket.emit('suggestionRefuted', {
            player: result.player,
            card: result.card
          });
          
          // Altri vedono solo che è stata confutata
          socket.to(data.roomId).emit('suggestionRefutedPublic', {
            player: result.player
          });
        } else {
          io.to(data.roomId).emit('suggestionNotRefuted');
        }
        
        io.to(data.roomId).emit('gameLog', {
          message: `${game.getCurrentPlayer().name} ha fatto un'ipotesi`,
          type: 'suggestion'
        });
      } else {
        socket.emit('error', { message: result.message });
      }
    }
  });

  socket.on('makeAccusation', (data) => {
    const game = gameRooms.get(data.roomId);
    if (game) {
      const result = game.makeAccusation(
        socket.id,
        data.suspect,
        data.weapon,
        data.room
      );
      
      if (result.success) {
        io.to(data.roomId).emit('accusationMade', {
          player: game.getCurrentPlayer(),
          correct: result.correct,
          gameOver: result.gameOver,
          winner: result.winner
        });
        
        io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
        
        if (result.gameOver) {
          io.to(data.roomId).emit('gameOver', {
            winner: result.winner,
            solution: game.solution
          });
        }
      } else {
        socket.emit('error', { message: result.message });
      }
    }
  });

  socket.on('endTurn', (data) => {
    const game = gameRooms.get(data.roomId);
    if (game) {
      const nextPlayer = game.nextTurn();
      io.to(data.roomId).emit('gameStateUpdate', game.getGameState());
      io.to(data.roomId).emit('turnStart', nextPlayer);
    }
  });

  socket.on('disconnect', () => {
    console.log('Giocatore disconnesso:', socket.id);
    
    // Rimuovi da tutte le stanze con grace period di 2 minuti
    gameRooms.forEach((game, roomId) => {
      const player = game.players.find(p => p.id === socket.id);
      
      if (player) {
        // Marca come disconnesso
        player.disconnected = true;
        player.disconnectedAt = Date.now();
        
        io.to(roomId).emit('playerDisconnected', { 
          playerId: socket.id,
          playerName: player.name 
        });
        
        // Aspetta 2 minuti prima di rimuovere definitivamente
        setTimeout(() => {
          const stillDisconnected = game.players.find(
            p => p.id === socket.id && p.disconnected
          );
          
          if (stillDisconnected) {
            game.removePlayer(socket.id);
            io.to(roomId).emit('playerLeft', { playerId: socket.id });
            io.to(roomId).emit('gameStateUpdate', game.getGameState());
            
            console.log(`Giocatore ${socket.id} rimosso dopo timeout`);
            
            // Se stanza vuota, eliminala
            if (game.players.length === 0) {
              gameRooms.delete(roomId);
              console.log('Stanza eliminata:', roomId);
            }
          }
        }, 120000); // 2 minuti = 120000ms
        
        // Cambia questo valore per modificare durata:
        // 60000 = 1 minuto
        // 180000 = 3 minuti
        // 300000 = 5 minuti
      }
    });
  });
});

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server Cluedo online sulla porta ${PORT}`);
});
