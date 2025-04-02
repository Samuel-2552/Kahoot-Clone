$(document).ready(function() {
    // Establish Socket.IO connection
    const socket = io(window.location.origin);
    let playerNickname = null;
    let currentGamePin = null;
    let currentQuestionIndex = null;

    // --- Helper Functions ---
    function showSection(sectionId) {
        $('#join-section, #waiting-section, #question-section, #player-game-over-section').hide();
        $('#' + sectionId).show();
    }

    function displayStatus(message) {
        $('#player-status').text(message).show().delay(3000).fadeOut();
        $('#player-error').hide();
    }

     function displayError(message) {
        $('#player-error').text(message).show();
        $('#player-status').hide();
    }

    function resetPlayerState() {
        playerNickname = null;
        currentGamePin = null;
        currentQuestionIndex = null;
        $('#score-value').text('0');
        $('#final-score').text('0');
        $('#player-options').empty();
        $('#answer-feedback').hide();
        $('#game-pin-input').val(''); // Clear input fields
        $('#nickname-input').val('');
        showSection('join-section');
    }

    // --- Socket Event Handlers ---
    socket.on('connect', () => {
        console.log('Connected to server (Player)');
        // If user refreshed, they might have lost state, show join form
        if (!playerNickname) {
             // Keep prefilled PIN if it exists from URL
            const prefillPin = $('#game-pin-input').val();
            resetPlayerState();
            if(prefillPin) $('#game-pin-input').val(prefillPin);
        }
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        displayError('Connection lost. Please rejoin if the game is still active.');
        resetPlayerState(); // Go back to join screen on disconnect
    });

    socket.on('join_error', (data) => {
        $('#join-error').text(data.message).show();
    });

    socket.on('joined_successfully', (data) => {
        playerNickname = data.nickname;
        currentGamePin = $('#game-pin-input').val(); // Store the pin used to join
        $('#player-nickname').text(playerNickname);
        $('#join-error').hide();
        showSection('waiting-section');
        displayStatus('Joined game! Waiting for host...');
    });

    socket.on('display_question', (data) => {
        currentQuestionIndex = data.question_index;
        $('#player-question-number').text(`Question ${data.question_index + 1}/${data.question_total}`);
        $('#player-question-text').text(data.question_text);
        $('#answer-feedback').hide().removeClass('text-success text-danger'); // Reset feedback

        const optionsContainer = $('#player-options');
        optionsContainer.empty(); // Clear previous options
        data.options.forEach((option, index) => {
            const button = $(`<button class="btn btn-primary option-button" data-index="${index}">${option}</button>`);
            optionsContainer.append(button);
        });

        showSection('question-section');
        // Enable buttons
        $('.option-button').prop('disabled', false);
    });

     socket.on('answer_received', (data) => {
        if (data.question_index === currentQuestionIndex) {
            displayStatus('Answer submitted! Waiting for results...');
            // Disable buttons after answering
            $('.option-button').prop('disabled', true);
        }
    });

     socket.on('answer_error', (data) => {
         displayError(data.message);
     });

    socket.on('show_round_results', (data) => {
         const myResult = data.player_results ? data.player_results[socket.id] : null; // Get result for this specific player
         const feedbackDiv = $('#answer-feedback');
         const correctIndex = data.correct_answer;

         // Highlight correct/incorrect answers visually
         $('.option-button').each(function() {
             const buttonIndex = $(this).data('index');
             if (buttonIndex === correctIndex) {
                 $(this).addClass('correct-answer').removeClass('btn-primary').addClass('btn-success');
             }
             // If player answered and was wrong, highlight their wrong choice
             if (myResult && !myResult.correct && buttonIndex === parseInt($(this).data('answered-index'))) { // Ensure we stored which button was clicked
                 $(this).addClass('incorrect-answer');
             }
             $(this).prop('disabled', true); // Keep disabled
         });


         if (myResult) {
            if (myResult.correct) {
                feedbackDiv.text(`Correct! +${myResult.score_added} points`).removeClass('text-danger').addClass('text-success').show();
            } else {
                feedbackDiv.text('Incorrect!').removeClass('text-success').addClass('text-danger').show();
            }
            // Update score display immediately
             let currentScore = parseInt($('#score-value').text());
             $('#score-value').text(currentScore + myResult.score_added);
         } else {
             // Player didn't answer in time or joined late
             feedbackDiv.text('Results are in!').removeClass('text-success text-danger').addClass('text-info').show();
         }

         // Optionally show rank from leaderboard:
         // const myRank = data.leaderboard.findIndex(p => p.nickname === playerNickname) + 1;
         // if (myRank > 0) displayStatus(`Your rank: ${myRank}`);
    });


    socket.on('game_over', (data) => {
        // Update final score display
        const finalScore = $('#score-value').text(); // Get score from the last update
        $('#final-score').text(finalScore);
        showSection('player-game-over-section');
        displayStatus('The game has ended!');
        currentGamePin = null; // Reset game pin
        currentQuestionIndex = null;
    });

     socket.on('game_closed', (data) => {
        displayError(data.message || 'The host closed the game.');
        resetPlayerState();
    });

    // --- UI Event Handlers ---
    $('#join-form').on('submit', function(e) {
        e.preventDefault();
        const pin = $('#game-pin-input').val().trim();
        const nickname = $('#nickname-input').val().trim();

        if (pin && nickname) {
             $('#join-error').hide();
            socket.emit('join_game', { pin: pin, nickname: nickname });
        } else {
            $('#join-error').text('Please enter both PIN and Nickname.').show();
        }
    });

    // Use event delegation for dynamically added option buttons
    $('#player-options').on('click', '.option-button', function() {
        const answerIndex = $(this).data('index');
        console.log(`Player ${playerNickname} submitting answer ${answerIndex} for question ${currentQuestionIndex}`);

        // Store which button was clicked locally for potential highlighting later
        $(this).data('answered-index', answerIndex);

        socket.emit('submit_answer', {
            pin: currentGamePin,
            question_index: currentQuestionIndex,
            answer_index: answerIndex
        });

        // Optionally provide immediate visual feedback (e.g., slight style change)
        $(this).addClass('active'); // Mark as selected visually (optional)
         // Disable all buttons immediately after one is clicked
        $('.option-button').prop('disabled', true);
    });

});