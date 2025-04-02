# import eventlet
# eventlet.monkey_patch() # Important for Flask-SocketIO performance and compatibility

from gevent import monkey
monkey.patch_all()

from flask import Flask, render_template, request, session, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room, close_room, rooms, disconnect
import random
import string
# from threading import Lock
from gevent.lock import RLock as Lock

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_very_secret_key_here!' # Change this!
# Consider using Redis or RabbitMQ for production message queues
# socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*") # Allow all origins for simplicity
socketio = SocketIO(app, async_mode='gevent', cors_allowed_origins="*")

# --- Data Structures (In-Memory) ---
games = {} # Store game state { pin: game_data }
thread_lock = Lock() # To protect access to shared 'games' dict

# --- Quiz Data (Simple Example) ---
QUIZ = [
    {
        "question": "What is the capital of France?",
        "options": ["Berlin", "Madrid", "Paris", "Rome"],
        "correct_answer": 2 # Index of the correct option
    },
    {
        "question": "Which planet is known as the Red Planet?",
        "options": ["Earth", "Mars", "Jupiter", "Venus"],
        "correct_answer": 1
    },
    {
        "question": "What is 2 + 2?",
        "options": ["3", "4", "5", "6"],
        "correct_answer": 1
    }
]

# --- Helper Functions ---
def generate_pin(length=5):
    """Generate a unique numeric game PIN."""
    while True:
        pin = ''.join(random.choices(string.digits, k=length))
        if pin not in games:
            return pin

# --- Flask Routes ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/host')
def host_page():
    return render_template('host.html')

@app.route('/play')
def player_page():
    # Allow joining directly via URL like /play?pin=12345 (optional)
    pin = request.args.get('pin', '')
    return render_template('player.html', prefill_pin=pin)

# --- SocketIO Event Handlers ---

@socketio.on('connect')
def handle_connect():
    print(f'Client connected: {request.sid}')

@socketio.on('disconnect')
def handle_disconnect():
    print(f'Client disconnected: {request.sid}')
    # Clean up if the disconnected client was a host or player
    pin_to_remove = None
    player_to_remove = None
    game_pin_of_player = None

    with thread_lock:
        # Check if it was a host
        for pin, game in games.items():
            if game.get('host_sid') == request.sid:
                pin_to_remove = pin
                break
            # Check if it was a player
            if request.sid in game.get('players', {}):
                player_to_remove = request.sid
                game_pin_of_player = pin
                break

        if pin_to_remove:
            print(f"Host {request.sid} disconnected, closing game {pin_to_remove}")
            # Notify players the game is closing (optional)
            socketio.emit('game_closed', {'message': 'Host disconnected, game closed.'}, room=pin_to_remove)
            # Close the socket.io room
            close_room(pin_to_remove)
            del games[pin_to_remove]

        elif player_to_remove and game_pin_of_player:
            print(f"Player {games[game_pin_of_player]['players'][player_to_remove]['nickname']} ({player_to_remove}) disconnected from game {game_pin_of_player}")
            host_sid = games[game_pin_of_player].get('host_sid')
            nickname = games[game_pin_of_player]['players'][player_to_remove]['nickname']

            # Remove player from game data
            del games[game_pin_of_player]['players'][player_to_remove]

            # Notify host
            if host_sid:
                 # Update player list for host
                 player_list = [p['nickname'] for p in games[game_pin_of_player]['players'].values()]
                 socketio.emit('update_player_list', {'players': player_list}, room=host_sid)
                 socketio.emit('player_left', {'nickname': nickname}, room=host_sid)
            # Player automatically leaves the room on disconnect


@socketio.on('create_game')
def handle_create_game():
    """Host creates a new game."""
    with thread_lock:
        pin = generate_pin()
        games[pin] = {
            'host_sid': request.sid,
            'players': {}, # { sid: {'nickname': name, 'score': 0} }
            'quiz': QUIZ, # Use the predefined quiz
            'current_question_index': -1,
            'game_state': 'lobby', # lobby, question, results, finished
            'answers_this_round': {} # { sid: answer_index }
        }
    join_room(pin) # Host joins the room identified by the PIN
    print(f"Game created by {request.sid} with PIN: {pin}")
    emit('game_created', {'pin': pin})


@socketio.on('join_game')
def handle_join_game(data):
    """Player attempts to join a game."""
    pin = data.get('pin')
    nickname = data.get('nickname', 'Anonymous')

    with thread_lock:
        game = games.get(pin)

        if not game:
            emit('join_error', {'message': 'Game PIN not found.'})
            return

        if game['game_state'] != 'lobby':
             emit('join_error', {'message': 'Game has already started.'})
             return

        # Optional: Check if nickname is unique
        # existing_nicknames = [p['nickname'] for p in game['players'].values()]
        # if nickname in existing_nicknames:
        #     emit('join_error', {'message': 'Nickname already taken.'})
        #     return

        # Add player
        game['players'][request.sid] = {'nickname': nickname, 'score': 0}
        join_room(pin) # Player joins the room
        print(f"Player {nickname} ({request.sid}) joined game {pin}")

        # Notify player of successful join
        emit('joined_successfully', {'nickname': nickname})

        # Notify host about the new player
        host_sid = game['host_sid']
        player_list = [p['nickname'] for p in game['players'].values()]
        socketio.emit('update_player_list', {'players': player_list}, room=host_sid)


