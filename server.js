// ========================================
// CLUEDO ONLINE - Server Backend v2.0
// ========================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ========================================
// DATI DEL GIOCO
// ========================================

const SUSPECTS = [
    'Miss Scarlett', 'Col. Mustard', 'Mrs. White',
    'Rev. Green', 'Mrs. Peacock', 'Prof. Plum'
];

const WEAPONS = [
    '🕯️ Candeliere', '🔪 Pugnale', '🔧 Tubo',
    '🔫 Revolver', '🪢 Corda', '🔨 Chiave inglese'
];

const ROOMS = [
    'Sala da ballo', 'Sala biliardo', 'Biblioteca',
    'Sala da pranzo', 'Sala', 'Salotto',
    'Cucina', 'Studio', 'Serra'
];

// Stanze attive
const gameRooms = new Map();

// ========================================
// UTILITY FUNCTIONS
// ========================================

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function createDeck() {
    // Crea soluzione segreta
    const solution = {
        suspect: SUSPECTS[Math.floor(Math.random() * SUSPECTS.length)],
        weapon: WEAPONS[Math.floor(Math.random() * WEAPONS.length)],
        room: ROOMS[Math.floor(Math.random() * ROOMS.length)]
    };
    
    // Carte rimanenti
    const remainingCards = [
        ...SUSPECTS.filter(s => s !== solution.suspect),
        ...WEAPONS.filter(w => w !== solution.weapon),
        ...ROOMS.filter(r => r !== solution.room)
    ];
    
    return { solution, remainingCards: shuffleArray(remainingCards) };
}

function distributeCards(cards, numPlayers) {
    const hands = Array(numPlayers).fill(null).map(() => []);
    cards.forEach((card, index) => {
        hands[index % numPlayers].push(card);
    });
    return hands;
}

// ========================================
// SOCKET.IO HANDLERS
// ========================================

