var gameServer = {games: {}, gameCount: 0, recentGame: undefined};

var uuid = require('node-uuid');
var debugLib = require('debug');
var debug=debugLib('RaceMMO:gameServer');
var error=debugLib('RaceMMO:gameServer:error');
require('../shared/gameCore'); //Import Game Core


global.window = global.document = global;

//Initialize Server Vars
gameServer.fakeLag = 0;
gameServer.localTime = 0;
gameServer._dt = new Date().getTime(); //DeltaTime
gameServer._dte = new Date().getTime(); //Delta Time Elapsed
gameServer.messages = []; //Queue messages for faking latency

/**
 * Handle Updating Timing
 */
setInterval(function () {
  gameServer._dt = new Date().getTime() - gameServer._dte; //Update Time
  gameServer._dte = new Date().getTime(); //Make new delta
  gameServer.localTime += gameServer._dt / 1000.0; //Milliseconds to seconds
}, 4); //Update time 250 times per second

/**
 * Handle Messages from clients
 * @param client client sending message
 * @param message message from client
 */
gameServer.onMessage=function(client,message) {
  if(this.fakeLag&&message.split('.')[0].substr(0,1)=='i') { //If we are faking latency and it is a input message
    //Store input messages to emulate lag
    gameServer.messages.push({client: client, message: message});

    setTimeout(function() { //Go through latency queue, delayed
      if(gameServer.messages.length) {
        gameServer._onMessage(gameServer.messages[0].client, gameServer.messages[0].message);
        gameServer.messages.splice(0, 1);
      }
    }.bind(this),this.fakeLag);
  }
  else {
    gameServer._onMessage(client, message); //Handle messages regularly
  }
};

/**
 * Parse messages as they come in
 * @param client client sending message
 * @param message message
 * @private called through onMessage after evaluating if there is fake latency
 */
gameServer._onMessage=function(client,message) {
  var messageParts = message.split('.');
  var messageType = messageParts[0];
  //Parse Message Type
  switch (messageType) {
    case 'i': //Input
      this.onInput(client, messageParts);
      break;
    case 'p': //Ping
      client.send('s.p.' + messageParts[1]); //Send ping back so client latency can be calculated
      break;
    case 'c': //Color change
      client.game.gameCore.players[client.userID].color = messageParts[1];
      var players = client.game.gameCore.players;
      for(var key in players){ //Send all clients that a client changed color
        if(players.hasOwnProperty(key) && key!==client.userID){
          players[key].instance.send('s.pl.c.' + messageParts[1]+'.'+client.userID); //Send which client changed color as message part index 3
        }
      }
      break;
    case 'l': //Lag simulation request
      this.fakeLag = parseFloat(messageParts[1]); //Given in MS
      break;
  }
};

/**
 * Handle input from clients
 * @param client client sending input
 * @param parts arguments to input request
 */
gameServer.onInput=function(client,parts) {
  var commands = parts[1].split('-');
  var time = parts[2].replace('-', '.');
  var sequence = parts[3];

  //Tell game to handle input
  if(client&&client.game&&client.game.gameCore) {
    client.game.gameCore.handleServerInput(client, commands, time, sequence);
  }
};

/**
 * Create a new game
 * @param player host client
 */
gameServer.createGame=function(player) {
  var game = {
    id: uuid(),
    players: [],
    playerCount: 0,
    playerCapacity: 3
  };
  //game.playerCount++; //TODO figure out why this is called twice upon creation when this isnt commented
  this.games[game.id]=game; //Store game
  this.games.recentGame = game;
  this.gameCount++;

  //Create core instance for this game
  game.gameCore = new gameCore(game);
  game.gameCore.update(new Date().getTime()); //Start game loop

  this.joinGame(game, player);
  debug('player: ' + player.userID + ' created game with id ' + player.game.id);

  return game;
};

/**
 * Request to kill game
 * @param gameID game to kill
 * @param userID user requesting kill
 */
gameServer.endGame=function(gameID,userID) {
  var game = this.games[gameID];
  if(game) {
    game.gameCore.stopUpdate(); //Stop game updates
    for(var key in game.players){ //Notify all players in server the game has ended
      if(game.players.hasOwnProperty(key)){
        game.players[key].send('s.e'); //Notify client game has ended
        this.findGame(game.players[key]); //Look for/make a new game for that player
      }
    }
    delete this.games[gameID]; //Remove this game from the list of games
    this.gameCount--;
    debug('Game ended. Currently ' + this.gameCount + ' games.');
  }
  else{
    error('Client: ' + userID + ' tried ending Game: ' + gameID + ' that does not exist!');
  }
};

/**
 * Handle client disconnection
 * @param client client which disconnected
 */
gameServer.onDisconnect = function (client) {
  if (client.game && client.game.id) { //If the client was in a game, remove them from that game's instance and notify all other players in that game
    delete client.game.players[client.userID];
    client.game.playerCount--;
    client.game.gameCore.removePlayer(client);

    for(var player in client.game.players){
      if(client.game.players.hasOwnProperty(player)){
        client.game.players[player].send('s.pl.d.' + client.userID);
      }
    }

    if (client.game.playerCount <= 0) {
      this.endGame(client.game.id, client.userID);
      debug('Ended game ' + client.game.id);
    }
  }
};
/**
 * Find a game for given player
 * @param player player to find a slot for
 */
gameServer.findGame=function(player) {
  debug('Looking for game. Currently: ' + this.gameCount);
  if(this.gameCount) { //There are active games
    for(var gameID in this.games) { //Check for game with slots
      if(!this.games.hasOwnProperty(gameID)) continue;
      var instance = this.games[gameID];
      if(instance.playerCount<instance.playerCapacity) {
        this.joinGame(instance, player);
        return;
      }
    }
  }
  this.createGame(player); //No games with slots or no games exist, create a new one
};
/**
 * Add player to a game lobby
 * @param gameInstance instance of lobby
 * @param playerSocket socketIO instance of player
 */
gameServer.joinGame = function (gameInstance, playerSocket) {
  gameInstance.players[playerSocket.userID] = playerSocket;
  gameInstance.gameCore.createNewPlayer(playerSocket);
  gameInstance.playerCount++;

  //tell client he is joining a game
  playerSocket.send('s.y.j.' + gameInstance.id + "." + String(gameInstance.gameCore.localTime).replace('.', '-')); //Server You are Joining game [gameID] at time [gameTime]
  playerSocket.game = gameInstance;

  //Tell all clients in that game this player is joining & tell this player about all other clients
  for(var player in gameInstance.players){
    if(gameInstance.players.hasOwnProperty(player)&&gameInstance.players[playerSocket.userID]!==player){
      playerSocket.send('s.pl.j.' + player + "." +gameInstance.gameCore.players[player].color); //Tell current player that other clients exist
      gameInstance.players[player].send('s.pl.j.' + playerSocket.userID+"."+gameInstance.gameCore.players[playerSocket.userID].color); //Server Player is Joining with [playerID]
    }
  }
};

module.exports = gameServer;