// ========================================
// CLUEPETO - Server Backend (SINGLE ROOM)
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
app.use(express.json());

// Endpoint per resettare la stanza globale
app.post('/api/reset-room', (req, res) => {
    console.log('🔄 Reset stanza globale richiesto...');
    
    gameRoom.players = [];
    gameRoom.solution = null;
    gameRoom.gameStarted = false;
    gameRoom.currentTurnIndex = 0;
    
    // Disconnetti tutti i client
    io.to(GLOBAL_ROOM).disconnectSockets();
    
    console.log('✅ Stanza globale resettata!');
    res.json({ success: true, message: 'Stanza resettata!' });
});

// Endpoint per vedere stato stanza
app.get('/api/room-status', (req, res) => {
    res.json({
        players: gameRoom.players.length,
        gameStarted: gameRoom.gameStarted,
        playerList: gameRoom.players.map(p => ({ name: p.name, character: p.character }))
    });
});

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

// STANZA GLOBALE UNICA
const GLOBAL_ROOM = 'GLOBAL';
const gameRoom = {
    roomCode: GLOBAL_ROOM,
    players: [],
    solution: null,
    gameStarted: false,
    currentTurnIndex: 0
};

console.log(`🌍 Stanza globale GLOBAL creata e pronta!`);

// ========================================
// UTILITY FUNCTIONS
// ========================================

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function createDeck() {
    const solution = {
        suspect: SUSPECTS[Math.floor(Math.random() * SUSPECTS.length)],
        weapon: WEAPONS[Math.floor(Math.random() * WEAPONS.length)],
        room: ROOMS[Math.floor(Math.random() * ROOMS.length)]
    };
    
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
    
    // Entra nella partita globale
    socket.on('joinRoom', (data) => {
        // Controlla se personaggio già preso
        const characterTaken = gameRoom.players.some(p => p.character === data.character);
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
        
        gameRoom.players.push(player);
        socket.join(GLOBAL_ROOM);
        
        socket.emit('roomJoined', { roomCode: GLOBAL_ROOM, players: gameRoom.players });
        socket.to(GLOBAL_ROOM).emit('playerJoined', {
            playerName: data.name,
            players: gameRoom.players
        });
        
        console.log(`👤 ${data.name} è entrato nella partita globale`);
    });
    
    // Giocatore pronto
    socket.on('playerReady', (data) => {
        const player = gameRoom.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = true;
            
            io.to(GLOBAL_ROOM).emit('playerReady', {
                playerName: player.name,
                players: gameRoom.players
            });
            
            // Se tutti pronti e almeno 2 giocatori, inizia partita
            const allReady = gameRoom.players.every(p => p.ready);
            if (allReady && gameRoom.players.length >= 2) {
                startGame();
            }
        }
    });
    
    // Esce dalla partita
    socket.on('leaveRoom', (data) => {
        const playerIndex = gameRoom.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            const player = gameRoom.players[playerIndex];
            gameRoom.players.splice(playerIndex, 1);
            socket.leave(GLOBAL_ROOM);
            
            socket.to(GLOBAL_ROOM).emit('playerLeft', {
                playerName: player.name,
                players: gameRoom.players
            });
            
            console.log(`👋 ${player.name} ha lasciato la partita`);
        }
    });
    
    // ========================================
    // REJOIN ROOM (per multi-pagina)
    // ========================================
    
    socket.on('rejoinRoom', (data) => {
        const player = gameRoom.players.find(p => 
            p.name === data.playerName && p.character === data.playerCharacter
        );
        
        if (!player) {
            socket.emit('error', { message: 'Giocatore non trovato' });
            return;
        }
        
        console.log(`🔄 ${player.name} riconnesso (nuovo socket: ${socket.id})`);
        
        // Aggiorna socket.id
        player.id = socket.id;
        socket.join(GLOBAL_ROOM);
        
        // Invia stato gioco
        if (gameRoom.gameStarted) {
            socket.emit('gameStart', {
                cards: player.cards,
                players: gameRoom.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    character: p.character
                }))
            });
            
            const currentPlayer = gameRoom.players[gameRoom.currentTurnIndex];
            socket.emit('turnStart', {
                playerId: currentPlayer.id,
                playerName: currentPlayer.name
            });
            
            console.log(`✅ Stato inviato a ${player.name}`);
        }
    });
    
    // ========================================
    // GAME LOGIC
    // ========================================
    
    function startGame() {
        console.log(`🎮 Partita iniziata nella stanza globale!`);
        
        // Crea mazzo e soluzione
        const { solution, remainingCards } = createDeck();
        gameRoom.solution = solution;
        
        // Distribuisci carte
        const hands = distributeCards(remainingCards, gameRoom.players.length);
        gameRoom.players.forEach((player, index) => {
            player.cards = hands[index];
        });
        
        gameRoom.gameStarted = true;
        gameRoom.currentTurnIndex = 0;
        
        // Invia dati iniziali a ogni giocatore
        gameRoom.players.forEach(player => {
            io.to(player.id).emit('gameStart', {
                cards: player.cards,
                players: gameRoom.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    character: p.character
                }))
            });
        });
        
        // Inizia primo turno
        setTimeout(() => startTurn(), 2000);
    }
    
    function startTurn() {
        // Salta giocatori eliminati
        while (!gameRoom.players[gameRoom.currentTurnIndex].active) {
            gameRoom.currentTurnIndex = (gameRoom.currentTurnIndex + 1) % gameRoom.players.length;
        }
        
        const currentPlayer = gameRoom.players[gameRoom.currentTurnIndex];
        
        // Reset dado
        currentPlayer.diceRoll = null;
        currentPlayer.movesRemaining = 0;
        
        io.to(GLOBAL_ROOM).emit('turnStart', {
            playerId: currentPlayer.id,
            playerName: currentPlayer.name
        });
        
        console.log(`🎲 Turno di ${currentPlayer.name}`);
    }
    
    // ========================================
    // GAME ACTIONS
    // ========================================
    
    socket.on('rollDice', (data) => {
        const currentPlayer = gameRoom.players[gameRoom.currentTurnIndex];
        
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
        
        io.to(GLOBAL_ROOM).emit('diceRolled', {
            playerId: currentPlayer.id,
            playerName: currentPlayer.name,
            result: diceResult
        });
        
        console.log(`🎲 ${currentPlayer.name} ha tirato ${diceResult}`);
    });
    
    socket.on('move', (data) => {
        const currentPlayer = gameRoom.players[gameRoom.currentTurnIndex];
        
        if (currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Non è il tuo turno' });
            return;
        }
        
        if (currentPlayer.movesRemaining <= 0) {
            socket.emit('error', { message: 'Non hai mosse rimanenti' });
            return;
        }
        
        // Aggiorna posizione
        currentPlayer.currentRoom = data.roomName;
        currentPlayer.position = data.position;
        currentPlayer.movesRemaining = 0; // Per ora 1 mossa = entra in stanza
        
        io.to(GLOBAL_ROOM).emit('playerMoved', {
            playerId: currentPlayer.id,
            playerName: currentPlayer.name,
            roomName: data.roomName,
            position: data.position
        });
        
        console.log(`👣 ${currentPlayer.name} si è mosso in ${data.roomName}`);
    });
    
    socket.on('makeHypothesis', (data) => {
        const currentPlayer = gameRoom.players[gameRoom.currentTurnIndex];
        
        if (currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Non è il tuo turno' });
            return;
        }
        
        if (!currentPlayer.currentRoom) {
            socket.emit('error', { message: 'Devi essere in una stanza per fare un\'ipotesi' });
            return;
        }
        
        console.log(`🔍 ${currentPlayer.name} fa un'ipotesi:`, data);
        
        // Cerca chi ha una carta
        let cardShown = null;
        let showingPlayer = null;
        
        for (let player of gameRoom.players) {
            if (player.id === currentPlayer.id) continue;
            
            const hasCard = player.cards.some(card => 
                card === data.suspect || card === data.weapon || card === currentPlayer.currentRoom
            );
            
            if (hasCard) {
                const matchingCards = player.cards.filter(card =>
                    card === data.suspect || card === data.weapon || card === currentPlayer.currentRoom
                );
                cardShown = matchingCards[0];
                showingPlayer = player;
                break;
            }
        }
        
        if (cardShown) {
            socket.emit('hypothesisResult', {
                success: false,
                cardShown: cardShown,
                shownBy: showingPlayer.name
            });
            
            io.to(GLOBAL_ROOM).emit('hypothesisMade', {
                playerName: currentPlayer.name,
                suspect: data.suspect,
                weapon: data.weapon,
                room: currentPlayer.currentRoom,
                wasDisproven: true
            });
        } else {
            socket.emit('hypothesisResult', {
                success: true,
                message: 'Nessuno ha mostrato una carta!'
            });
            
            io.to(GLOBAL_ROOM).emit('hypothesisMade', {
                playerName: currentPlayer.name,
                suspect: data.suspect,
                weapon: data.weapon,
                room: currentPlayer.currentRoom,
                wasDisproven: false
            });
        }
    });
    
    socket.on('makeAccusation', (data) => {
        const player = gameRoom.players.find(p => p.id === socket.id);
        if (!player) return;
        
        console.log(`⚠️ ${player.name} fa un'accusa:`, data);
        
        const isCorrect = 
            data.suspect === gameRoom.solution.suspect &&
            data.weapon === gameRoom.solution.weapon &&
            data.room === gameRoom.solution.room;
        
        if (isCorrect) {
            io.to(GLOBAL_ROOM).emit('gameOver', {
                winner: player.name,
                solution: gameRoom.solution
            });
            
            console.log(`🎉 ${player.name} ha vinto!`);
            
            // Reset stanza per nuova partita
            setTimeout(() => {
                gameRoom.players = [];
                gameRoom.gameStarted = false;
                gameRoom.currentTurnIndex = 0;
                console.log('🔄 Stanza resettata per nuova partita');
            }, 10000);
        } else {
            player.active = false;
            
            socket.emit('accusationResult', {
                success: false,
                solution: gameRoom.solution
            });
            
            io.to(GLOBAL_ROOM).emit('playerEliminated', {
                playerName: player.name
            });
            
            console.log(`❌ ${player.name} eliminato!`);
            
            // Controlla se rimane solo 1 giocatore
            const activePlayers = gameRoom.players.filter(p => p.active);
            if (activePlayers.length === 1) {
                io.to(GLOBAL_ROOM).emit('gameOver', {
                    winner: activePlayers[0].name,
                    solution: gameRoom.solution,
                    reason: 'Ultimo giocatore rimasto'
                });
            }
        }
    });
    
    socket.on('endTurn', (data) => {
        const currentPlayer = gameRoom.players[gameRoom.currentTurnIndex];
        
        if (currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Non è il tuo turno' });
            return;
        }
        
        // Passa al prossimo giocatore
        gameRoom.currentTurnIndex = (gameRoom.currentTurnIndex + 1) % gameRoom.players.length;
        
        setTimeout(() => startTurn(), 1000);
    });
    
    // (Resto della logica gioco: rollDice, move, hypothesis, accusation, ecc.)
    // Per semplicità, la ometto ma funziona uguale al server originale
    
    socket.on('disconnect', () => {
        console.log(`❌ Utente disconnesso: ${socket.id}`);
    });
});

// ========================================
// SERVER START
// ========================================

server.listen(PORT, () => {
    console.log(`🚀 Server avviato su porta ${PORT}`);
    console.log(`🌍 Stanza globale GLOBAL pronta per i giocatori!`);
});