@socketio.on('start_game')
def handle_start_game(data):
    """Host starts the game."""
    pin = data.get('pin')
    with thread_lock:
        game = games.get(pin)
        if not game or game['host_sid'] != request.sid:
            print(f"Unauthorized start attempt or game not found for pin {pin}")
            return # Or emit error

        if game['game_state'] != 'lobby':
            print(f"Game {pin} already started or finished.")
            return

        print(f"Starting game {pin}")
        game['game_state'] = 'question'
        game['current_question_index'] = -1 # Will be incremented by next_question

    # Trigger the first question
    handle_next_question({'pin': pin})


@socketio.on('next_question')
def handle_next_question(data):
    """Host requests the next question (or starts the first)."""
    pin = data.get('pin')

    with thread_lock:
        game = games.get(pin)
        if not game or game['host_sid'] != request.sid:
            return # Error: only host can advance

        # --- (Optional) Show Results/Leaderboard before next question ---
        # If not the first question, calculate and show results first
        if game['current_question_index'] >= 0:
            # Calculate scores for the round just ended
            correct_answer_index = game['quiz'][game['current_question_index']]['correct_answer']
            round_results = {} # { sid: {'correct': bool, 'score_added': int} }
            for sid, answer_index in game['answers_this_round'].items():
                is_correct = (answer_index == correct_answer_index)
                score_added = 100 if is_correct else 0 # Simple scoring
                game['players'][sid]['score'] += score_added
                round_results[sid] = {'correct': is_correct, 'score_added': score_added}

            # Prepare overall scores (leaderboard data)
            leaderboard = sorted(
                [{'nickname': p['nickname'], 'score': p['score']} for p in game['players'].values()],
                key=lambda x: x['score'],
                reverse=True
            )

            # Emit results to everyone
            socketio.emit('show_round_results', {
                'correct_answer': correct_answer_index,
                'player_results': round_results, # Tell each player if they were right
                'leaderboard': leaderboard # Send full leaderboard (or top N)
            }, room=pin)

            # Pause before showing next question (optional)
            socketio.sleep(5) # Pause for 5 seconds to show results

        # --- Advance to the next question ---
        game['current_question_index'] += 1
        q_index = game['current_question_index']

        if q_index >= len(game['quiz']):
            # Game Over
            game['game_state'] = 'finished'
            print(f"Game {pin} finished.")
            # Send final leaderboard again
            leaderboard = sorted(
                [{'nickname': p['nickname'], 'score': p['score']} for p in game['players'].values()],
                key=lambda x: x['score'],
                reverse=True
            )
            socketio.emit('game_over', {'leaderboard': leaderboard}, room=pin)
            # Consider cleaning up the game room after a delay
            # close_room(pin)
            # del games[pin]
            return

        # Prepare next question data
        question_data = game['quiz'][q_index]
        payload = {
            'question_index': q_index,
            'question_text': question_data['question'],
            'options': question_data['options'],
            'question_total': len(game['quiz'])
            # 'time_limit': 20 # Add time limit if needed
        }
        game['game_state'] = 'question'
        game['answers_this_round'] = {} # Reset answers for the new round

    # Emit the question to everyone in the room
    print(f"Sending question {q_index + 1} for game {pin}")
    socketio.emit('display_question', payload, room=pin)


@socketio.on('submit_answer')
def handle_submit_answer(data):
    """Player submits an answer."""
    pin = data.get('pin')
    answer_index = data.get('answer_index')
    q_index = data.get('question_index') # Ensure answer is for the current question

    with thread_lock:
        game = games.get(pin)
        if not game:
            print(f"Answer submitted for non-existent game {pin}")
            return

        player_sid = request.sid
        if player_sid not in game['players']:
            print(f"Answer submitted by non-player {player_sid} in game {pin}")
            return

        # Check if it's the correct question and state
        if game['game_state'] != 'question' or game['current_question_index'] != q_index:
            print(f"Answer received too late or for wrong question from {player_sid} in game {pin}")
            emit('answer_error', {'message': 'Too late or wrong question!'})
            return

        # Check if player already answered this round
        if player_sid in game['answers_this_round']:
            print(f"Player {player_sid} already answered question {q_index} in game {pin}")
            emit('answer_error', {'message': 'You already answered!'})
            return

        # Record the answer
        game['answers_this_round'][player_sid] = answer_index
        nickname = game['players'][player_sid]['nickname']
        print(f"Player {nickname} ({player_sid}) in game {pin} answered question {q_index} with {answer_index}")

        # Acknowledge answer received
        emit('answer_received', {'question_index': q_index})

        # Optional: Notify host that an answer was received (e.g., update a counter)
        # host_sid = game['host_sid']
        # num_answered = len(game['answers_this_round'])
        # total_players = len(game['players'])
        # socketio.emit('update_answer_count', {'answered': num_answered, 'total': total_players}, room=host_sid)

        # Optional: If all players answered, automatically move to results
        # if len(game['answers_this_round']) == len(game['players']):
        #      handle_next_question({'pin': pin}) # Trigger result calculation immediately


# --- Run the App ---
if __name__ == '__main__':
    print("Starting Kahoot Clone Server...")
    # app.debug = True  # Enable Flask's debug pages
    # Run without the reloader explicitly
    socketio.run(app, host='0.0.0.0', port=8000, use_reloader=False)