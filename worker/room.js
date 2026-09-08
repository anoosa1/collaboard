/**
 * Room Durable Object
 * Manages WebSocket connections and drawing state for a single room
 */
export class Room {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.drawings = [];

        // Load persisted state
        this.state.blockConcurrencyWhile(async () => {
            const stored = await this.state.storage.get('drawings');
            if (stored) {
                this.drawings = stored;
            }
        });
    }

    async fetch(request) {
        // Handle WebSocket upgrade
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Generate a unique ID for this session
        const sessionId = crypto.randomUUID();

        // Accept the WebSocket with hibernation support
        this.state.acceptWebSocket(server, [sessionId]);

        // Get current connection count
        const sockets = this.state.getWebSockets();
        const userCount = sockets.length;

        // Send current state to new client (after accept)
        server.send(JSON.stringify({
            type: 'load-state',
            drawings: this.drawings,
            userCount: userCount
        }));

        // Notify others of new user
        this.broadcast({
            type: 'user-count',
            count: userCount
        }, server);

        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        try {
            const data = JSON.parse(message);
            const tags = this.state.getTags(ws);
            const sessionId = tags[0] || 'unknown';

            switch (data.type) {
                case 'draw':
                    // Validate action exists and has an expected type
                    if (!data.action || typeof data.action !== 'object') break;
                    const validDrawTypes = ['start', 'draw', 'end', 'shape', 'text', 'image'];
                    if (!validDrawTypes.includes(data.action.type)) break;

                    // Guard against oversized payloads (e.g. uncompressed images)
                    const actionStr = JSON.stringify(data.action);
                    if (actionStr.length > 900 * 1024) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Draw action too large to sync'
                        }));
                        break;
                    }
                    // Attach userId so clients can isolate per-user paths
                    const action = { ...data.action, userId: sessionId };
                    this.drawings.push(action);
                    // Persist on images, stroke ends, and every 10th action
                    if (action.type === 'image' || action.type === 'end' || action.type === 'shape' || action.type === 'text' || this.drawings.length % 10 === 0) {
                        await this.state.storage.put('drawings', this.drawings);
                    }
                    this.broadcast({ type: 'draw', action }, ws);
                    break;

                case 'cursor-move':
                    // Validate position has numeric coordinates
                    if (!data.position || typeof data.position.x !== 'number' || typeof data.position.y !== 'number') break;
                    this.broadcast({
                        type: 'cursor-move',
                        userId: sessionId,
                        position: { x: data.position.x, y: data.position.y }
                    }, ws);
                    break;

                case 'undo':
                    // User-scoped undo: find and remove the last stroke belonging to this user
                    if (this.drawings.length > 0) {
                        let removed = false;

                        // Search backwards for the last action by this user
                        for (let i = this.drawings.length - 1; i >= 0; i--) {
                            const item = this.drawings[i];
                            if (item.userId !== sessionId) continue;

                            if (item.type === 'end') {
                                // Remove only this user's stroke; other users may be interleaved.
                                this.drawings.splice(i, 1);
                                for (let j = i - 1; j >= 0; j--) {
                                    const action = this.drawings[j];
                                    if (action.userId !== sessionId) continue;
                                    this.drawings.splice(j, 1);
                                    if (action.type === 'start') break;
                                }
                                removed = true;
                                break;
                            } else if (item.type === 'shape' || item.type === 'text' || item.type === 'image') {
                                // Atomic action — just remove it
                                this.drawings.splice(i, 1);
                                removed = true;
                                break;
                            }
                            // Skip 'start' and 'draw' — they're part of an in-progress stroke
                        }

                        if (removed) {
                            await this.state.storage.put('drawings', this.drawings);
                            this.broadcastAll({
                                type: 'reload-state',
                                drawings: this.drawings
                            });
                        }
                    }
                    break;

                case 'clear':
                    this.drawings = [];
                    await this.state.storage.put('drawings', this.drawings);
                    this.broadcastAll({ type: 'clear' });
                    break;
            }
        } catch (e) {
            console.error('WebSocket message error:', e);
        }
    }

    async webSocketClose(ws, code, reason, wasClean) {
        // Close the socket explicitly so it's cleaned up
        try { ws.close(code, 'Durable Object is closing WebSocket'); } catch (e) { }

        // Get remaining connected WebSockets (exclude the one that just closed)
        const sockets = this.state.getWebSockets();
        const remaining = sockets.filter(s => s !== ws);
        const userCount = remaining.length;

        // Notify remaining users
        for (const socket of remaining) {
            try {
                socket.send(JSON.stringify({ type: 'user-count', count: userCount }));
            } catch (e) { }
        }

        // If room is empty, clear persisted state
        if (userCount === 0) {
            await this.state.storage.deleteAll();
            this.drawings = [];
        }
    }

    async webSocketError(ws, error) {
        console.error('WebSocket error:', error);
    }

    // Broadcast to all except sender
    broadcast(message, sender) {
        const sockets = this.state.getWebSockets();
        const msg = JSON.stringify(message);
        for (const socket of sockets) {
            if (socket !== sender) {
                try {
                    socket.send(msg);
                } catch (e) {
                    // Socket might be closed
                }
            }
        }
    }

    // Broadcast to all including sender
    broadcastAll(message) {
        const sockets = this.state.getWebSockets();
        const msg = JSON.stringify(message);
        for (const socket of sockets) {
            try {
                socket.send(msg);
            } catch (e) {
                // Socket might be closed
            }
        }
    }
}
