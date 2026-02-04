/**
 * Easy Connection - Relay Server
 * 
 * Servidor que actúa como intermediario para conexiones remotas.
 * Compatible con Render, Railway, Heroku, etc.
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Almacén de hosts esperando conexión: código -> ws
const waitingHosts = new Map();

// Sesiones activas: código -> { host: ws, client: ws }
const sessions = new Map();

// Crear servidor HTTP (necesario para Render)
const server = http.createServer((req, res) => {
    // Health check endpoint
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

// Crear servidor WebSocket sobre HTTP
const wss = new WebSocket.Server({ server });

console.log(`🚀 Easy Connection Relay Server iniciando en puerto ${PORT}...`);

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`📱 Nueva conexión desde ${ip}`);
    console.log(`📊 Estado actual: ${waitingHosts.size} hosts, ${sessions.size} sesiones`);
    
    ws.isAlive = true;
    ws.sessionCode = null;
    ws.role = null;
    
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`💓 Pong recibido de ${ws.deviceName || 'unknown'}`);
    });
    
    ws.on('message', (data) => {
        console.log(`📩 Raw data recibido: ${data.toString().substring(0, 200)}`);
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (e) {
            console.error('Error parsing:', e.message, 'Data:', data.toString());
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`👋 Conexión cerrada - Code: ${code}, Reason: ${reason}, Device: ${ws.deviceName || 'unknown'}, SessionCode: ${ws.sessionCode}`);
        handleDisconnect(ws);
        console.log(`📊 Después de desconexión: ${waitingHosts.size} hosts, ${sessions.size} sesiones`);
    });
    
    ws.on('error', (err) => {
        console.error('WS Error:', err.message, 'Device:', ws.deviceName || 'unknown');
    });
});

function handleMessage(ws, message) {
    console.log('📨 Mensaje:', message.type);
    
    switch (message.type) {
        case 'register_host':
            registerHost(ws, message);
            break;
        case 'connect_to_host':
            connectToHost(ws, message);
            break;
        case 'relay':
            relayData(ws, message);
            break;
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
    }
}

function registerHost(ws, message) {
    const { code, device_id, device_name } = message;
    
    console.log(`🔍 Intento de registro - Code: ${code}, Device: ${device_name}, DeviceID: ${device_id}`);
    
    if (!code || code.length !== 9) {
        console.log(`❌ Código inválido: "${code}" (longitud: ${code ? code.length : 0})`);
        ws.send(JSON.stringify({ type: 'error', message: 'Código inválido' }));
        return;
    }
    
    if (waitingHosts.has(code)) {
        console.log(`❌ Código ya en uso: ${code}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Código en uso' }));
        return;
    }
    
    ws.sessionCode = code;
    ws.role = 'host';
    ws.deviceId = device_id;
    ws.deviceName = device_name;
    
    waitingHosts.set(code, ws);
    
    console.log(`🏠 Host registrado EXITOSAMENTE: ${device_name} [${code}]`);
    console.log(`📊 Hosts activos ahora: ${waitingHosts.size}`);
    console.log(`📋 Lista de códigos: [${Array.from(waitingHosts.keys()).join(', ')}]`);
    
    ws.send(JSON.stringify({ type: 'registered', code }));
}

function connectToHost(ws, message) {
    const { code, device_id, device_name } = message;
    
    const hostWs = waitingHosts.get(code);
    
    if (!hostWs || hostWs.readyState !== WebSocket.OPEN) {
        console.log(`❌ Host no encontrado: ${code}`);
        ws.send(JSON.stringify({ 
            type: 'connection_failed', 
            reason: 'No se encontró ningún PC con ese código. Verifica que el código sea correcto y que el otro PC tenga el acceso activado.'
        }));
        return;
    }
    
    ws.sessionCode = code;
    ws.role = 'client';
    ws.deviceId = device_id;
    ws.deviceName = device_name;
    
    sessions.set(code, { host: hostWs, client: ws });
    waitingHosts.delete(code);
    
    console.log(`🔗 Conexión: ${device_name} -> ${hostWs.deviceName}`);
    
    // Notificar a ambos
    hostWs.send(JSON.stringify({
        type: 'peer_connected',
        peer_id: device_id,
        peer_name: device_name
    }));
    
    ws.send(JSON.stringify({
        type: 'connected_to_host',
        host_id: hostWs.deviceId,
        host_name: hostWs.deviceName
    }));
}

function relayData(ws, message) {
    const session = sessions.get(ws.sessionCode);
    if (!session) return;
    
    const target = ws.role === 'host' ? session.client : session.host;
    
    if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({
            type: 'relayed',
            from: ws.role,
            data: message.data
        }));
    }
}

function handleDisconnect(ws) {
    if (!ws.sessionCode) return;
    
    const code = ws.sessionCode;
    
    if (waitingHosts.get(code) === ws) {
        waitingHosts.delete(code);
        console.log(`🏠 Host removido: ${code}`);
        return;
    }
    
    const session = sessions.get(code);
    if (session) {
        const other = ws.role === 'host' ? session.client : session.host;
        if (other && other.readyState === WebSocket.OPEN) {
            other.send(JSON.stringify({ type: 'peer_disconnected' }));
        }
        sessions.delete(code);
        console.log(`🔌 Sesión terminada: ${code}`);
    }
}

// Ping para mantener conexiones vivas
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            handleDisconnect(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Stats cada minuto
setInterval(() => {
    console.log(`📊 Hosts: ${waitingHosts.size} | Sesiones: ${sessions.size} | Conexiones: ${wss.clients.size}`);
}, 60000);

wss.on('close', () => clearInterval(pingInterval));

// Iniciar servidor
server.listen(PORT, () => {
    console.log(`✅ Servidor listo en puerto ${PORT}`);
});