io.on('connection', (socket) => {
    console.log(`✅ Utente connesso: ${socket.id}`);
    
    // ========================================
    // LOBBY
    // ========================================
    
    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        const room = {
            code: roomCode,
            host: socket.id,
            players: [{
                id: socket.id,
                name: data.name,
                character: data.character,
                ready: false,
                position: { x: 0, y: 0, z: 0 },
                currentRoom: null,
                cards: [],
                active: true,
                diceRoll: null,
                movesRemaining: 0
            }],
            gameStarted: false,
            solution: null,
            currentTurnIndex: 0,
            deck: null
        };
        
        gameRooms.set(roomCode, room);
        socket.join(roomCode);
        
        socket.emit('roomCreated', { roomCode });
        console.log(`🎮 Stanza creata: ${roomCode} da ${data.name}`);
    });
    
    socket.on('joinRoom', (data) => {
        const room = gameRooms.get(data.roomCode);
        
        if (!room) {
            socket.emit('error', { message: 'Stanza non trovata' });
            return;
        }
        
        if (room.gameStarted) {
            socket.emit('error', { message: 'Partita già iniziata' });
            return;
        }
        
        if (room.players.length >= 6) {
            socket.emit('error', { message: 'Stanza piena' });
            return;
        }
        
        // Verifica personaggio non già scelto
        const characterTaken = room.players.some(p => p.character === data.character);
        if (characterTaken) {
            socket.emit('error', { message: 'Personaggio già scelto da un altro giocatore' });
            return;
        }
        
        const player = {
            id: socket.id,
            name: data.name,
            character: data.character,
            ready: false,
            position: { x: 0, y: 0, z: 0 },
            currentRoom: null,
            cards: [],
            active: true,
            diceRoll: null,
            movesRemaining: 0
        };
        
        room.players.push(player);
        socket.join(data.roomCode);
        
        socket.emit('roomJoined', { roomCode: data.roomCode, players: room.players });
        socket.to(data.roomCode).emit('playerJoined', {
            playerName: data.name,
            players: room.players
        });
        
        console.log(`👤 ${data.name} è entrato in ${data.roomCode}`);
    });
    
    socket.on('playerReady', (data) => {
        const room = gameRooms.get(data.roomCode);
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = true;
            
            io.to(data.roomCode).emit('playerJoined', {
                playerName: player.name,
                players: room.players
            });
            
            // Se tutti pronti e almeno 2 giocatori, inizia partita
            const allReady = room.players.every(p => p.ready);
            if (allReady && room.players.length >= 2) {
                startGame(data.roomCode);
            }
        }
    });
    
    socket.on('leaveRoom', (data) => {
        const room = gameRooms.get(data.roomCode);
        if (!room) return;
        
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            const player = room.players[playerIndex];
            room.players.splice(playerIndex, 1);
            socket.leave(data.roomCode);
            
            socket.to(data.roomCode).emit('playerLeft', {
                playerName: player.name,
                players: room.players
            });
            
            // Se nessuno rimane, elimina stanza
            if (room.players.length === 0) {
                gameRooms.delete(data.roomCode);
                console.log(`🗑️ Stanza ${data.roomCode} eliminata`);
            }
        }
    });
    
    // ========================================
    // GAME LOGIC
    // ========================================
    
    function startGame(roomCode) {
        const room = gameRooms.get(roomCode);
        if (!room) return;
        
        console.log(`🎮 Partita iniziata in ${roomCode}`);
        
        // Crea mazzo e soluzione
        const { solution, remainingCards } = createDeck();
        room.solution = solution;
        
        // Distribuisci carte
        const hands = distributeCards(remainingCards, room.players.length);
        room.players.forEach((player, index) => {
            player.cards = hands[index];
        });
        
        room.gameStarted = true;
        room.currentTurnIndex = 0;
        
        // Invia dati iniziali a ogni giocatore
        room.players.forEach(player => {
            io.to(player.id).emit('gameStart', {
                cards: player.cards,
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    character: p.character
                }))
            });
        });
        
        // Inizia primo turno
        setTimeout(() => startTurn(roomCode), 2000);
    }
    
    function startTurn(roomCode) {
        const room = gameRooms.get(roomCode);
        if (!room) return;
        
        // Salta giocatori eliminati
        while (!room.players[room.currentTurnIndex].active) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        }
        
        const currentPlayer = room.players[room.currentTurnIndex];
        
        io.to(roomCode).emit('turnStart', {
            playerId: currentPlayer.id,
            playerName: currentPlayer.name
        });
        
        console.log(`🎲 Turno di ${currentPlayer.name} in ${roomCode}`);
    }
    
    socket.on('rollDice', (data) => {
        const room = gameRooms.get(data.roomCode);
        if (!room) return;
        
        const currentPlayer = room.players[room.currentTurnIndex];
        if (currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Non è il tuo turno' });
            return;
        }
        
        if (currentPlayer.diceRoll) {
            socket.emit('error', { message: 'Hai già tirato il dado' });
            return;
        }
        
        const diceResult = Math.floor(Math.random() * 6) + 1;
        currentPlayer.diceRoll = diceResult;
        currentPlayer.movesRemaining = diceResult;
        
        io.to(data.roomCode).emit('diceRolled', {
            playerId: socket.id,
            playerName: currentPlayer.name,
            result: diceResult
        });
        
        console.log(`🎲 ${currentPlayer.name} ha tirato: ${diceResult}`);
    });
    
    socket.on('movePlayer', (data) => {
        const room = gameRooms.get(data.roomCode);
        if (!room) return;
        
        const currentPlayer = room.players[room.currentTurnIndex];
        if (currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Non è il tuo turno' });
            return;
        }
        
        if (!currentPlayer.diceRoll) {
            socket.emit('error', { message: 'Devi prima tirare il dado' });
            return;
        }
        
        // Calcola distanza
        const distance = calculateDistance(currentPlayer.position, data.newPosition);
        const moveCost = Math.ceil(distance / 5);
        
        if (moveCost > currentPlayer.movesRemaining) {
            socket.emit('error', { message: 'Non hai abbastanza movimento' });
            return;
        }
        
        currentPlayer.position = data.newPosition;
        currentPlayer.currentRoom = data.roomId;
        currentPlayer.movesRemaining = 0;
        
        const roomName = ROOMS.find(r => r === data.roomId) || data.roomId;
        
        io.to(data.roomCode).emit('playerMoved', {
            playerId: socket.id,
            playerName: currentPlayer.name,
            newPosition: data.newPosition,
            roomId: data.roomId,
            roomName: roomName
        });
        
        console.log(`🚶 ${currentPlayer.name} si è mosso in ${roomName}`);
    });
    
    socket.on('makeHypothesis', (data) => {
        const room = gameRooms.get(data.roomCode);
        if (!room) return;
        
        const currentPlayer = room.players[room.currentTurnIndex];
        if (currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Non è il tuo turno' });
            return;
        }
        
        if (!currentPlayer.currentRoom) {
            socket.emit('error', { message: 'Devi essere in una stanza' });
            return;
        }
        
        io.to(data.roomCode).emit('hypothesisMade', {
            playerName: currentPlayer.name,
            suspect: data.suspect,
            weapon: data.weapon,
            room: data.room
        });
        
        console.log(`🔍 Ipotesi di ${currentPlayer.name}: ${data.suspect}, ${data.weapon}, ${data.room}`);
        
        // Verifica confutazione
        const hypothesis = [data.suspect, data.weapon, data.room];
        let refuted = false;
        
        // Controlla giocatori in senso orario
        for (let i = 1; i < room.players.length; i++) {
            const nextIndex = (room.currentTurnIndex + i) % room.players.length;
            const player = room.players[nextIndex];
            
            if (!player.active) continue;
            
            const matchingCards = player.cards.filter(card => hypothesis.includes(card));
            
            if (matchingCards.length > 0) {
                const cardToShow = matchingCards[0];
                
                io.to(data.roomCode).emit('hypothesisRefuted', {
                    refuterName: player.name
                });
                
                io.to(socket.id).emit('cardShown', {
                    from: player.name,
                    to: socket.id,
                    card: cardToShow
                });
                
                console.log(`❌ ${player.name} ha confutato con: ${cardToShow}`);
                
                refuted = true;
                break;
            }
        }
        
        if (!refuted) {
            io.to(data.roomCode).emit('hypothesisNotRefuted');
            console.log(`✅ Nessuno ha confutato l'ipotesi`);
        }
        
        // Passa al prossimo turno
        endTurn(data.roomCode);
    });
    
    socket.on('makeAccusation', (data) => {
        const room = gameRooms.get(data.roomCode);
        if (!room) return;
        
        const currentPlayer = room.players[room.currentTurnIndex];
        if (currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Non è il tuo turno' });
            return;
        }
        
        const correct = (
            data.suspect === room.solution.suspect &&
            data.weapon === room.solution.weapon &&
            data.room === room.solution.room
        );
        
        if (correct) {
            io.to(data.roomCode).emit('accusationMade', {
                playerId: socket.id,
                playerName: currentPlayer.name,
                suspect: data.suspect,
                weapon: data.weapon,
                room: data.room,
                correct: true
            });
            
            io.to(data.roomCode).emit('gameOver', {
                winner: currentPlayer.name,
                solution: room.solution
            });
            
            console.log(`🎉 ${currentPlayer.name} ha vinto!`);
            
            // Elimina stanza dopo 30 secondi
            setTimeout(() => {
                gameRooms.delete(data.roomCode);
                console.log(`🗑️ Stanza ${data.roomCode} eliminata`);
            }, 30000);
            
        } else {
            currentPlayer.active = false;
            
            io.to(data.roomCode).emit('accusationMade', {
                playerId: socket.id,
                playerName: currentPlayer.name,
                suspect: data.suspect,
                weapon: data.weapon,
                room: data.room,
                correct: false
            });
            
            console.log(`❌ ${currentPlayer.name} eliminato per accusa sbagliata`);
            
            // Controlla se rimane solo un giocatore
            const activePlayers = room.players.filter(p => p.active);
            if (activePlayers.length === 1) {
                io.to(data.roomCode).emit('gameOver', {
                    winner: activePlayers[0].name,
                    solution: room.solution
                });
                
                setTimeout(() => {
                    gameRooms.delete(data.roomCode);
                }, 30000);
                
            } else {
                endTurn(data.roomCode);
            }
        }
    });
    
    function endTurn(roomCode) {
        const room = gameRooms.get(roomCode);
        if (!room) return;
        
        // Reset stato turno corrente
        const currentPlayer = room.players[room.currentTurnIndex];
        currentPlayer.diceRoll = null;
        currentPlayer.movesRemaining = 0;
        
        // Passa al prossimo giocatore
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        
        setTimeout(() => startTurn(roomCode), 2000);
    }
    
    function calculateDistance(pos1, pos2) {
        const dx = pos2.x - pos1.x;
        const dz = pos2.z - pos1.z;
        return Math.sqrt(dx * dx + dz * dz);
    }
    
    // ========================================
    // DISCONNECT
    // ========================================
    
    socket.on('disconnect', () => {
        console.log(`❌ Utente disconnesso: ${socket.id}`);
        
        // Rimuovi da tutte le stanze
        gameRooms.forEach((room, roomCode) => {
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                
                io.to(roomCode).emit('playerLeft', {
                    playerName: player.name,
                    players: room.players
                });
                
                if (room.players.length === 0) {
                    gameRooms.delete(roomCode);
                    console.log(`🗑️ Stanza ${roomCode} eliminata`);
                }
            }
        });
    });
});

// ========================================
// SERVER START
// ========================================

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║   🕵️  CLUEDO ONLINE SERVER v2.0      ║
╠═══════════════════════════════════════╣
║   Server running on port ${PORT}       ║
║   Ready for connections!              ║
╚═══════════════════════════════════════╝
    `);
});
