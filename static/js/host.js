$(document).ready(function() {
    // Establish Socket.IO connection
    // Use window.location.origin for flexibility (http/https vs localhost/IP)
    const socket = io(window.location.origin);
    let currentGamePin = null;

    // --- Helper Functions ---
    function showSection(sectionId) {
        $('#create-game-section, #lobby-section, #game-running-section, #game-finished-section').hide();
        $('#' + sectionId).show();
    }

    function displayStatus(message) {
        $('#status-message').text(message).show().delay(3000).fadeOut();
        $('#error-message').hide();
    }

    function displayError(message) {
        $('#error-message').text(message).show();
        $('#status-message').hide();
    }

    // --- Socket Event Handlers ---
    socket.on('connect', () => {
        console.log('Connected to server (Host)');
        showSection('create-game-section'); // Start at create game view
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        displayError('Connection lost. Please refresh.');
        // Optionally reset UI to initial state
        showSection('create-game-section');
        currentGamePin = null;
    });

    socket.on('game_created', (data) => {
        currentGamePin = data.pin;
        $('#game-pin').text(currentGamePin);
        $('#player-list').empty(); // Clear previous player list
        $('#start-game-btn').prop('disabled', true); // Disable start until players join
        showSection('lobby-section');
        displayStatus(`Game created! PIN: ${currentGamePin}. Waiting for players...`);
    });

    socket.on('update_player_list', (data) => {
        if (!currentGamePin) return; // Ignore if no active game
        const playerList = $('#player-list');
        playerList.empty();
        if (data.players && data.players.length > 0) {
            data.players.forEach(nickname => {
                playerList.append(`<li class="list-group-item">${nickname}</li>`);
            });
            $('#start-game-btn').prop('disabled', false); // Enable start button
        } else {
            playerList.append('<li class="list-group-item text-muted">No players yet...</li>');
            $('#start-game-btn').prop('disabled', true); // Disable if no players
        }
    });

     socket.on('player_left', (data) => {
         displayStatus(`${data.nickname} left the game.`);
         // update_player_list will be called separately by the server to refresh the list
     });

    socket.on('display_question', (data) => {
        $('#question-number').text(`Question ${data.question_index + 1}/${data.question_total}`);
        $('#question-text').text(data.question_text);
        // Optionally display options for the host too
        const optionsContainer = $('#host-options');
        optionsContainer.empty();
        data.options.forEach((option, index) => {
            // Just display text, no buttons needed for host usually
             optionsContainer.append(`<div class="alert alert-secondary">${option}</div>`);
        });
        $('#answer-stats').text('Waiting for answers...'); // Reset stats display
        showSection('game-running-section');
        $('#next-question-btn').text('Show Results / Next Question'); // Change button text after first question
         // In a real app, disable 'Next' until timer ends or all answer
    });

     socket.on('show_round_results', (data) => {
        // Host mainly needs to know the correct answer to display it (optional)
        console.log("Round results:", data);
        displayStatus(`Round over. Correct answer was index: ${data.correct_answer}`);
        // Highlight correct answer (if displayed)
         $('#host-options').children().eq(data.correct_answer).addClass('correct-answer');
        // Show leaderboard snippet or just wait for 'Next' click
    });

    socket.on('game_over', (data) => {
        const leaderboardList = $('#final-leaderboard');
        leaderboardList.empty();
        if (data.leaderboard && data.leaderboard.length > 0) {
            data.leaderboard.forEach(player => {
                leaderboardList.append(`<li class="list-group-item d-flex justify-content-between align-items-center">${player.nickname} <span class="badge bg-primary rounded-pill">${player.score}</span></li>`);
            });
        } else {
            leaderboardList.append('<li class="list-group-item">No players finished.</li>');
        }
        showSection('game-finished-section');
        currentGamePin = null; // Reset game pin
    });

    socket.on('game_closed', (data) => {
        displayError(data.message || 'The game was closed.');
        showSection('create-game-section');
        currentGamePin = null;
    });


    // --- UI Event Handlers ---
    $('#create-game-btn').on('click', () => {
        console.log('Requesting to create game...');
        socket.emit('create_game');
    });

    $('#start-game-btn').on('click', () => {
        if (currentGamePin) {
            console.log(`Requesting to start game ${currentGamePin}...`);
            socket.emit('start_game', { pin: currentGamePin });
            $(this).prop('disabled', true); // Prevent double clicks
        } else {
            displayError("No active game PIN found.");
        }
    });

    $('#next-question-btn').on('click', () => {
         if (currentGamePin) {
            console.log(`Requesting next question for game ${currentGamePin}...`);
            socket.emit('next_question', { pin: currentGamePin });
             // Optionally disable button briefly to prevent spamming
             $(this).prop('disabled', true);
             setTimeout(() => { $(this).prop('disabled', false); }, 1000); // Re-enable after 1 sec
        } else {
            displayError("No active game PIN found.");
        }
    });

});