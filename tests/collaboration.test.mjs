import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../worker/room.js';
import { Canvas } from '../src/canvas.js';
import { WebSocketClient } from '../src/websocket.js';

test('undo preserves interleaved actions from other collaborators', async () => {
    const room = Object.create(Room.prototype);
    const peerStroke = [
        { type: 'start', userId: 'peer' },
        { type: 'draw', userId: 'peer' },
        { type: 'end', userId: 'peer' },
    ];
    room.drawings = [
        { type: 'start', userId: 'me' }, peerStroke[0],
        { type: 'draw', userId: 'me' }, peerStroke[1], peerStroke[2],
        { type: 'end', userId: 'me' },
    ];
    let stored;
    let broadcast;
    room.state = { getTags: () => ['me'], storage: { put: async (_, value) => { stored = value; } } };
    room.broadcastAll = message => { broadcast = message; };
    await room.webSocketMessage({}, JSON.stringify({ type: 'undo' }));
    assert.deepEqual(room.drawings, peerStroke);
    assert.deepEqual(stored, peerStroke);
    assert.deepEqual(broadcast.drawings, peerStroke);
});

test('reconnecting to an empty room replaces stale local drawings', () => {
    let drawings;
    const client = Object.create(WebSocketClient.prototype);
    client.handlers = { onReloadState: value => { drawings = value; }, onUserCount: () => {} };
    client.handleMessage({ type: 'load-state', drawings: [], userCount: 1 });
    assert.deepEqual(drawings, []);
});

for (const method of ['zoomIn', 'zoomOut']) {
    test(`${method} keeps the viewport center fixed with an offset toolbar`, () => {
        const canvas = Object.create(Canvas.prototype);
        canvas.scale = 1;
        canvas.offsetX = -500;
        canvas.offsetY = -400;
        canvas.canvas = { parentElement: { getBoundingClientRect: () => ({ left: 200, top: 64, width: 800, height: 600 }) } };
        canvas.updateCanvasTransform = () => {};
        const before = [(400 - canvas.offsetX) / canvas.scale, (300 - canvas.offsetY) / canvas.scale];
        canvas[method]();
        assert.deepEqual([(400 - canvas.offsetX) / canvas.scale, (300 - canvas.offsetY) / canvas.scale], before);
    });
}

test('a local pencil segment starts its own path after a remote stroke', () => {
    const canvas = Object.create(Canvas.prototype);
    const calls = [];
    canvas.ctx = Object.fromEntries(['beginPath', 'moveTo', 'lineTo', 'stroke'].map(name => [name, (...args) => calls.push([name, ...args])]));
    Object.assign(canvas, { isDrawing: true, currentTool: 'pencil', size: 5, color: '#000000', lastDrawX: 10, lastDrawY: 20, drawingActions: [] });
    canvas.socket = { emitCursorMove() {}, emitDraw() {} };
    canvas.getCanvasCoords = () => ({ x: 30, y: 40 });
    canvas.handleMouseMove({ clientX: 30, clientY: 40 });
    assert.deepEqual(calls, [['beginPath'], ['moveTo', 10, 20], ['lineTo', 30, 40], ['stroke']]);
});
