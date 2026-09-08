/**
 * WebSocket client wrapper for Cloudflare Workers backend
 */
export class WebSocketClient {
    constructor(roomId, handlers) {
        this.roomId = roomId;
        this.handlers = handlers;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;

        this.connect();
    }

    connect() {
        // Determine WebSocket URL based on environment
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const wsUrl = `${protocol}//${host}/ws/${this.roomId}`;

        console.log('Connecting to:', wsUrl);
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            if (this.handlers.onConnectionChange) {
                this.handlers.onConnectionChange('connected');
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        };

        this.ws.onclose = (event) => {
            console.log('WebSocket closed:', event.code, event.reason);
            if (this.handlers.onConnectionChange) {
                this.handlers.onConnectionChange('disconnected');
            }
            this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Reconnecting... attempt ${this.reconnectAttempts}`);
            if (this.handlers.onConnectionChange) {
                this.handlers.onConnectionChange('connecting');
            }
            setTimeout(() => this.connect(), this.reconnectDelay * this.reconnectAttempts);
        }
    }

    handleMessage(data) {
        switch (data.type) {
            case 'load-state':
                // Initial state load — use sequential replay for correct image z-order
                if (Array.isArray(data.drawings)) {
                    this.handlers.onReloadState(data.drawings);
                }
                if (data.userCount) {
                    this.handlers.onUserCount(data.userCount);
                }
                break;

            case 'draw':
                this.handlers.onDraw(data.action);
                break;

            case 'cursor-move':
                this.handlers.onCursorMove(data);
                break;

            case 'user-count':
                this.handlers.onUserCount(data.count);
                break;

            case 'reload-state':
                this.handlers.onReloadState(data.drawings);
                break;

            case 'clear':
                this.handlers.onClear();
                break;
        }
    }

    send(type, payload = {}) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, ...payload }));
        }
    }

    emitDraw(action) {
        this.send('draw', { action });
    }

    emitCursorMove(position) {
        // Throttle to 20 updates/sec max to avoid flooding
        const now = Date.now();
        if (this._lastCursorEmit && now - this._lastCursorEmit < 50) return;
        this._lastCursorEmit = now;
        this.send('cursor-move', { position });
    }

    emitUndo() {
        this.send('undo');
    }

    emitClear() {
        this.send('clear');
    }
}
