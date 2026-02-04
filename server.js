/**
 * Easy Connection - Relay Server
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const waitingHosts = new Map();
const sessions = new Map();

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            service: 'Easy Connection Relay',
            hosts: waitingHosts.size,
            sessions: sessions.size
        }));
        return;
    }
    res.writeHead(404);
    res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

console.log(`🚀 Servidor iniciando en puerto ${PORT}...`);

wss.on('connection', (ws) => {
    console.log('📱 Nueva conexión');
    ws.isAlive = true;
    ws.sessionCode = null;
    ws.role = null;
    
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'register_host') {
                const { code, device_id, device_name } = msg;
                if (waitingHosts.has(code)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Código en uso' }));
                    return;
                }
                ws.sessionCode = code;
                ws.role = 'host';
                ws.deviceId = device_id;
                ws.deviceName = device_name;
                waitingHosts.set(code, ws);
                console.log(`🏠 Host: ${device_name} [${code}]`);
                ws.send(JSON.stringify({ type: 'registered', code }));
            } else if (msg.type === 'connect_to_host') {
                const { code, device_id, device_name } = msg;
                const hostWs = waitingHosts.get(code);
                if (!hostWs || hostWs.readyState !== WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'connection_failed', reason: 'No se encontró PC con ese código' }));
                    return;
                }
                ws.sessionCode = code;
                ws.role = 'client';
                ws.deviceId = device_id;
                ws.deviceName = device_name;
                sessions.set(code, { host: hostWs, client: ws });
                waitingHosts.delete(code);
                console.log(`🔗 ${device_name} -> ${hostWs.deviceName}`);
                hostWs.send(JSON.stringify({ type: 'peer_connected', peer_id: device_id, peer_name: device_name }));
                ws.send(JSON.stringify({ type: 'connected_to_host', host_id: hostWs.deviceId, host_name: hostWs.deviceName }));
            } else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) { console.error(e); }
    });
    
    ws.on('close', () => {
        if (ws.sessionCode) {
            if (waitingHosts.get(ws.sessionCode) === ws) {
                waitingHosts.delete(ws.sessionCode);
            }
            const session = sessions.get(ws.sessionCode);
            if (session) {
                const other = ws.role === 'host' ? session.client : session.host;
                if (other?.readyState === WebSocket.OPEN) {
                    other.send(JSON.stringify({ type: 'peer_disconnected' }));
                }
                sessions.delete(ws.sessionCode);
            }
        }
    });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(PORT, () => console.log(`✅ Puerto ${PORT} listo`));
